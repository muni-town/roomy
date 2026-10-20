/**
 * Space administration: what an admin changes about a space, and what the
 * readers of those changes then see.
 *
 * Every surface here is a write plus the read that consumes it, because the
 * two are separate code paths and only the pair proves the change was stored
 * rather than left in the form:
 *
 * - the settings form writes through `updateSpaceInfo` and re-reads through
 *   `getMetadata`, which is what makes a reload change anything;
 * - leaving writes a membership edge the space switcher and user settings
 *   read, and rejoining writes it back;
 * - a channel's access is written as the channel's own default access, and the
 *   member's sidebar is the reader — `getMetadata` drops a channel the caller
 *   cannot read;
 * - a role's grant is what carries that read to a member with no members-wide
 *   access, so a member without the role is the control.
 *
 * The write is counted at the wire (`space.sendEvents`) as well as read back
 * through the UI, so a form that only updates its own local state fails here
 * rather than passing on the same page it was changed on. Each count is
 * asserted after a UI consequence of the write has settled, so the count is
 * read after the request it is about exists.
 *
 * The spaces are seeded ones, and a write lands inside the space it is about
 * — the spaces other specs assert on are not touched. Where a caller other
 * than the seeded user has to be the one asking, `X-Test-Did` is re-pointed at
 * the edge for the whole page, so every read and write that page makes is
 * made as that caller.
 */

import { type Page } from "@playwright/test";
import { expect, installTestAuth, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  OTHER_USER_DID,
  OTHER_USER_DISPLAY_NAME,
  OTHER_USER_HANDLE,
  SEED_ADMIN_SPACE_DESCRIPTION,
  SEED_ADMIN_SPACE_ID,
  SEED_OPEN_SPACE_ID,
  SEED_OPEN_SPACE_NAME,
  SEED_OPEN_SPACE_ROOM_PATH,
  SEED_SPACE_NAME,
  TEST_BANNABLE_DID,
  TEST_BANNABLE_HANDLE,
  TEST_NON_MEMBER_DID,
  TEST_USER_DID,
} from "./fixtures.ts";

/** The one write path every space and room mutation batches into. */
const SEND_EVENTS_PATH = "/xrpc/space.roomy.space.sendEvents";
const LEAVE_SPACE_PATH = "/xrpc/space.roomy.space.leaveSpace";
const JOIN_SPACE_PATH = "/xrpc/space.roomy.space.joinSpace";

/**
 * The name the settings tests rename the admin space to. Not a fixture: they
 * are the only reader of that space's name.
 */
const RENAMED_SPACE_NAME = "E2E Admin Space (renamed)";
const REWRITTEN_SPACE_DESCRIPTION =
  "Description rewritten by the space-administration spec.";

/** Count requests to one XRPC path for as long as the page lives. */
function countRequests(page: Page, path: string) {
  const counts = { n: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(path)) counts.n += 1;
  });
  return counts;
}

/**
 * Point the page's appserver requests at `did` instead of the seeded user.
 *
 * Registered after the fixture's catch-all, so this handler runs first and its
 * header is the one the appserver sees. Only the appserver's answer changes:
 * the client keeps its own session, so `auth.userDid` is still the seeded user
 * and any UI gated on the *client's* own identity renders as theirs. Every
 * check below reads a permission the appserver decides, which is why this is
 * enough.
 */
async function authenticateAs(page: Page, did: string): Promise<void> {
  await page.route(`${APPSERVER_HTTP_ORIGIN}/**`, async (route) => {
    await route.continue({
      headers: { ...route.request().headers(), "X-Test-Did": did },
    });
  });
}

/** The space switcher's entry for a space, keyed by the title it sets. */
function switcherEntry(page: Page, spaceName: string) {
  return page.locator(`.space-switcher button[title="${spaceName}"]`);
}

/** The sidebar's link to a channel. */
function channelLink(page: Page, path: string) {
  return page.locator(`a[href="${path}"]`);
}

/**
 * The list row a section renders a labelled thing in, keyed by its label.
 * Rows are `<li>`s in the member and role lists and `<div>`s elsewhere, so
 * the nearest either-or ancestor is what a per-row action lives in.
 */
function rowFor(page: Page, text: string) {
  return page.locator(
    `xpath=//span[normalize-space(text())="${text}"]/ancestor::*[self::div or self::li][1]`,
  );
}

/** The members page's list row for one member, keyed by their profile link. */
function memberRow(page: Page, did: string) {
  return page.locator(`li:has(a[href="/user/${did}"])`);
}

