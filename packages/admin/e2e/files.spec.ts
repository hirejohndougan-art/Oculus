// M-001 (D-089) in a real browser: a stored HTML or SVG file that carries
// script can't run it, whether a page on another origin (a public site)
// frames, embeds or links it, or someone opens it directly; and an SVG
// stored under a raster type is never rendered as SVG. Framing and embedding
// are stopped by several of the file headers together (frame-ancestors,
// CORP, the sandbox, the download type); the unit tests check each header,
// and opening a file directly shows the download rule on its own. The file server here
// is Oculus's own (`buildServer` with `fileReply` routes), on its own port.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { buildServer, fileReply } from "@oculus/api";

const SCRIPT = "parent.postMessage('ran','*');top.postMessage('ran','*');document.title='ran';";
const FILES = {
  "/files/page.html": {
    mediaType: "text/html",
    bytes: `<!doctype html><title>x</title><script>${SCRIPT}</script><img src=x onerror="${SCRIPT}">`,
  },
  "/files/drawing.svg": {
    mediaType: "image/svg+xml",
    bytes: `<svg xmlns="http://www.w3.org/2000/svg" onload="${SCRIPT}"><script>${SCRIPT}</script></svg>`,
  },
  "/files/page.xhtml": {
    mediaType: "application/xhtml+xml",
    bytes: `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>${SCRIPT}</script></body></html>`,
  },
  // SVG bytes stored under a raster type, asked for inline.
  "/files/liar.png": {
    mediaType: "image/png",
    bytes: `<svg xmlns="http://www.w3.org/2000/svg" onload="${SCRIPT}"><script>${SCRIPT}</script></svg>`,
  },
} as const;

let base = "";
let close: (() => Promise<void>) | undefined;
/** A stand-in public site: a real server on another port, so another origin. */
let publicSite: Server | undefined;
let publicBase = "";
let publicPage = "";
const fetched = new Map<string, number>();

test.beforeAll(async () => {
  const placeholder = "http://127.0.0.1:1";
  // The origin is known only once listening, and the Origin check reads it at
  // build time: listen on a free port first, then build for that port.
  const probe = await buildServer({ env: { OCULUS_ORIGINS: placeholder } });
  await probe.listen({ host: "127.0.0.1", port: 0 });
  const port = (probe.server.address() as AddressInfo).port;
  await probe.close();
  base = `http://127.0.0.1:${String(port)}`;
  const app = await buildServer({
    env: { OCULUS_ORIGINS: base },
    routes: Object.entries(FILES).map(([path, file]) => ({
      method: "GET" as const,
      path,
      handler: () => {
        fetched.set(path, (fetched.get(path) ?? 0) + 1);
        const bytes = Buffer.from(file.bytes);
        return fileReply({
          body: bytes,
          size: bytes.byteLength,
          mediaType: file.mediaType,
          fileName: path.slice(path.lastIndexOf("/") + 1),
          disposition: "inline",
        });
      },
    })),
  });
  await app.listen({ host: "127.0.0.1", port });
  close = () => app.close();
  publicSite = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(publicPage);
  });
  await new Promise<void>((resolve) => publicSite?.listen(0, "127.0.0.1", resolve));
  publicBase = `http://localhost:${String((publicSite.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await close?.();
  await new Promise((resolve) => publicSite?.close(resolve));
});

test("a public page can't run a stored file's script by framing or embedding it", async ({
  page,
}) => {
  const tags = Object.keys(FILES)
    .map((path) => {
      const url = `${base}${path}`;
      return [
        `<iframe src="${url}"></iframe>`,
        `<iframe sandbox="allow-scripts" src="${url}"></iframe>`,
        `<object data="${url}"></object>`,
        `<embed src="${url}">`,
        `<img src="${url}" alt="">`,
      ].join("");
    })
    .join("");
  // A frame that is allowed to run script proves the listener works.
  publicPage = `<!doctype html><title>Public site</title><script>
        window.ran = 0;
        addEventListener("message", (event) => {
          if (event.data === "control") window.control = true; else window.ran++;
        });
      </script><iframe srcdoc="<script>parent.postMessage('control','*')</script>"></iframe>${tags}`;
  page.on("download", (download) => void download.cancel());
  await page.goto(`${publicBase}/`);
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (window as unknown as { control?: true }).control)).toBe(true);
  // Every file was really requested from Oculus, by several of the tags
  // (not blocked before reaching it).
  expect(fetched.size).toBe(Object.keys(FILES).length);
  for (const count of fetched.values()) expect(count).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => (window as unknown as { ran: number }).ran)).toBe(0);
  expect(await page.title()).toBe("Public site");
});

test("opening a stored HTML or SVG file downloads it rather than showing it", async ({ page }) => {
  for (const path of ["/files/page.html", "/files/drawing.svg", "/files/page.xhtml"]) {
    const downloading = page.waitForEvent("download");
    await page.goto(`${base}${path}`).catch(() => undefined); // "Download is starting"
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(path.slice(path.lastIndexOf("/") + 1));
    await download.cancel();
  }
});

test("SVG stored as a PNG is not rendered as SVG and runs nothing", async ({ page }) => {
  const response = await page.goto(`${base}/files/liar.png`);
  expect(response?.headers()["content-type"]).toBe("image/png");
  expect(response?.headers()["content-security-policy"]).toContain("sandbox");
  await page.waitForTimeout(1000);
  expect(await page.title()).not.toBe("ran");
  expect(await page.locator("svg").count()).toBe(0);
});
