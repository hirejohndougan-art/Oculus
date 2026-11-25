// People, roles and the audit trail (T-048), keyboard only, in a real
// browser against the built admin served by Fastify: the system manager
// signs in and sets up two-step sign-in, invites someone, gives the
// helper a role, resets the helper's two-step sign-in (with the
// admin's own recovery code), sees D-078's warning before a reset link,
// and reads the audit trail. Siteimprove Alfa's rules run on every screen.
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { Audit, Outcome } from "@siteimprove/alfa-act";
import { Playwright } from "@siteimprove/alfa-playwright";
import rules from "@siteimprove/alfa-rules";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { saveRootRecoveryCodes } from "./helpers";
import { decodeBase32, totpAt } from "@oculus/core";

interface Seed {
  readonly password: string;
  readonly siteName: string;
  readonly rootEmail: string;
  readonly organizationName: string;
  readonly helperName: string;
}

function seed(): Seed {
  const file = process.env.OCULUS_E2E_SEED;
  if (file === undefined) throw new Error("OCULUS_E2E_SEED is not set");
  return JSON.parse(readFileSync(file, "utf8")) as Seed;
}

/** As sign-in.spec.ts: every Alfa rule but those whose criteria are all at level AAA. */
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

const IN_SCOPE = [...rules].filter((rule) => {
  const levels = criterionLevels(rule);
  return levels.length === 0 || levels.some((l) => l === "A" || l === "AA");
});

/** Screenshots for review, when OCULUS_E2E_SHOTS names a folder. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.OCULUS_E2E_SHOTS;
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function accessible(page: Page, screen: string): Promise<void> {
  const handle = await page.evaluateHandle(() => window.document);
  const alfaPage = await Playwright.toPage(handle);
  const outcomes = await Audit.of(alfaPage, IN_SCOPE).evaluate();
  const failed = [...outcomes].filter((o) => Outcome.isFailed(o)).map((o) => o.rule.uri);
  expect(failed, `Alfa on ${screen}`).toEqual([]);
  await shot(page, screen.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
}

/** Keyboard only: focus the control, then press a key (Enter on links and buttons). */
async function press(target: Locator, key = "Enter"): Promise<void> {
  await target.focus();
  await target.page().keyboard.press(key);
}

async function typeInto(target: Locator, text: string): Promise<void> {
  await target.focus();
  await target.page().keyboard.type(text);
}

test("a system manager invites, grants a role, resets two-step sign-in and reads the audit trail", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { password, rootEmail, organizationName, helperName } = seed();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      errors.push(message.text());
    }
  });

  // Sign in and set up two-step sign-in, keeping the recovery codes.
  await page.goto("/");
  await typeInto(page.getByLabel("Email"), rootEmail);
  await typeInto(page.getByLabel("Password"), password);
  await press(page.getByRole("button", { name: "Sign in" }));
  await press(page.getByRole("button", { name: "Start setting up" }));
  const key = (await page.locator("code").first().textContent()) ?? "";
  const secret = decodeBase32(key.replace(/\s+/g, ""));
  if (secret === undefined) throw new Error("the key on the page isn't base32");
  const code = totpAt(secret, Math.floor(Date.now() / 1000));
  await typeInto(page.getByLabel("6-digit code from the app"), code);
  await press(page.getByRole("button", { name: "Confirm" }));
  // A system manager with no membership chooses the organization first.
  const choice = page.getByRole("radio", { name: new RegExp(organizationName) });
  await choice.waitFor();
  await press(choice, "Space");
  await press(page.getByRole("button", { name: "Confirm" }));
  const codes = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await expect(codes).toHaveCount(10);
  const recovery = (await codes.allTextContents()).map((t) => t.trim());
  // The unused ones, for settings.spec.ts (the same, only system manager).
  saveRootRecoveryCodes(recovery.slice(1));
  await press(page.getByText("I have saved these codes somewhere safe"), "Space");
  await press(page.getByRole("button", { name: "Continue to Oculus" }));

  // People, from the sidebar.
  const people = page.getByRole("list", { name: "Administration" }).getByRole("link", {
    name: "People",
  });
  await press(people);
  await expect(page.getByRole("heading", { level: 1, name: "People" })).toBeVisible();
  await accessible(page, "People");

  // Invite someone.
  await press(page.getByRole("link", { name: "Invite someone" }));
  await expect(page.getByRole("heading", { level: 1, name: "Invite someone" })).toBeVisible();
  await accessible(page, "Invite someone");
  await typeInto(page.getByLabel(/Their email address/), "new.volunteer@example.org");
  await press(page.getByRole("button", { name: "Send the invitation" }));
  await expect(
    page.getByText(/invitation is on its way to new.volunteer@example.org/),
  ).toBeVisible();
  await accessible(page, "Invitation sent");

  // The helper's page: give a role.
  await press(page.getByRole("link", { name: "Back to people" }));
  await press(page.getByRole("link", { name: helperName }));
  await expect(page.getByRole("heading", { level: 1, name: helperName })).toBeVisible();
  await accessible(page, "Person");
  const give = page.getByRole("form", { name: "Give a role" });
  await give.getByLabel("Role").focus();
  await give.getByLabel("Role").selectOption("reviewer");
  await give.getByLabel("Site").focus();
  await give.getByLabel("Site").selectOption({ index: 1 });
  await press(give.getByRole("button", { name: "Give the role" }));
  await expect(page.getByText("The role was given.")).toBeVisible();
  await expect(page.getByText(/^Reviewer on /)).toBeVisible();

  // Reset their two-step sign-in, confirmed in the page with the admin's own recovery code.
  await press(page.getByRole("button", { name: "Reset two-step sign-in…" }));
  const reset = page.getByRole("region", { name: "Reset their two-step sign-in?" });
  await expect(reset).toBeFocused();
  await accessible(page, "Reset two-step sign-in");
  await typeInto(reset.getByLabel(/Your own code/), recovery[0] ?? "");
  await press(reset.getByRole("button", { name: "Reset two-step sign-in" }));
  await expect(page.getByText(/Two-step sign-in was reset/)).toBeVisible();

  // D-078: no second factor in use now, so a reset link warns first.
  await press(page.getByRole("button", { name: "Send a password reset link…" }));
  const link = page.getByRole("region", { name: "Send them a password reset link?" });
  await expect(
    link.getByText(/could choose a new password and set up two-step sign-in/),
  ).toBeVisible();
  await expect(link.getByRole("button", { name: "Send the link" })).toBeDisabled();
  await accessible(page, "Reset link warning");
  await press(link.getByLabel("I have confirmed who they are another way"), "Space");
  await press(link.getByRole("button", { name: "Send the link" }));
  await expect(page.getByText(/reset link is on its way/)).toBeVisible();

  // The audit trail shows what was done.
  await press(
    page.getByRole("list", { name: "Administration" }).getByRole("link", { name: "Audit trail" }),
  );
  await expect(page.getByRole("heading", { level: 1, name: "Audit trail" })).toBeVisible();
  await expect(
    page.getByText(new RegExp(`Gave a role to ${helperName}: Reviewer on`)),
  ).toBeVisible();
  await expect(page.getByText(`Reset two-step sign-in of ${helperName}`)).toBeVisible();
  await expect(page.getByText("Invited new.volunteer@example.org")).toBeVisible();
  await accessible(page, "Audit trail");

  // The roles page.
  await press(
    page.getByRole("list", { name: "Administration" }).getByRole("link", { name: "Roles" }),
  );
  await expect(page.getByRole("heading", { level: 1, name: "Roles" })).toBeVisible();
  await accessible(page, "Roles");

  expect(errors).toEqual([]);
});
