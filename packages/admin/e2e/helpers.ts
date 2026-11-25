// Shared by the end-to-end tests (D-073, D-081): the seed serve.mjs wrote,
// Siteimprove Alfa's rules on the page as it is, signing in a person who has
// not set up two-step sign-in yet, and collecting script errors and CSP
// refusals.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Audit, Outcome } from "@siteimprove/alfa-act";
import { Playwright } from "@siteimprove/alfa-playwright";
import rules from "@siteimprove/alfa-rules";
import { expect, type Page } from "@playwright/test";
import { decodeBase32, totpAt } from "@oculus/core";

export interface Seed {
  readonly email: string;
  readonly editorEmail: string;
  /** The system manager (T-048a's System settings). */
  readonly rootEmail: string;
  readonly organizationName: string;
  readonly password: string;
  readonly siteName: string;
  readonly recordTitle: string;
}

export function seed(): Seed {
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
export async function accessible(page: Page, screen: string): Promise<void> {
  const handle = await page.evaluateHandle(() => window.document);
  const alfaPage = await Playwright.toPage(handle);
  const outcomes = await Audit.of(alfaPage, IN_SCOPE).evaluate();
  const failed = [...outcomes].filter((o) => Outcome.isFailed(o)).map((o) => o.rule.uri);
  expect(failed, `Alfa on ${screen}`).toEqual([]);
}

/** Script errors and CSP refusals on the page (a 401 before signing in is expected). */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text());
    }
  });
  return errors;
}

/**
 * Signs in a person who hasn't set up two-step sign-in, sets it up with a
 * code computed from the key on the page, and continues past the recovery
 * codes, by keyboard. Runs Alfa on each screen when `check` is set.
 */
export async function signInAndSetUp(
  page: Page,
  email: string,
  password: string,
  check = false,
  /** For someone who chooses an organization with the code (a system manager with no membership). */
  organization?: string,
): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  if (check) await accessible(page, "Sign in");
  await page.getByLabel("Email").focus();
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(password);
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Set up two-step sign-in" })).toBeVisible();
  if (check) await accessible(page, "Set up two-step sign-in");
  await page.getByRole("button", { name: "Start setting up" }).press("Enter");

  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  if (check) await accessible(page, "Scan the code");
  const key = (await page.locator("code").first().textContent()) ?? "";
  const secret = decodeBase32(key.replace(/\s+/g, ""));
  if (secret === undefined) throw new Error("the key on the page isn't base32");
  await page.getByLabel("6-digit code from the app").focus();
  await page.keyboard.type(totpAt(secret, Math.floor(Date.now() / 1000)));
  await page.keyboard.press("Enter");
  if (organization !== undefined) {
    await page.getByRole("radio", { name: organization }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Confirm" }).press("Enter");
  }

  const codes = page.getByRole("list", { name: "Recovery codes" });
  await expect(codes.getByRole("listitem")).toHaveCount(10);
  if (check) await accessible(page, "Recovery codes");
  await page.getByRole("checkbox", { name: /I have saved these codes/ }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Continue to Oculus" }).press("Enter");
}

/**
 * The first admin's unused recovery codes, kept beside the seed by the test
 * that set up its two-step sign-in (people.spec.ts), so a later test can
 * sign the same account in (there is only one system manager, D-019).
 */
function rootCodesFile(): string {
  const file = process.env.OCULUS_E2E_SEED;
  if (file === undefined) throw new Error("OCULUS_E2E_SEED is not set");
  return `${file}.root-recovery.json`;
}

export function saveRootRecoveryCodes(codes: readonly string[]): void {
  writeFileSync(rootCodesFile(), JSON.stringify(codes));
}

/**
 * Signs in the first admin: with a saved recovery code if its two-step
 * sign-in is set up already, else by setting it up. Chooses the
 * organization when asked (a system manager with no membership).
 */
export async function signInRoot(page: Page): Promise<void> {
  const { rootEmail, password, organizationName } = seed();
  const file = rootCodesFile();
  const codes = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : [];
  const code = codes.shift();
  if (code === undefined) {
    await signInAndSetUp(page, rootEmail, password, false, organizationName);
    return;
  }
  saveRootRecoveryCodes(codes);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(rootEmail);
  await page.getByLabel("Password").fill(password);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  const choice = page.getByRole("radio", { name: organizationName });
  await choice.waitFor();
  await choice.focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Continue" }).click();
}
