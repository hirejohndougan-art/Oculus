// The item screens (T-046) in a real browser against the built admin and a
// throwaway database, by keyboard only: an editor (a reviewer on the site)
// signs in, searches the site's records, opens one, edits it, meets an edit
// conflict made by "someone else" (a save through the API meanwhile) and
// reloads, saves, publishes, reads the history and restores the first
// version (confirming the public values it changes), then opens the
// site's shared items. Siteimprove Alfa's
// rules run on each new screen and state; no CSP refusal or script error
// may happen on the way.
import { expect, test, type Page } from "@playwright/test";
import { accessible, collectErrors, seed, signInAndSetUp } from "./helpers";

/** Presses Enter on a control after moving focus to it. */
async function press(page: Page, name: string | RegExp, role: "button" | "link" = "button") {
  const control = page.getByRole(role, { name, exact: typeof name === "string" });
  // A control stays disabled while a request is under way (slow machines).
  if (role === "button") await expect(control).toBeEnabled();
  await control.focus();
  await page.keyboard.press("Enter");
}

/** Replaces a field's text by keyboard, then leaves it (the server checks it). */
async function retype(page: Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
  const checked = page.waitForResponse(
    (r) => r.url().endsWith("/api/records/check") && r.request().method() === "POST",
  );
  await page.keyboard.press("Tab");
  expect((await checked).status()).toBe(200);
}

test("find a record, edit it, meet a conflict, publish, read its history and restore", async ({
  page,
}) => {
  const { editorEmail, password, siteName, recordTitle } = seed();
  const errors = collectErrors(page);
  await signInAndSetUp(page, editorEmail, password);

  // Item records: the site's records.
  await expect(page.getByRole("heading", { level: 1, name: siteName })).toBeVisible();
  await expect(page.getByRole("link", { name: recordTitle })).toBeVisible();
  await accessible(page, "Item records");

  // Search by keyboard; the words never reach the address bar.
  await page.getByLabel("Search this site's records").focus();
  await page.keyboard.type("lantern");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table", { name: /^Search results/ })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await accessible(page, "Search results");
  await press(page, recordTitle, "link");

  // The record editor.
  await expect(page.getByRole("heading", { level: 1, name: recordTitle })).toBeVisible();
  await expect(page).toHaveURL(/\/sites\/[0-9a-f-]{36}\/records\/[0-9a-f-]{36}$/);
  const recordId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue("1909~");
  await accessible(page, "Record editor");

  // An edit, while someone else saves the record meanwhile.
  await retype(page, "Description", "A tin lantern, cleaned.");
  const status = await page.evaluate(async (id) => {
    const me = (await (await fetch("/api/me")).json()) as { csrfToken: string };
    const got = (await (await fetch(`/api/records/${id}`)).json()) as {
      version: number;
      record: { title: string };
    };
    const saved = await fetch(`/api/records/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-oculus-csrf": me.csrfToken,
        "if-match": `"v${String(got.version)}"`,
      },
      body: JSON.stringify({ record: { ...got.record, title: `${got.record.title} (checked)` } }),
    });
    return saved.status;
  }, recordId);
  expect(status).toBe(200);
  await press(page, "Save changes");
  await expect(
    page.getByText(/Someone else changed this record since you opened it/),
  ).toBeVisible();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "A tin lantern, cleaned.",
  );
  await accessible(page, "Edit conflict");
  await press(page, "Reload the latest version");
  await expect(
    page.getByRole("heading", { level: 1, name: `${recordTitle} (checked)` }),
  ).toBeVisible();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "A tin lantern from an invented depot.",
  );

  // Edit again and save.
  await retype(page, "Description", "A tin lantern, cleaned and labelled.");
  await press(page, "Save changes");
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  // Publish; then the editor warns that saves go live at once.
  await press(page, "Publish");
  await expect(page.getByText("Published. It is on the public site now.")).toBeVisible();
  await expect(page.getByText(/This record is published\. When you save/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();

  // The history, newest first.
  const versions = page.getByRole("list", { name: "Versions, newest first" });
  await expect(versions.getByRole("listitem").first()).toContainText("Published");
  await accessible(page, "Published record with history");

  // Restore version 1: asked once, then asked to confirm the public values.
  await press(page, "Restore version 1");
  await expect(page.getByRole("region", { name: "Restore version 1?" })).toBeVisible();
  await accessible(page, "Restore dialog");
  await press(page, "Restore this version");
  await expect(page.getByRole("region", { name: "Public values would change" })).toBeVisible();
  await press(page, "Restore and confirm these values");
  await expect(page.getByText(/Restored\. The record is now at version \d+\./)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: recordTitle })).toBeVisible();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "A tin lantern from an invented depot.",
  );

  // Back to the list by keyboard: the record is published there.
  await press(page, "← Item records", "link");
  await expect(page.getByRole("heading", { level: 1, name: siteName })).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(recordTitle) });
  await expect(row.getByText("Published")).toBeVisible();

  // Items shared with the site (T-041e): none yet, and the editor (who sees
  // the whole site) may see them.
  await press(page, "Shared with this site", "link");
  await expect(
    page.getByRole("heading", { level: 1, name: "Shared with this site" }),
  ).toBeVisible();
  await expect(page.getByText("Nothing is shared with this site yet.")).toBeVisible();
  await accessible(page, "Shared with this site");

  expect(errors).toEqual([]);
});
