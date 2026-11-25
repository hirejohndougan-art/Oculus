// Files on a digital asset (M-002, D-086) in a real browser against the
// built admin and a throwaway database and files folder, by keyboard only:
// a Scanner signs in, opens the site's invented photograph record, adds an
// image through the file chooser opened with Enter, watches it go up and
// sees it listed with the type Oculus found in its bytes. Then (M-003,
// T-072, D-097) its thumbnail appears (a JPEG the server's decoder process
// made, at its real size), the preview opens and closes by keyboard,
// and the download link saves the same bytes. Siteimprove Alfa's rules run
// at each step; no CSP refusal or script error may happen.
// With OCULUS_E2E_SHOTS set, screenshots are saved in that folder.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { expect, test, type FileChooser, type Page } from "@playwright/test";
import { accessible, collectErrors, seed, signInAndSetUp } from "./helpers";

/** A real 1×1 PNG (one invented grey pixel). */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** An invented 320 × 200 PNG (a gradient), made here with zlib. */
function gradientPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(typed.length + 8);
    out.writeUInt32BE(data.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc(typed), typed.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      rows[i] = Math.round((x / width) * 200) + 40;
      rows[i + 1] = Math.round((y / height) * 120) + 60;
      rows[i + 2] = 150;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.OCULUS_E2E_SHOTS;
  if (dir === undefined || dir === "") return;
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

test("a Scanner adds an image to a digital asset by keyboard", async ({ page }) => {
  const { scannerEmail, password, siteName, assetTitle } = seed();
  const errors = collectErrors(page);
  // Listen for the file chooser from the start: Playwright turns on its
  // interception when the first listener is added, which takes a round
  // trip; added just before the key press, a fast press can beat it.
  let chooserOpened: (chooser: FileChooser) => void = () => undefined;
  const chooser = new Promise<FileChooser>((resolve) => {
    chooserOpened = resolve;
  });
  page.on("filechooser", (opened) => {
    chooserOpened(opened);
  });
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

  // M-003: a second, larger image, then its thumbnail, the viewer and a download.
  const second = page.waitForResponse(
    (r) => /\/api\/records\/[0-9a-f-]{36}\/files$/.test(r.url()) && r.request().method() === "POST",
  );
  const picture = gradientPng(320, 200);
  await files.locator('input[type="file"]').setInputFiles({
    name: "harbour view.png",
    mimeType: "image/png",
    buffer: picture,
  });
  expect((await second).status()).toBe(201);
  const preview = files.getByRole("button", { name: "Preview harbour view.png" });
  await expect(preview).toBeVisible();
  const thumbnail = preview.locator("img");
  await expect(thumbnail).toHaveJSProperty("complete", true);
  expect(await thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160);
  await accessible(page, "Asset with thumbnails");
  await shot(page, "03-thumbnails");

  // The viewer opens from the keyboard, moves to the next image and closes with Escape.
  await preview.focus();
  await page.keyboard.press("Enter");
  const viewer = files.getByRole("region", { name: "Preview of harbour view.png" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText("Image 2 of 2")).toBeVisible();
  const big = viewer.getByRole("img", { name: "harbour view.png" });
  await expect(big).toHaveJSProperty("complete", true);
  expect(await big.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  expect(await page.locator("object, embed, iframe").count()).toBe(0);
  await accessible(page, "Image viewer");
  await shot(page, "04-viewer");
  await page.keyboard.press("ArrowRight");
  await expect(
    files.getByRole("region", { name: "Preview of depot photograph.png" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(files.getByRole("region", { name: /^Preview of/ })).toHaveCount(0);
  // The focus goes to the thumbnail of the image shown last.
  await expect(files.getByRole("button", { name: "Preview depot photograph.png" })).toBeFocused();

  // The download link saves the file's own bytes under its name.
  const download = files.getByRole("link", { name: "Download harbour view.png" });
  await download.focus();
  const saving = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const saved = await saving;
  expect(saved.suggestedFilename()).toBe("harbour view.png");
  const path = await saved.path();
  expect(readFileSync(path).equals(picture)).toBe(true);
  await accessible(page, "Asset after a download");
  await shot(page, "05-after-download");

  expect(errors).toEqual([]);
});
