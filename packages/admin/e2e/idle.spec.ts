// Signing out after a period of no use (T-062, D-098) in a real browser
// against the built admin and a throwaway database, by keyboard only. The
// page's clock is Playwright's fake clock, so the 30-minute limit passes in
// moments (the server's clock is real: the session is still alive there
// until the admin signs it out). The warning appears with focus on "Stay
// signed in", Siteimprove Alfa's rules run on it, Enter keeps the session
// and gives focus back; left alone again, the admin signs out on the server
// and shows the sign-in screen with the reason, and the session really has
// ended. No CSP refusal or script error may happen on the way.
import { expect, test } from "@playwright/test";
import { accessible, collectErrors, seed, signInAndSetUp } from "./helpers";

test("an unused session is warned, kept by keyboard, then signed out with the reason", async ({
  page,
}) => {
  const { idleEmail, password, siteName } = seed();
  const errors = collectErrors(page);
  await page.clock.install();
  await signInAndSetUp(page, idleEmail, password);
  await expect(page.getByRole("heading", { level: 1, name: siteName })).toBeVisible();
  const records = page.getByRole("link", { name: "Item records" });
  await records.focus();

  // 29 minutes (and a few seconds for the replies after the visit's use).
  await page.clock.fastForward("29:05");
  const warning = page.getByRole("alertdialog", { name: "Are you still there?" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/You.ll be signed out in \d+ seconds/);
  const stay = warning.getByRole("button", { name: "Stay signed in" });
  await expect(stay).toBeFocused();
  await accessible(page, "The idle warning");

  // Stay signed in, by keyboard: the warning goes and focus comes back.
  await page.keyboard.press("Enter");
  await expect(warning).toBeHidden();
  await expect(records).toBeFocused();

  // Left alone again: the warning, then signed out at the end.
  await page.clock.fastForward("29:05");
  await expect(warning).toBeVisible();
  await page.clock.fastForward("01:00");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(
    page.getByText("You were signed out because Oculus wasn't used for 30 minutes."),
  ).toBeVisible();
  await accessible(page, "Signed out for no use");

  // Ended on the server too: opening the admin asks to sign in.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();

  expect(errors).toEqual([]);
});
