// Intake (T-073) in a real browser against the built admin and a throwaway
// database, by keyboard: the system manager opens Accessions from the
// sidebar, logs an accession (finding the invented donor by searching the
// site), marks its deed signed on Deeds of gift, and saves the donor's
// contact details. Siteimprove Alfa's rules run on each screen; no CSP
// refusal or script error may happen on the way. Everything is invented.
// Named to run after people.spec.ts, which sets up the system manager's
// two-step sign-in and keeps its recovery codes (signInRoot uses one).
import { expect, test, type Page } from "@playwright/test";
import { accessible, collectErrors, seed, signInRoot } from "./helpers";

async function press(page: Page, name: string, role: "button" | "link" = "button") {
  const control = page.getByRole(role, { name, exact: true });
  if (role === "button") await expect(control).toBeEnabled();
  await control.focus();
  await page.keyboard.press("Enter");
}

async function typeInto(page: Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).focus();
  await page.keyboard.type(text);
}

test("a system manager logs an accession, marks its deed signed and saves the donor's contact", async ({
  page,
}) => {
  const { siteName, donorName } = seed();
  const errors = collectErrors(page);
  await signInRoot(page);
  await expect(page.getByRole("heading", { level: 1, name: siteName })).toBeVisible();

  // The register, empty.
  await press(page, "Accessions", "link");
  await expect(page.getByRole("heading", { level: 1, name: "Accessions" })).toBeVisible();
  await accessible(page, "Accessions");

  // Log an accession.
  await press(page, "Log an accession", "link");
  await expect(page.getByRole("heading", { level: 1, name: "Log an accession" })).toBeVisible();
  await accessible(page, "Log an accession");
  const picker = page.getByRole("group", { name: "Pick the donor" });
  await picker.getByLabel("Search by title").focus();
  await page.keyboard.type("Marsh");
  await page.keyboard.press("Enter");
  const pick = picker.getByRole("button", { name: `Pick ${donorName}` });
  await expect(pick).toBeVisible();
  await pick.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(donorName, { exact: true })).toBeVisible();
  await page.getByLabel("Received on").fill("2026-11-02");
  await typeInto(page, "The materials, described as a whole", "Invented: two boxes of letters");
  await typeInto(page, "Number", "2026.001");
  await accessible(page, "Log an accession, filled in");
  await press(page, "Save the accession");
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Accession 2026.001" })).toBeVisible();
  await accessible(page, "An accession");

  // Deeds of gift: the new accession's deed is missing.
  await press(page, "Deeds of gift", "link");
  await expect(page.getByRole("heading", { level: 1, name: "Deeds of gift" })).toBeVisible();
  await expect(page.getByText("1 accession is missing a signed deed.")).toBeVisible();
  await accessible(page, "Deeds of gift");
  await press(page, "Mark 2026.001 as signed");
  await expect(
    page.getByText("Every accession has its deed signed or doesn't need one."),
  ).toBeVisible();

  // Donors, and the donor's contact details.
  await press(page, "Donors", "link");
  await expect(page.getByRole("heading", { level: 1, name: "Donors" })).toBeVisible();
  await accessible(page, "Donors");
  await press(page, donorName, "link");
  await expect(page.getByRole("heading", { level: 1, name: donorName })).toBeVisible();
  await accessible(page, "A donor");
  await typeInto(page, "Email", "marsh@example.org");
  await press(page, "Save contact details");
  await expect(page.getByRole("button", { name: "Forget contact details" })).toBeVisible();
  await accessible(page, "A donor with contact details");

  expect(errors).toEqual([]);
});
