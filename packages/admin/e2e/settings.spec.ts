// System settings (T-048a) in a real browser against the built admin and a
// throwaway database, by keyboard: the system manager signs in, opens System
// settings from the sidebar, adds a site, opens the templates and one
// template's fields, and the sign-in rules. Siteimprove Alfa's rules run on
// each screen; no CSP refusal or script error may happen on the way.
import { expect, test, type Page } from "@playwright/test";
import { accessible, collectErrors, seed, signInAndSetUp } from "./helpers";

async function press(page: Page, name: string, role: "button" | "link" = "button") {
  const control = page.getByRole(role, { name, exact: true });
  if (role === "button") await expect(control).toBeEnabled();
  await control.focus();
  await page.keyboard.press("Enter");
}

test("a system manager adds a site and reads the templates and the sign-in rules", async ({
  page,
}) => {
  const { rootEmail, password, siteName, organizationName } = seed();
  const errors = collectErrors(page);
  await signInAndSetUp(page, rootEmail, password, false, organizationName);
  await expect(page.getByRole("heading", { level: 1, name: siteName })).toBeVisible();

  // Sites.
  await press(page, "System settings", "link");
  await expect(page.getByRole("heading", { level: 1, name: "System settings" })).toBeVisible();
  await expect(page.getByRole("cell", { name: siteName, exact: true })).toBeVisible();
  await accessible(page, "System settings: Sites");
  await page.getByLabel("Site name").focus();
  await page.keyboard.type("Invented reading room");
  await press(page, "Add site");
  await expect(page.getByText("Added the site “Invented reading room”")).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Invented reading room", exact: true }),
  ).toBeVisible();
  await accessible(page, "System settings: a site added");

  // Templates, and one template's fields.
  await press(page, "Templates", "link");
  await expect(page.getByRole("heading", { name: /^Templates of / })).toBeVisible();
  await accessible(page, "System settings: Templates");
  await page.getByRole("table").getByRole("link").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list", { name: "Fields" })).toBeVisible();
  await accessible(page, "System settings: a template");

  // The sign-in rules.
  await press(page, "Sign-in rules", "link");
  await expect(page.getByLabel("Sign out after this many minutes unused")).toHaveValue("240");
  await accessible(page, "System settings: Sign-in rules");

  expect(errors).toEqual([]);
});
