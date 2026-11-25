// Files on a digital asset (M-002, D-086) in a real browser against the
// built admin and a throwaway database and files folder, by keyboard only:
// a Scanner signs in, opens the site's invented photograph record, adds an
// image through the file chooser opened with Enter, watches it go up and
// sees it listed with the type Oculus found in its bytes. Siteimprove Alfa's
// rules run before and after; no CSP refusal or script error may happen.
// With OCULUS_E2E_SHOTS set, screenshots are saved in that folder.
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { accessible, collectErrors, seed, signInAndSetUp } from "./helpers";

/** A real 1×1 PNG (one invented grey pixel). */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.OCULUS_E2E_SHOTS;
  if (dir === undefined || dir === "") return;
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

test("a Scanner adds an image to a digital asset by keyboard", async ({ page }) => {
  const { scannerEmail, password, siteName, assetTitle } = seed();
  const errors = collectErrors(page);
  await signInAndSetUp(page, scannerEmail, password);

  await expect(page.getByRole("heading", { level: 1, name: siteName })).toBeVisible();
  const link = page.getByRole("link", { name: assetTitle, exact: true });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: assetTitle })).toBeVisible();

  const files = page.getByRole("region", { name: "Files" });
  await expect(files.getByText("No files yet.")).toBeVisible();
  await accessible(page, "Asset with no files");
  await shot(page, "01-asset-no-files");

  // The file chooser opens from the keyboard.
  const add = files.getByRole("button", { name: "Add files" });
  await add.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  const sent = page.waitForResponse(
    (r) => /\/api\/records\/[0-9a-f-]{36}\/files$/.test(r.url()) && r.request().method() === "POST",
  );
  // The browser's guess at the type is a lie; the server reads the bytes.
  await picker.setFiles({ name: "depot photograph.png", mimeType: "image/jpeg", buffer: PIXEL });
  expect((await sent).status()).toBe(201);

  await expect(files.getByText("1 added.")).toBeVisible();
  await expect(
    files.getByRole("progressbar", { name: "Upload of depot photograph.png" }),
  ).toBeVisible();
  const table = files.getByRole("table", { name: "Files on this record" });
  const row = table.getByRole("row", { name: /depot photograph\.png/ });
  await expect(row).toContainText("image/png");
  await expect(row).toContainText("bytes");
  await accessible(page, "Asset with a file");
  await shot(page, "02-asset-with-file");

  expect(errors).toEqual([]);
});
