/**
 * Profile & identity — the account surfaces: a profile page, editing your own,
 * mentioning someone in the composer, and the user menu.
 *
 * This is the coverage plan's area E. The assertions are on the *rendered
 * identity* — the display name and handle the page resolved — never merely that
 * the route resolved, because an unresolved profile still renders a page.
 *
 * Two of these cover write paths, and both are deliberately break-checked (see
 * the coverage plan's evidence list):
 *
 *   - a saved profile is a `space.roomy.user.profile/self` record in the user's
 *     own repo, so the reload assertion can only pass if the client really
 *     wrote it and the appserver really read it back;
 *   - an inserted mention is a `#didMention` facet in the message body, so the
 *     post-reload assertion can only pass if the facet survived being written,
 *     materialised and read back — the label alone would render as plain text.
 *
 * The identity the fixtures seed is the only identity a spec can assert on, so
 * the second account (`OTHER_USER_DID`, the third space's admin) is used where
 * a *different* profile has to be distinguishable from the signed-in one.
 */

import type { Locator, Page } from "@playwright/test";
import { newUlid } from "@roomy-space/sdk";
import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import {
  APPSERVER_HTTP_ORIGIN,
  OTHER_USER_DID,
  OTHER_USER_DISPLAY_NAME,
  OTHER_USER_HANDLE,
  PDS_ORIGIN,
  SEED_SPACE_3_ID,
  SEED_SPACE_3_MESSAGE_TEXT,
  SEED_SPACE_3_ROOM_ID,
  SEED_SPACE_3_ROOM_PATH,
  TEST_USER_DID,
  TEST_USER_DISPLAY_NAME,
  TEST_USER_HANDLE,
} from "./fixtures.ts";

const PROFILE_COLLECTION = "space.roomy.user.profile";
/** A Roomy profile is one record per user, so the rkey is fixed. */
const PROFILE_RKEY = "self";
const SEND_EVENTS_PATH = "/xrpc/space.roomy.space.sendEvents";

/** A body unique to this run, so an assertion cannot match an earlier one. */
function uniqueText(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}`;
}

/**
 * The identity a profile page renders for `did`.
 *
 * The display name is the page's `h1`; the handle is the link to the actor's
 * AT-URI, which is the only place the handle appears as a link. Both are read
 * from the profile query, so an empty or failed query fails here rather than
 * leaving the route merely "resolved".
 */
function profileIdentity(page: Page, displayName: string, handle: string, did: string) {
  return {
    name: page.getByRole("heading", { level: 1, name: displayName }),
    handle: page.locator(`a[href="https://aturi.to/${did}"]`).filter({ hasText: `@${handle}` }),
  };
}

/** The profile page's own readiness gate: the identity it resolved. */
async function waitForProfile(
  page: Page,
  displayName: string,
  handle: string,
  did: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitForAuthenticated(page);
  const identity = profileIdentity(page, displayName, handle, did);
  await expect(identity.name).toBeVisible({ timeout: timeoutMs });
  await expect(identity.handle).toBeVisible({ timeout: timeoutMs });
}

/** Open a room and wait until its composer is live. */
async function openRoom(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(composer(page)).toBeVisible({ timeout: 45_000 });
}

/**
 * The `@user` suggestion list the editor mounts beside itself.
 *
 * TipTap's suggestion renderer appends it to the editor's parent (`#chat-input`),
 * so it is addressed through the composer rather than by role — it has no
 * accessible name of its own.
 */
function mentionList(page: Page): Locator {
  return page.locator("#chat-input ul");
}

/** Open the user menu and return it. */
async function openUserMenu(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "User menu" }).click();
  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  return menu;
}