/**
 * User settings' Left Spaces row for one space.
 *
 * Scoped to that section: the space switcher also renders the space's name in
 * a row of its own, and a page-wide match would keep resolving after the
 * space has been rejoined.
 */
function leftSpaceRow(page: Page, spaceName: string) {
  return page.locator(
    `xpath=//section[h2[normalize-space(text())="Left Spaces"]]//span[normalize-space(text())="${spaceName}"]/ancestor::div[1]`,
  );
}

/** One of the settings form's `ToggleGroup` options, and its `<input>`. */
function policyOption(
  page: Page,
  name: string,
  value: "yes" | "no" | "readwrite" | "read" | "none",
) {
  const input = page.locator(`input[name="${name}"][value="${value}"]`);
  return {
    input,
    /**
     * Press the option. `ToggleGroup` hides the radio and puts the choice on
     * the label, so the label is what a user presses.
     */
    press: async () => {
      await page
        .locator(`label:has(input[name="${name}"][value="${value}"])`)
        .click();
      await expect(input).toBeChecked();
    },
  };
}

/** Open a space's settings form and wait for the metadata that fills it. */
async function openSpaceSettings(page: Page, spaceId: string): Promise<void> {
  await page.goto(`/${spaceId}/settings`);
  await waitForAuthenticated(page);
  // The effect that seeds the form is the one that fills the name, so a
  // non-empty name is the metadata arriving rather than a blank first paint.
  await expect(page.locator("input#space-name")).not.toHaveValue("");
}

/** Press the settings form's Save and wait for it to settle on the stored row. */
async function saveSpaceSettings(page: Page): Promise<void> {
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.click();
  // The label reads "Saving…" while the write is in flight, and Save disables
  // again only once the write's invalidation has refetched the metadata and
  // the stored row matches the form — so this is the point the write is on the
  // server and the reload below reads it rather than racing it.
  await expect(save).toBeDisabled();
}

/**
 * Open a channel's edit modal from the room navbar and wait for it to read
 * the channel back.
 */
async function openRoomAccess(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForAuthenticated(page);
  await page.getByRole("button", { name: "Room settings" }).click();
  // The title is the room's kind, which resolves only once `room.getMetadata`
  // has answered — the same answer the access toggles are filled from.
  await expect(page.locator("#dialog-title")).toHaveText("Edit Channel");
}

/** Save the open edit modal and wait for the write to have closed it. */
async function saveRoomAccess(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#dialog-title")).toBeHidden();
}

