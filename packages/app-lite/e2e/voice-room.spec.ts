/**
 * Voice room rendering, with no LiveKit deployment and no media.
 *
 * The appserver in the E2E stack has no `LIVEKIT_*` env, so it is in exactly
 * the state the degraded path exists for: every voice RPC answers empty or
 * null. These tests pin what the client does in that state — it renders the
 * voice room, and it fabricates no call state it cannot have.
 *
 * The media path itself (WebRTC, E2EE, capture) has no automated coverage:
 * there is no SFU in CI and no browser microphone. `VoiceCallState` is
 * covered against a mocked `livekit-client` in `src/lib/voice`, which is what
 * those unit tests are for; see `docs/plans/voice-chat-plan.md` §6.3–6.4.
 */

import { composer, expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import type { Page } from "@playwright/test";
import {
  APPSERVER_HTTP_ORIGIN,
  SEED_ROOM_PATH,
  SEED_SPACE_ID,
  SEED_VOICE_ROOM_NAME,
  SEED_VOICE_ROOM_PATH,
  TEST_USER_DID,
} from "./fixtures.ts";

/** Serve `getFlags` with `voice-chat` removed, before navigation. */
async function withoutVoiceFlag(page: Page): Promise<void> {
  // The real flag body is read once, up front, through the test-mode verifier
  // (the `X-Test-Did` header the base fixture injects cannot be relied on from
  // inside a route handler). Re-fetching per request would race the app's own
  // aborted/repeated `getFlags` calls; a fixed body fulfils every one of them.
  const res = await page.request.get(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.getFlags`,
    { headers: { "X-Test-Did": TEST_USER_DID } },
  );
  const { flags = [] } = (await res.json()) as { flags?: string[] };
  const body = { flags: flags.filter((f) => f !== "voice-chat") };
  await page.route(
    `${APPSERVER_HTTP_ORIGIN}/xrpc/space.roomy.getFlags*`,
    (route) => route.fulfill({ json: body }),
  );
}

test.describe("voice room", () => {
  test("the sidebar lists the voice room under its own heading", async ({ page }) => {
    // Straight to the space: the space's own index route mounts the sidebar,
    // so the test does not depend on the home page's space switcher.
    await page.goto(`/${SEED_SPACE_ID}`);
    await waitForAuthenticated(page);


    // The voice room is not a category child, so it appears under the
    // sidebar's "Voice" heading rather than in the channel tree.
    await expect(page.getByText("Voice", { exact: true })).toBeVisible();

    const voiceLink = page.locator(`a[href="${SEED_VOICE_ROOM_PATH}"]`);
    await expect(voiceLink).toBeVisible();
    await expect(voiceLink).toContainText(SEED_VOICE_ROOM_NAME);
    // The room carries the voice icon, not the channel hashtag — that is what
    // distinguishes a voice room at a glance in the sidebar.
    await expect(voiceLink.getByLabel("Voice room")).toBeVisible();
  });

  test("opening a voice room renders the call panel, not a message timeline", async ({
    page,
  }) => {
    await page.goto(SEED_VOICE_ROOM_PATH);
    await waitForAuthenticated(page);

    await expect(page.getByRole("heading", { name: "Voice room" })).toBeVisible();
    await expect(page.getByText("No one is in the call right now.")).toBeVisible();

    // No composer: a voice room has no timeline to post to.
    await expect(page.getByRole("textbox")).toHaveCount(0);
  });

  test("an unconfigured deployment reports no call rather than a broken one", async ({
    page,
  }) => {
    await page.goto(SEED_VOICE_ROOM_PATH);
    await waitForAuthenticated(page);

    await expect(page.getByRole("heading", { name: "Voice room" })).toBeVisible();
    // The appserver has no LiveKit configured, so `getToken` answers all-null
    // and `getParticipants` answers empty. Nothing connected, so no
    // participant list is rendered and no connection error is reported: the
    // client's degraded path is an absence, not a failure.
    await expect(page.getByText("In this call")).toHaveCount(0);
    await expect(page.getByText(/could not be reached|not supported here/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Join call" })).toBeVisible();
  });

  test("flag off: the voice room is neither listed nor given a call surface", async ({
    page,
  }) => {
    await withoutVoiceFlag(page);

    // Direct navigation. The room's kind is on the wire and cannot be
    // unlearned, but the flag keeps it from becoming a call surface — which
    // is a derived value, not a mount-order race, so this is deterministic
    // however the flag body and the room metadata interleave.
    await page.goto(SEED_VOICE_ROOM_PATH);
    await waitForAuthenticated(page);

    // The room renders as the ordinary room it is: its timeline and composer,
    // no call panel — the exact inverse of the flag-on assertions above.
    await expect(composer(page)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Voice room" }),
    ).toHaveCount(0);

    // The sidebar lists this space's channels and no voice section at all:
    // the channel tree is the proof the sidebar rendered, so the absences
    // below are the flag's doing rather than a failed load.
    await expect(
      page.locator(`.sidebar-body-wrap a[href="${SEED_ROOM_PATH}"]`).first(),
    ).toBeVisible();
    await expect(page.getByText("Voice", { exact: true })).toHaveCount(0);
    await expect(page.locator(`a[href="${SEED_VOICE_ROOM_PATH}"]`)).toHaveCount(0);
  });
});