/** The profile record the user's own repo holds, as any client would read it. */
async function readProfileRecord(
  page: Page,
  repo: string,
): Promise<Record<string, unknown> | null> {
  const url = new URL(`${PDS_ORIGIN}/xrpc/com.atproto.repo.listRecords`);
  url.searchParams.set("repo", repo);
  url.searchParams.set("collection", PROFILE_COLLECTION);
  const resp = await page.request.get(url.toString());
  expect(resp.ok()).toBe(true);
  const body = (await resp.json()) as {
    records: { uri: string; value: Record<string, unknown> }[];
  };
  return body.records[0]?.value ?? null;
}

/**
 * Save the profile form and wait for the page to leave edit mode.
 *
 * The name is passed rather than read back off the form: the assertion that
 * follows is about what the profile *now renders*, and waiting for the editor
 * to close is what says the save round-tripped.
 */
async function saveDisplayName(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Edit profile" }).click();
  const field = page.locator("#edit-displayName");
  await expect(field).toBeVisible();
  await field.fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("a profile page", () => {
  test("renders the signed-in user's own name and handle, and offers Edit", async ({
    page,
  }) => {
    await page.goto(`/user/${TEST_USER_DID}`);
    await waitForProfile(page, TEST_USER_DISPLAY_NAME, TEST_USER_HANDLE, TEST_USER_DID);

    // Own profile: the edit affordance is the page's acknowledgement that the
    // resolved DID is the caller's.
    await expect(page.getByRole("button", { name: "Edit profile" })).toBeVisible();
    // And no block action — you cannot block yourself.
    await expect(page.getByRole("button", { name: "Block this user" })).toHaveCount(0);
  });

  test("renders another account's name and handle, which are that account's and not the viewer's", async ({
    page,
  }) => {
    await page.goto(`/user/${OTHER_USER_DID}`);
    await waitForProfile(page, OTHER_USER_DISPLAY_NAME, OTHER_USER_HANDLE, OTHER_USER_DID);

    // The identity rendered is the *other* account's, so neither string can be
    // the signed-in user's rendered in its place.
    expect(OTHER_USER_DISPLAY_NAME).not.toBe(TEST_USER_DISPLAY_NAME);
    expect(OTHER_USER_HANDLE).not.toBe(TEST_USER_HANDLE);

    // Not own profile: the edit affordance is absent, and the block action is
    // offered in its place.
    await expect(page.getByRole("button", { name: "Edit profile" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Block this user" })).toBeVisible();
  });
});

test.describe("editing your own profile", () => {
  test("a saved display name is written to the user's repo, and is what the page renders after a reload", async ({
    page,
  }) => {
    await page.goto(`/user/${TEST_USER_DID}`);
    await waitForProfile(page, TEST_USER_DISPLAY_NAME, TEST_USER_HANDLE, TEST_USER_DID);

    const edited = uniqueText("E2E Tester edited");
    try {
      await saveDisplayName(page, edited);

      // The record is in the user's OWN repo. Nothing else in this app writes a
      // `space.roomy.user.profile/self` record, so a listed record with the
      // saved name cannot be anything but this save.
      //
      // Read first, assert on the string: this is the part of the test that
      // says the write happened, and it must not be skipped by an affordance
      // assertion failing ahead of it.
      expect((await readProfileRecord(page, TEST_USER_DID))?.["displayName"]).toBe(
        edited,
      );

      // Reload: the client's cache is gone, so the name on screen can only come
      // from the appserver reading that record back.
      await page.reload();
      await waitForProfile(page, edited, TEST_USER_HANDLE, TEST_USER_DID);
      expect(
        (await readProfileRecord(page, TEST_USER_DID))?.["displayName"],
      ).toBe(edited);
    } finally {
      // The seeded name is asserted by the rest of the suite (the sidebar user
      // card is the authenticated-shell gate), so the profile is put back the
      // same way it was changed.
      await saveDisplayName(page, TEST_USER_DISPLAY_NAME).catch(() => {});
    }
  });
});

test.describe("mentioning someone in the composer", () => {
  test("the typeahead offers the room's other author once '@' is typed", async ({
    page,
  }) => {
    await openRoom(page, SEED_SPACE_3_ROOM_PATH);
    // The empty-query list is built from the room's own timeline, so the
    // message it is built from has to be on screen first.
    await expect(page.getByText(SEED_SPACE_3_MESSAGE_TEXT)).toBeVisible();

    const input = composer(page);
    await input.click();
    await input.pressSequentially("@");

    const list = mentionList(page);
    await expect(list).toBeVisible();
    await expect(list).toContainText(OTHER_USER_HANDLE);
    // The room has exactly one other author, and it is not the sender: a list
    // that offered the viewer would also "contain" a handle here.
    await expect(list.getByRole("button")).toHaveCount(1);
  });

  test("the typeahead searches the space's members for what is typed after '@'", async ({
    page,
  }) => {
    await openRoom(page, SEED_SPACE_3_ROOM_PATH);

    const searches: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("space.roomy.space.getMembers")) {
        searches.push(url.searchParams.get("search") ?? "");
      }
    });

    const input = composer(page);
    await input.click();
    await input.pressSequentially("@e2e.other");

    const list = mentionList(page);
    await expect(list).toBeVisible();
    await expect(list).toContainText(OTHER_USER_HANDLE);
    // The row came from the server search for the typed text, not from a
    // locally filtered list.
    expect(searches).toContain("e2e.other");
  });

  test("an inserted mention renders as a link to the mentioned account, and survives a reload", async ({
    page,
  }) => {
    await openRoom(page, SEED_SPACE_3_ROOM_PATH);
    await expect(page.getByText(SEED_SPACE_3_MESSAGE_TEXT)).toBeVisible();

    const input = composer(page);
    await input.click();
    await input.pressSequentially("@e2e.other");
    const list = mentionList(page);
    await expect(list).toContainText(OTHER_USER_HANDLE);
    await list.getByRole("button").first().click();

    // The editor holds a mention node, not the typed text: it renders as an
    // anchor to the mentioned DID and is atomic (contenteditable="false").
    await expect(input.locator(`a[href="/user/${OTHER_USER_DID}"]`)).toBeVisible();

    const body = uniqueText("mentioning someone");
    await input.pressSequentially(` ${body}`);
    const send = page.getByTestId("send-message-button");
    await expect(send).toBeVisible();
    await send.click();
    await expect(composer(page)).toHaveText("");

    const row = page.locator("[data-message-id]").filter({ hasText: body });
    await expect(row).toHaveCount(1);
    // Rendered from the facet the composer produced: the anchor, not the label.
    await expect(row.locator(`a[href="/user/${OTHER_USER_DID}"]`)).toBeVisible();

    const messageId = await row.getAttribute("data-message-id");
    if (!messageId) throw new Error("the sent row carries no data-message-id");

    try {
      // After a reload only the appserver can supply the row, so the anchor
      // proves the `#didMention` facet was written, materialised and read back —
      // the label on its own would render as plain text.
      await page.reload();
      await expect(composer(page)).toBeVisible({ timeout: 45_000 });
      const reloaded = page.locator(`[data-message-id="${messageId}"]`);
      await expect(reloaded).toContainText(body);
      await expect(reloaded.locator(`a[href="/user/${OTHER_USER_DID}"]`)).toBeVisible();
    } finally {
      // The third space's room is shared with the rest of the suite, so the
      // message this test posted is removed again. Best-effort: this is
      // hygiene, not the assertion under test.
      await fetch(`${APPSERVER_HTTP_ORIGIN}${SEND_EVENTS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Test-Did": TEST_USER_DID },
        body: JSON.stringify({
          spaceId: SEED_SPACE_3_ID,
          events: [
            {
              id: newUlid(),
              room: SEED_SPACE_3_ROOM_ID,
              $type: "space.roomy.message.deleteMessage.v0",
              messageId,
            },
          ],
        }),
      }).catch(() => {});
    }
  });
});

test.describe("the user menu", () => {
  test("the theme action cycles the mode and re-applies the choice after a reload", async ({
    page,
  }) => {
    await openRoom(page, SEED_SPACE_3_ROOM_PATH);
    const mode = () =>
      page.evaluate(() => ({
        stored: localStorage.getItem("darkMode"),
        dark: document.documentElement.classList.contains("dark"),
      }));
    // A fresh context: no stored choice, so the app follows the OS (light in
    // the Chromium project).
    expect(await mode()).toEqual({ stored: null, dark: false });

    // light → dark
    let menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: "System Mode" }).click();
    expect(await mode()).toEqual({ stored: '"light"', dark: false });

    // dark → system
    menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: "Light Mode" }).click();
    expect(await mode()).toEqual({ stored: '"dark"', dark: true });

    // system → light
    menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: "Dark Mode" }).click();
    expect(await mode()).toEqual({ stored: '"system"', dark: false });

    // The choice is persisted, so the next document applies it before the app
    // boots (the inline script in `app.html`) rather than flashing the default.
    menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: "System Mode" }).click();
    await page.reload();
    expect(await mode()).toEqual({ stored: '"light"', dark: false });
  });

  test("Settings opens the user settings page", async ({ page }) => {
    await openRoom(page, SEED_SPACE_3_ROOM_PATH);
    const menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: "Settings" }).click();

    await expect(page).toHaveURL(/\/user\/settings$/);
    await expect(page.getByRole("button", { name: "Toggle theme" })).toBeVisible();
  });

  test("Log Out ends the session, reloads, and signs back in", async ({ page }) => {
    // A per-document marker: `logout()` ends the session by reloading into a
    // document with none, so a changed marker is what proves the reload
    // happened rather than the app merely flipping its own flags.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__documentMarker = Math.random();
    });
    // The session lifecycle, by URL: the PDS is what answers `createSession`
    // and is asked to `deleteSession`, so recording those two calls is the
    // record of the sign-out and of the sign-in that followed it. Every
    // assertion below reads these arrays live rather than once at the end:
    // each line is a different observation, and a `createSession` still in
    // flight when one of them is made is not a failure of the one after it.
    const deleted: string[] = [];
    const created: string[] = [];
    page.on("request", (request) => {
      const path = request.url().split("?")[0] ?? "";
      if (path.endsWith("deleteSession")) deleted.push(path);
      if (path.endsWith("createSession")) created.push(path);
    });

    await page.goto(SEED_SPACE_3_ROOM_PATH);
    await waitForAuthenticated(page);
    const before = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__documentMarker,
    );
    deleted.length = 0;
    created.length = 0;

    const menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: "Log Out" }).click();

    // The old session is revoked exactly once — the record of the sign-out.
    await expect
      .poll(() => deleted.length, {
        timeout: 30_000,
        message: "logout should revoke the session at the PDS",
      })
      .toBe(1);

    // And the page comes back signed in. The marker is set by an init script,
    // i.e. at document creation, so it changes before the login that document
    // runs has necessarily finished — the shell is what says that login
    // resolved. (The read can land while the reload is still committing, when
    // the evaluation's execution context is destroyed; `null` means "keep
    // waiting", the same allowance `session-expiry.spec.ts` makes.)
    await expect
      .poll(
        async () => {
          try {
            return await page.evaluate(
              () => (window as unknown as Record<string, unknown>).__documentMarker,
            );
          } catch {
            return null;
          }
        },
        { timeout: 30_000, message: "the document after logout should be a new one" },
      )
      .not.toBe(before);
    await waitForAuthenticated(page, 30_000);

    // Which — because the test-mode login is the real `AtpAgent` path against
    // the stub PDS — means a fresh session was created for the new document.
    expect(created.length).toBeGreaterThan(0);
    expect(deleted).toHaveLength(1);
  });
});