/**
 * Load the app once before the first assertion.
 *
 * The first page load of a run pays the dev server's cold transform of the
 * client, the appserver's first materialisation and the stub PDS's first login
 * at once, which can outlast the shell's own budget. Paying it here keeps the
 * per-test waits about the app rather than about the machine.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await installTestAuth(page);
  await page.goto(`/${SEED_ADMIN_SPACE_ID}/settings`);
  await waitForAuthenticated(page, 120_000);
  await page.close();
});

test.describe("space settings", () => {
  test("the name saved in the form is the name the space metadata reads back", async ({
    page,
  }: {
    page: Page;
  }) => {
    const writes = countRequests(page, SEND_EVENTS_PATH);
    await openSpaceSettings(page, SEED_ADMIN_SPACE_ID);

    const name = page.locator("input#space-name");
    const stored = await name.inputValue();
    expect(stored).not.toBe("");
    // A CI retry reuses the appserver and therefore the previous attempt's
    // name, so the target is whichever one is not stored.
    const target =
      stored === RENAMED_SPACE_NAME ? "E2E Admin Space" : RENAMED_SPACE_NAME;

    const before = writes.n;
    await name.fill(target);
    await saveSpaceSettings(page);
    // A name is a write: nothing but `space.sendEvents` can put it in the
    // space's stream.
    expect(writes.n).toBe(before + 1);

    // The reader is a fresh load of the same route, so the value has to have
    // come from the store rather than from the form's own state.
    await openSpaceSettings(page, SEED_ADMIN_SPACE_ID);
    await expect(page.locator("input#space-name")).toHaveValue(target);
    // The switcher is a second reader of the same row.
    await expect(switcherEntry(page, target)).toBeVisible();
  });

  test("the description saved in the form is the description the space metadata reads back", async ({
    page,
  }: {
    page: Page;
  }) => {
    const writes = countRequests(page, SEND_EVENTS_PATH);
    await openSpaceSettings(page, SEED_ADMIN_SPACE_ID);

    const description = page.locator("textarea#space-description");
    const stored = await description.inputValue();
    const target =
      stored === REWRITTEN_SPACE_DESCRIPTION
        ? SEED_ADMIN_SPACE_DESCRIPTION
        : REWRITTEN_SPACE_DESCRIPTION;

    const before = writes.n;
    await description.fill(target);
    await saveSpaceSettings(page);
    expect(writes.n).toBe(before + 1);

    await openSpaceSettings(page, SEED_ADMIN_SPACE_ID);
    await expect(page.locator("textarea#space-description")).toHaveValue(target);
  });

  test("a flipped join policy is stored, and the form reads the stored policy back", async ({
    page,
  }: {
    page: Page;
  }) => {
    const writes = countRequests(page, SEND_EVENTS_PATH);
    await openSpaceSettings(page, SEED_ADMIN_SPACE_ID);

    // The seed stores invite-only, so the first (unretried) press opens the
    // space. An earlier run may have left the other side, so the side to flip
    // to is the one the form is not on, and the space is put back to the
    // seeded side at the end.
    const startOpen = await policyOption(
      page,
      "allowPublicJoin",
      "yes",
    ).input.isChecked();
    const targetValue = startOpen ? "no" : "yes";

    const before = writes.n;
    await policyOption(page, "allowPublicJoin", targetValue).press();
    await saveSpaceSettings(page);
    // The public-join policy is stored on the space row, written only through
    // this batch.
    expect(writes.n).toBe(before + 1);

    await openSpaceSettings(page, SEED_ADMIN_SPACE_ID);
    await expect(
      policyOption(page, "allowPublicJoin", targetValue).input,
    ).toBeChecked();
    await expect(
      policyOption(page, "allowPublicJoin", targetValue === "yes" ? "no" : "yes")
        .input,
    ).not.toBeChecked();

    if (targetValue === "yes") {
      // Leave the seeded side in place so the run is repeatable.
      await policyOption(page, "allowPublicJoin", "no").press();
      await saveSpaceSettings(page);
      expect(writes.n).toBe(before + 2);
    }
  });

  test("the invite policy field reads the stored policy, not the toggle's default", async ({
    page,
  }: {
    page: Page;
  }) => {
    // Read-only: no write is made here, and the form is on a space whose
    // invite policy the seed turned on. The toggle's own default is off, so
    // the field being on is the stored policy arriving through the metadata.
    await openSpaceSettings(page, SEED_ADMIN_SPACE_ID);
    await expect(
      page.locator('input[name="allowPublicJoin"][value="no"]'),
    ).toBeChecked();
    await expect(
      policyOption(page, "allowMemberInvites", "yes").input,
    ).toBeChecked();
    await expect(
      policyOption(page, "allowMemberInvites", "no").input,
    ).not.toBeChecked();
  });
});

test.describe("leaving a space", () => {
  test("leaving takes the space out of the switcher and lists it under Left Spaces", async ({
    page,
  }: {
    page: Page;
  }) => {
    const leaves = countRequests(page, LEAVE_SPACE_PATH);
    await openSpaceSettings(page, SEED_OPEN_SPACE_ID);
    await expect(switcherEntry(page, SEED_OPEN_SPACE_NAME)).toBeVisible();
    // Another joined space, so the absence asserted below is this space
    // leaving rather than the switcher failing to render.
    await expect(switcherEntry(page, SEED_SPACE_NAME)).toBeVisible();

    const before = leaves.n;
    await page.getByRole("button", { name: "Leave Space" }).click();
    // Leaving lands on the space index, and the switcher it rebuilds from
    // `getSpaces` no longer carries a space the caller is not a member of.
    await expect(page).toHaveURL("/");
    expect(leaves.n).toBe(before + 1);
    await expect(switcherEntry(page, SEED_OPEN_SPACE_NAME)).toHaveCount(0);
    await expect(switcherEntry(page, SEED_SPACE_NAME)).toBeVisible();

    // User settings reads the same list for its left spaces, which is the
    // membership state surviving somewhere other than the switcher's cache.
    await page.goto("/user/settings");
    await waitForAuthenticated(page);
    await expect(leftSpaceRow(page, SEED_OPEN_SPACE_NAME)).toBeVisible();
  });
});

test.describe("rejoining a space", () => {
  test("rejoining from Left Spaces puts the space back in the switcher", async ({
    page,
  }: {
    page: Page;
  }) => {
    const joins = countRequests(page, JOIN_SPACE_PATH);
    await page.goto("/user/settings");
    await waitForAuthenticated(page);

    // The left space the previous test leaves behind. Failing here is that
    // test's failure showing up, not a second finding.
    const row = leftSpaceRow(page, SEED_OPEN_SPACE_NAME);
    await expect(row).toBeVisible();

    const before = joins.n;
    await row.getByRole("button", { name: "Rejoin" }).click();
    // The row goes once the join's invalidation has refetched `getSpaces`,
    // which is the membership edge read the switcher reads too.
    await expect(row).toHaveCount(0);
    expect(joins.n).toBe(before + 1);

    await page.goto("/");
    await waitForAuthenticated(page);
    await expect(switcherEntry(page, SEED_OPEN_SPACE_NAME)).toBeVisible();
    await expect(switcherEntry(page, SEED_SPACE_NAME)).toBeVisible();
  });
});

test.describe("space members", () => {
  test("a ban marks the member as banned in the members list, and an unban clears it", async ({
    page,
  }: {
    page: Page;
  }) => {
    // The seeded user is this space's admin and stays the client's own
    // identity, which is what the members page gates the actions menu on. The
    // member under test is the one seeded to be moderated.
    const writes = countRequests(page, SEND_EVENTS_PATH);
    // The ban confirms through a native dialog, which Playwright dismisses by
    // default — a dismissal would cancel the ban this test is about.
    page.on("dialog", (dialog) => void dialog.accept());

    await page.goto(`/${SEED_OPEN_SPACE_ID}/settings/members`);
    await waitForAuthenticated(page);

    const row = memberRow(page, TEST_BANNABLE_DID);
    await expect(row).toContainText(TEST_BANNABLE_HANDLE);
    const bannedBadge = row.getByText("banned", { exact: true });

    // A run that died between the ban and the unban leaves the row banned, so
    // the starting state is normalised rather than assumed.
    if (await bannedBadge.isVisible()) {
      await row.getByRole("button", { name: "Member actions" }).click();
      await page.getByText("Unban Member", { exact: true }).click();
      await expect(bannedBadge).toHaveCount(0);
    }

    const before = writes.n;
    await row.getByRole("button", { name: "Member actions" }).click();
    await page.getByText("Ban Member", { exact: true }).click();
    // The badge is the row `getMembers` rebuilds from the ban event, so it is
    // the write landing; the count below is what says the write was a batch.
    await expect(bannedBadge).toBeVisible();
    expect(writes.n).toBe(before + 1);
    // The member is still listed: a ban is a moderation state, not a removal.
    await expect(row).toContainText(TEST_BANNABLE_HANDLE);

    await row.getByRole("button", { name: "Member actions" }).click();
    await page.getByText("Unban Member", { exact: true }).click();
    await expect(bannedBadge).toHaveCount(0);
    expect(writes.n).toBe(before + 2);
  });
});

test.describe("a channel's members access", () => {
  test("restricting a channel's Members to none is what takes it out of a role-less member's sidebar", async ({
    page,
  }: {
    page: Page;
  }) => {
    // The admin's read of the channel's Members setting, which is the
    // channel's default access. An admin override keeps the channel readable
    // for the caller whatever it holds.
    await authenticateAs(page, TEST_USER_DID);
    await openRoomAccess(page, SEED_OPEN_SPACE_ROOM_PATH);
    const membersWide = await policyOption(
      page,
      "members-permission",
      "readwrite",
    ).input.isChecked();

    // The control: while Members holds Read & Write, the same role-less
    // member this test denies below reads the channel. The read after the
    // write is by that same caller, so the difference between the two is the
    // write rather than the two callers.
    if (membersWide) {
      await authenticateAs(page, TEST_NON_MEMBER_DID);
      await page.goto(SEED_OPEN_SPACE_ROOM_PATH);
      await waitForAuthenticated(page);
      await expect(switcherEntry(page, SEED_OPEN_SPACE_NAME)).toBeVisible();
      await expect(channelLink(page, SEED_OPEN_SPACE_ROOM_PATH).first()).toBeVisible();
    }

    if (membersWide) {
      await authenticateAs(page, TEST_USER_DID);
      const writes = countRequests(page, SEND_EVENTS_PATH);
      await openRoomAccess(page, SEED_OPEN_SPACE_ROOM_PATH);
      const before = writes.n;
      await policyOption(page, "members-permission", "none").press();
      await saveRoomAccess(page);
      // A room save puts more than one batch on the wire — the permission
      // events, then the room update that always carries the name. What is
      // asserted here is that the press wrote at all; the read-backs below are
      // what say which write landed.
      expect(writes.n).toBeGreaterThan(before);
    }

    // The read-back: reopening the modal fills the toggle from the stored row.
    await authenticateAs(page, TEST_USER_DID);
    await openRoomAccess(page, SEED_OPEN_SPACE_ROOM_PATH);
    await expect(
      policyOption(page, "members-permission", "none").input,
    ).toBeChecked();
    await expect(
      policyOption(page, "members-permission", "readwrite").input,
    ).not.toBeChecked();

    // The member's read. `getMetadata` drops a channel the caller cannot read,
    // so the sidebar is where a restriction shows up, and the room route stays
    // reachable as a URL — the deny is the channel missing from the switcher's
    // neighbour, not the page failing to render.
    await authenticateAs(page, TEST_NON_MEMBER_DID);
    await page.goto(SEED_OPEN_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(switcherEntry(page, SEED_OPEN_SPACE_NAME)).toBeVisible();
    await expect(channelLink(page, SEED_OPEN_SPACE_ROOM_PATH)).toHaveCount(0);
  });
});

test.describe("a role's grant on a channel", () => {
  test("granting a role Read on a restricted channel is what lets its holder read it", async ({
    page,
  }: {
    page: Page;
  }) => {
    // The admin's page, which is also the page the invalidation signals for
    // both the role and the grant land on.
    const roleName = `E2E Channel Reader ${Date.now()}`;

    // A role on the open space, through the real create path, so its id is the
    // one the appserver handed out rather than one this test invents.
    await page.goto(`/${SEED_OPEN_SPACE_ID}/settings/permissions`);
    await waitForAuthenticated(page);
    await page.getByRole("button", { name: "Create role" }).click();
    await page.getByPlaceholder("Role name").fill(roleName);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    // The role list is `getRoles` rebuilt after the create, so a new row here
    // is the role existing on the server.
    await rowFor(page, roleName).click();

    // The assignment, searched by handle and pressed by the name the row
    // renders — the search and the row are the two halves of the same member.
    await page.getByPlaceholder("Add member...").fill(OTHER_USER_HANDLE);
    await page
      .getByRole("button")
      .filter({ hasText: OTHER_USER_DISPLAY_NAME })
      .first()
      .click();
    // The role's member list, which is `getRoles` again — this time carrying
    // the assignment as the appserver stored it.
    await expect(rowFor(page, OTHER_USER_DISPLAY_NAME)).toBeVisible();

    const writes = countRequests(page, SEND_EVENTS_PATH);
    await openRoomAccess(page, SEED_OPEN_SPACE_ROOM_PATH);
    // Role rows render only below a members-wide access that is not Read &
    // Write, so Members is on None first: the channel is restricted for
    // everyone, which is what leaves the grant below as the only way in.
    await policyOption(page, "members-permission", "none").press();
    // The role row is only rendered once the modal's own `getRoles` has
    // answered, so its toggle is the role id the appserver gave the role.
    const roleRow = rowFor(page, roleName);
    await expect(roleRow).toBeVisible();
    const before = writes.n;
    await roleRow.locator('label:has(input[value="read"])').click();
    await saveRoomAccess(page);
    // As above: a room save is more than one batch, so the assertion is that
    // the press wrote, and the read-backs that follow say what it wrote.
    expect(writes.n).toBeGreaterThan(before);

    // The read-back: the grant is a row on the role, and a fresh load of the
    // modal fills the role's toggle from it.
    await openRoomAccess(page, SEED_OPEN_SPACE_ROOM_PATH);
    await expect(
      rowFor(page, roleName).locator('input[value="read"]'),
    ).toBeChecked();

    // The member holding the role reads the channel in their sidebar; the
    // member without it does not, which is what makes the grant the cause of
    // the difference rather than the space changing under both of them.
    await authenticateAs(page, OTHER_USER_DID);
    await page.goto(SEED_OPEN_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(switcherEntry(page, SEED_OPEN_SPACE_NAME)).toBeVisible();
    await expect(channelLink(page, SEED_OPEN_SPACE_ROOM_PATH).first()).toBeVisible();

    await authenticateAs(page, TEST_NON_MEMBER_DID);
    await page.goto(SEED_OPEN_SPACE_ROOM_PATH);
    await waitForAuthenticated(page);
    await expect(switcherEntry(page, SEED_OPEN_SPACE_NAME)).toBeVisible();
    await expect(channelLink(page, SEED_OPEN_SPACE_ROOM_PATH)).toHaveCount(0);
  });
});
