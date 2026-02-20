import { test, expect } from "@playwright/test";

test.describe("OpenMeet OAuth Callback", () => {
  const validParams = new URLSearchParams({
    token: "test-access-token",
    refreshToken: "test-refresh-token",
    tokenExpires: String(Date.now() + 3_600_000),
    profile: btoa(
      JSON.stringify({
        did: "did:plc:test123",
        handle: "testuser.bsky.social",
        displayName: "Test User",
      }),
    ),
  });

  test("stores tokens in localStorage and redirects on valid callback", async ({
    page,
  }) => {
    await page.goto(`/openmeet/callback?${validParams.toString()}`);

    // Wait for the redirect to complete (callback navigates to /home)
    await page.waitForURL("**/home", { timeout: 15000 });

    // Verify tokens were stored in localStorage
    const stored = await page.evaluate(() => ({
      accessToken: localStorage.getItem("openmeet:accessToken"),
      refreshToken: localStorage.getItem("openmeet:refreshToken"),
      tokenExpires: localStorage.getItem("openmeet:tokenExpires"),
      profile: localStorage.getItem("openmeet:profile"),
    }));

    expect(stored.accessToken).toBe("test-access-token");
    expect(stored.refreshToken).toBe("test-refresh-token");
    expect(stored.tokenExpires).toBeTruthy();
    expect(stored.profile).toContain("testuser.bsky.social");
  });

  test("shows error when required params are missing", async ({ page }) => {
    // Navigate with no token params
    await page.goto("/openmeet/callback");
    await page.waitForLoadState("domcontentloaded");

    // Should display the error message
    await expect(
      page.getByText("Missing authentication parameters"),
    ).toBeVisible({ timeout: 10000 });

    // Should show a Go Home link
    await expect(page.getByRole("link", { name: "Go Home" })).toBeVisible();
  });

  test("redirects to stored return URL after callback", async ({ page }) => {
    // Pre-set a return URL before the callback
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => {
      localStorage.setItem("openmeet:returnUrl", "/some-space/calendar");
    });

    await page.goto(`/openmeet/callback?${validParams.toString()}`);

    // Should redirect to the stored return URL, not /home
    await page.waitForURL("**/some-space/calendar", { timeout: 15000 });
  });

  test("handles invalid profile gracefully", async ({ page }) => {
    const paramsWithBadProfile = new URLSearchParams({
      token: "tok",
      refreshToken: "ref",
      tokenExpires: String(Date.now() + 3_600_000),
      profile: "!!!not-valid-base64!!!",
    });

    await page.goto(
      `/openmeet/callback?${paramsWithBadProfile.toString()}`,
    );
    await page.waitForURL("**/home", { timeout: 15000 });

    // Tokens should be stored even though profile was invalid
    const stored = await page.evaluate(() => ({
      accessToken: localStorage.getItem("openmeet:accessToken"),
      profile: localStorage.getItem("openmeet:profile"),
    }));

    expect(stored.accessToken).toBe("tok");
    // Profile should be null because the base64 was invalid
    expect(stored.profile).toBeNull();
  });
});
