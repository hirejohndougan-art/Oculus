// Sign in, set up two-step sign-in, reach the only site, sign out (T-045),
// in a real browser against the built admin served by Fastify, with
// Siteimprove Alfa's accessibility rules checked on each screen (D-073).
import { readFileSync } from "node:fs";
import { Audit, Outcome } from "@siteimprove/alfa-act";
import { Playwright } from "@siteimprove/alfa-playwright";
import rules from "@siteimprove/alfa-rules";
import { expect, test, type Page } from "@playwright/test";
import { decodeBase32, totpAt } from "@oculus/core";

interface Seed {
  readonly email: string;
  readonly password: string;
  readonly siteName: string;
}

function seed(): Seed {
  const file = process.env.OCULUS_E2E_SEED;
  if (file === undefined) throw new Error("OCULUS_E2E_SEED is not set");
  return JSON.parse(readFileSync(file, "utf8")) as Seed;
}

/**
 * The WCAG levels a rule's success criteria are at (`["AAA"]` for enhanced
 * contrast), or none for a rule that maps only to techniques and best
 * practices (a skip link first, say).
 */
function criterionLevels(rule: typeof rules extends Iterable<infer R> ? R : never): string[] {
  const levels: string[] = [];
  for (const requirement of rule.requirements) {
    if (requirement.toJSON().type !== "criterion") continue;
    const level: unknown = JSON.parse(
      JSON.stringify((requirement as unknown as { level?: unknown }).level ?? null),
    );
    if (!Array.isArray(level)) continue;
    for (const entry of level) {
      if (Array.isArray(entry) && typeof entry[0] === "string") levels.push(entry[0]);
    }
  }
  return levels;
}

/**
 * The rules checked: every Alfa rule except those whose success criteria are
 * all at level AAA (enhanced contrast 1.4.6, visual presentation 1.4.8,
 * target size 2.5.5 and the like). Oculus aims at WCAG 2.1 AA (T-045);
 * techniques and best practices stay in.
 */
const IN_SCOPE = [...rules].filter((rule) => {
  const levels = criterionLevels(rule);
  return levels.length === 0 || levels.some((l) => l === "A" || l === "AA");
});

/** Runs Alfa's rules on the page as it is now; fails with the failed rules' addresses. */
async function accessible(page: Page, screen: string): Promise<void> {
  const handle = await page.evaluateHandle(() => window.document);
  const alfaPage = await Playwright.toPage(handle);
  const outcomes = await Audit.of(alfaPage, IN_SCOPE).evaluate();
  const failed = [...outcomes].filter((o) => Outcome.isFailed(o)).map((o) => o.rule.uri);
  expect(failed, `Alfa on ${screen}`).toEqual([]);
}

test("sign in, set up two-step sign-in, open the only site and sign out", async ({ page }) => {
  const { email, password, siteName } = seed();
  const errors: string[] = [];
  // Script errors and CSP refusals; a 401 from GET /api/me before signing in is expected.
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text());
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await accessible(page, "Sign in");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Set up two-step sign-in" })).toBeVisible();
  await accessible(page, "Set up two-step sign-in");
  await page.getByRole("button", { name: "Start setting up" }).click();

  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  await accessible(page, "Scan the code");
  const key = (await page.locator("code").first().textContent()) ?? "";
  const secret = decodeBase32(key.replace(/\s+/g, ""));
  if (secret === undefined) throw new Error("the key on the page isn't base32");
  await page
    .getByLabel("6-digit code from the app")
    .fill(totpAt(secret, Math.floor(Date.now() / 1000)));
  await page.getByRole("button", { name: "Confirm" }).click();

  const codes = page.getByRole("list", { name: "Recovery codes" });
  await expect(codes.getByRole("listitem")).toHaveCount(10);
  await accessible(page, "Recovery codes");
  await page.getByText("I have saved these codes somewhere safe").click();
  await page.getByRole("button", { name: "Continue to Oculus" }).click();

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
