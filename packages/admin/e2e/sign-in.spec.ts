// Sign in, set up two-step sign-in, reach the only site, sign out (T-045),
// in a real browser against the built admin served by Fastify, with
// Siteimprove Alfa's accessibility rules checked on each screen (D-073).
import { expect, test } from "@playwright/test";
import { accessible, collectErrors, seed, signInAndSetUp } from "./helpers";

test("sign in, set up two-step sign-in, open the only site and sign out", async ({ page }) => {
  const { email, password, siteName } = seed();
  // Script errors and CSP refusals; a 401 from GET /api/me before signing in is expected.
  const errors = collectErrors(page);
  await signInAndSetUp(page, email, password, true);

  // One site: straight to it (D-019).
  await expect(page.getByRole("heading", { level: 1, name: siteName })).toBeVisible();
  await expect(page).toHaveURL(/\/sites\/[0-9a-f-]{36}$/);
  await accessible(page, "Site home");

  // Keyboard: the account menu opens and signs out.
  await page.getByRole("button", { name: /^Account:/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByText("You are signed out.")).toBeVisible();

  // Signed out for real: the frame sends us back to sign in.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();

  // No CSP violations or script errors on the way.
  expect(errors).toEqual([]);
});

test("the Forgot-your-password screen says the same thing for any address", async ({ page }) => {
  await page.goto("/forgot");
  await expect(
    page.getByRole("heading", { level: 1, name: "Choose a new password" }),
  ).toBeVisible();
  await accessible(page, "Forgot your password");
  await page.getByLabel("Email").fill("nobody@example.org");
  await page.getByRole("button", { name: "Send the link" }).click();
  await expect(page.getByRole("alert")).toContainText("If that address belongs to an account");
});
