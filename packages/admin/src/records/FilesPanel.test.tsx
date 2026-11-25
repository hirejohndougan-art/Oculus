// @vitest-environment jsdom
// A digital asset's files (M-002, D-086): the list (names as text only),
// the upload control only for people who may edit, several files sent one
// after another with If-Match, the site and the name header, progress,
// cancelling, a file too large refused before it is sent, and the server's
// refusals in plain words. Every name and byte is invented.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_1, fakeServer } from "../testing.fixtures";
import { FilesPanel, SCAN_POLL_MS, SCAN_RETRY_POLL_MS, scanPollMs, sizeText } from "./FilesPanel";
import { viewErrorText } from "./FileViewer";
import { RECORD_ID } from "./records.fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIST = `GET /api/records/${RECORD_ID}/files`;
const FILE = {
  id: "33333333-3333-4333-8333-333333333333",
  name: '<img src=x onerror="alert(1)">.png',
  size: 2048,
  mediaType: "image/png",
  createdAt: "2026-11-24T12:00:00.000Z",
};

interface SentUpload {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for XMLHttpRequest that answers each upload with `answer`. */
function fakeXhr(answer: (n: number) => [number, unknown] | "hang") {
  const sent: SentUpload[] = [];
  class FakeXhr {
    upload: {
      onprogress:
        ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null;
    } = {
      onprogress: null,
    };
    status = 0;
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private url = "";
    private headers: Record<string, string> = {};
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: unknown) {
      sent.push({ url: this.url, headers: this.headers, body });
      const reply = answer(sent.length);
      if (reply === "hang") {
        this.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true });
        return;
      }
      setTimeout(() => {
        this.upload.onprogress?.({ loaded: 10, total: 10, lengthComputable: true });
        this.status = reply[0];
        this.responseText = JSON.stringify(reply[1]);
        this.onload?.();
      }, 0);
    }
    abort() {
      setTimeout(() => this.onabort?.(), 0);
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return sent;
}

function show(canUpload = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FilesPanel siteId={SITE_1} recordId={RECORD_ID} version={4} canUpload={canUpload} />
    </QueryClientProvider>,
  );
}

function file(name: string, size: number, type = "image/png"): File {
  return new File([new Uint8Array(size)], name, { type });
}

const PHOTO = {
  ...FILE,
  id: "44444444-4444-4444-8444-444444444444",
  name: "photo.jpg",
  mediaType: "image/jpeg",
};
const SKY = {
  ...FILE,
  id: "55555555-5555-4555-8555-555555555555",
  name: "sky.webp",
  mediaType: "image/webp",
};
const PAGE = {
  ...FILE,
  id: "66666666-6666-4666-8666-666666666666",
  name: "page.html",
  mediaType: "text/html",
};

describe("viewing and downloading (M-003)", () => {
  it("shows each image's format as a placeholder and asks the server for no thumbnail (T-072)", async () => {
    const sent = fakeServer({ [LIST]: [200, { files: [SKY, PHOTO], maxFileBytes: 1000 }] });
    show(false);
    const sky = await screen.findByRole("button", { name: "Preview sky.webp" });
    expect(within(sky).getByText("WebP")).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: "Preview photo.jpg" })).getByText("JPEG"),
    ).toBeTruthy();
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(sent.some((r) => r.path.includes("/thumbnail"))).toBe(false);
  });

  it("says why an image can't be shown, by its status", async () => {
    fakeServer({
      [LIST]: [200, { files: [PHOTO], maxFileBytes: 1000 }],
      [`HEAD /api/records/${RECORD_ID}/files/${PHOTO.id}/view`]: [422, { error: "not_viewable" }],
    });
    show(false);
    await userEvent.click(await screen.findByRole("button", { name: "Preview photo.jpg" }));
    const viewer = await screen.findByRole("region", { name: "Preview of photo.jpg" });
    within(viewer).getByRole("img").dispatchEvent(new Event("error"));
    expect(await within(viewer).findByRole("alert")).toHaveProperty(
      "textContent",
      viewErrorText(422),
    );
    expect(viewErrorText(404)).toMatch(/no longer/);
    expect(viewErrorText(503)).toMatch(/Try again/);
    expect(within(viewer).getByRole("link", { name: "Download photo.jpg" })).toBeTruthy();
  });

  it("offers a download for every file and a preview only for images, by sniffed type", async () => {
    // An HTML file named like an image is still not an image.
    const liar = { ...PAGE, name: "picture.png" };
    fakeServer({ [LIST]: [200, { files: [PHOTO, liar, SKY], maxFileBytes: 1000 }] });
    show(false);
    const table = await screen.findByRole("table", { name: "Files on this record" });
    for (const f of [PHOTO, liar, SKY]) {
      const link = within(table).getByRole("link", { name: `Download ${f.name}` });
      expect(link.getAttribute("href")).toBe(`/api/records/${RECORD_ID}/files/${f.id}/content`);
      expect(link.hasAttribute("download")).toBe(true);
    }
    expect(within(table).getByRole("button", { name: "Preview photo.jpg" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Preview sky.webp" })).toBeTruthy();
    expect(within(table).queryByRole("button", { name: "Preview picture.png" })).toBeNull();
    // No thumbnails (off until T-072): no image at all in the list.
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.querySelector("object, embed, iframe")).toBeNull();
  });

  it("opens the viewer by keyboard, moves with buttons and arrows, and closes back to the button", async () => {
    fakeServer({ [LIST]: [200, { files: [PHOTO, PAGE, SKY], maxFileBytes: 1000 }] });
    show(false);
    const open = await screen.findByRole("button", { name: "Preview photo.jpg" });
    open.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("region", { name: "Preview of photo.jpg" });
    // The focus moved into the viewer, so the arrow keys reach it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByText("Image 1 of 2")).toBeTruthy();
    const img = within(dialog).getByRole("img", { name: "photo.jpg" });
    expect(img.getAttribute("src")).toBe(`/api/records/${RECORD_ID}/files/${PHOTO.id}/view`);
    await userEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(await screen.findByRole("region", { name: "Preview of sky.webp" })).toBeTruthy();
    await userEvent.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("region", { name: "Preview of photo.jpg" })).toBeTruthy();
    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("region", { name: "Preview of sky.webp" })).toBeTruthy();
    // Round from the last to the first, by keyboard on the button.
    screen.getByRole("button", { name: "Next image" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("region", { name: "Preview of photo.jpg" })).toBeTruthy();
    expect(document.querySelector("object, embed, iframe")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: /^Preview of/ })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(open);
    });
  });
});

describe("the files panel", () => {
  it("lists the files with names as text, and no upload control for read-only people", async () => {
    fakeServer({ [LIST]: [200, { files: [FILE], maxFileBytes: 1000 }] });
    show(false);
    const table = await screen.findByRole("table", { name: "Files on this record" });
    expect(within(table).getByText(FILE.name)).toBeTruthy();
    expect(within(table).getByText("2.0 KB")).toBeTruthy();
    expect(within(table).getByText("image/png")).toBeTruthy();
    // The name is never markup: no image in the list at all.
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Add files" })).toBeNull();
    // Read-only people still download.
    expect(within(table).getByRole("link", { name: `Download ${FILE.name}` })).toBeTruthy();
  });

  it("sends several files one after another, with If-Match, the site and the name", async () => {
    let listed = 0;
    fakeServer({
      [LIST]: () => {
        listed++;
        return [200, { files: listed > 1 ? [FILE] : [], maxFileBytes: 4096 }];
      },
    });
    const sent = fakeXhr(() => [201, { file: FILE, created: true }]);
    show();
    expect(await screen.findByText("No files yet.")).toBeTruthy();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    expect(input.multiple).toBe(true);
    await userEvent.upload(input, [file("Ledger page 1.png", 100), file("Ledger page 2.png", 200)]);
    await waitFor(() => {
      expect(screen.getByText("2 added.")).toBeTruthy();
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.url).toBe(`/api/records/${RECORD_ID}/files`);
    expect(sent[0]?.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "if-match": '"v4"',
      "x-oculus-site": SITE_1,
      "x-oculus-file-name": "Ledger%20page%201.png",
      "x-oculus-file-type": "image/png",
    });
    expect(screen.getAllByRole("progressbar", { name: /Upload of Ledger page/ })).toHaveLength(2);
    expect(await screen.findByRole("table", { name: "Files on this record" })).toBeTruthy();
  });

  it("refuses a file that is too large or empty before sending it, and says what the server refused", async () => {
    fakeServer({ [LIST]: [200, { files: [], maxFileBytes: 1000 }] });
    const sent = fakeXhr(() => [413, { error: "quota_exceeded" }]);
    show();
    await screen.findByText("No files yet.");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    await userEvent.upload(input, [
      file("big.tif", 5000),
      file("empty.png", 0),
      file("ok.png", 10),
    ]);
    expect(
      await screen.findByText(`It is larger than this server takes (${sizeText(1000)}).`),
    ).toBeTruthy();
    expect(screen.getByText("The file is empty.")).toBeTruthy();
    expect(
      await screen.findByText("Your organization has used all its space for files."),
    ).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it("cancels an upload in progress", async () => {
    fakeServer({ [LIST]: [200, { files: [], maxFileBytes: null }] });
    fakeXhr(() => "hang");
    show();
    await screen.findByText("No files yet.");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    await userEvent.upload(input, [file("slow.tif", 10)]);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel slow.tif" }));
    expect(await screen.findByText("Cancelled.")).toBeTruthy();
  });

  it("writes sizes people can read", () => {
    expect(sizeText(1)).toBe("1 byte");
    expect(sizeText(512)).toBe("512 bytes");
    expect(sizeText(1536)).toBe("1.5 KB");
    expect(sizeText(500 * 1024 * 1024)).toBe("500 MB");
    expect(sizeText(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("removes a file after asking, with If-Match", async () => {
    let removed = false;
    const sent = fakeServer({
      [LIST]: () => [200, { files: removed ? [] : [FILE], maxFileBytes: 1000 }],
      [`DELETE /api/records/${RECORD_ID}/files/${FILE.id}`]: () => {
        removed = true;
        return [200, { removed: true }];
      },
    });
    show();
    await userEvent.click(await screen.findByRole("button", { name: `Remove ${FILE.name}` }));
    expect(screen.getByRole("region", { name: `Remove ${FILE.name}?` })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove the file" }));
    expect(await screen.findByText(`Removed ${FILE.name}.`)).toBeTruthy();
    expect(await screen.findByText("No files yet.")).toBeTruthy();
    const call = sent.find((s) => s.method === "DELETE");
    expect(call?.headers).toMatchObject({ "if-match": '"v4"', "x-oculus-site": SITE_1 });
  });
});

describe("virus scans (S-040)", () => {
  const scanned = (scan: string, over: Partial<typeof PHOTO> = {}) => ({ ...PHOTO, ...over, scan });

  it("shows each file's scan as a pill, and offers only clean files", async () => {
    const files = [
      scanned("clean", { id: "71111111-1111-4111-8111-111111111111", name: "clean.jpg" }),
      scanned("pending", { id: "72222222-2222-4222-8222-222222222222", name: "waiting.jpg" }),
      scanned("failed", { id: "73333333-3333-4333-8333-333333333333", name: "unscannable.jpg" }),
      scanned("infected", { id: "74444444-4444-4444-8444-444444444444", name: "bad.jpg" }),
    ];
    fakeServer({ [LIST]: [200, { files, maxFileBytes: 1000 }] });
    show(false);
    const table = await screen.findByRole("table", { name: "Files on this record" });
    expect(within(table).getByRole("columnheader", { name: "Virus scan" })).toBeTruthy();
    for (const label of ["Clean", "Scanning…", "Scan failed", "Infected (quarantined)"]) {
      expect(within(table).getByText(label)).toBeTruthy();
    }
    expect(within(table).getByRole("link", { name: "Download clean.jpg" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Preview clean.jpg" })).toBeTruthy();
    for (const name of ["waiting.jpg", "unscannable.jpg", "bad.jpg"]) {
      expect(within(table).queryByRole("link", { name: `Download ${name}` }), name).toBeNull();
      expect(within(table).queryByRole("button", { name: `Preview ${name}` }), name).toBeNull();
    }
    expect(within(table).getByText("Quarantined: can't be downloaded")).toBeTruthy();
    expect(within(table).getByText("Download once the scan is done")).toBeTruthy();
    expect(screen.getByText(/A virus was found in one file\. It is quarantined/)).toBeTruthy();
    expect(screen.queryByText(/have not been scanned for viruses/)).toBeNull();
  });

  it("says plainly when files were not scanned, and still offers them", async () => {
    fakeServer({ [LIST]: [200, { files: [scanned("not_scanned")], maxFileBytes: 1000 }] });
    show(false);
    expect(await screen.findByText(/have not been scanned for viruses/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Files on this record" });
    expect(within(table).getByText("Not scanned")).toBeTruthy();
    expect(within(table).getByRole("link", { name: "Download photo.jpg" })).toBeTruthy();
  });

  it("offers files from before scanning was turned on, and says why they aren't scanned yet", async () => {
    fakeServer({
      [LIST]: [200, { files: [scanned("not_yet_scanned")], maxFileBytes: 1000 }],
    });
    show(false);
    expect(await screen.findByText(/added before virus scanning was turned on/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Files on this record" });
    expect(within(table).getByText("Not yet scanned")).toBeTruthy();
    expect(within(table).getByRole("link", { name: "Download photo.jpg" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Preview photo.jpg" })).toBeTruthy();
  });

  it("offers files too large to scan, and says they weren't scanned (M1)", async () => {
    fakeServer({
      [LIST]: [200, { files: [scanned("too_large_to_scan")], maxFileBytes: 1000 }],
    });
    show(false);
    expect(await screen.findByText(/larger than the virus scanner accepts/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Files on this record" });
    expect(within(table).getByText("Too large to scan")).toBeTruthy();
    expect(within(table).getByRole("link", { name: "Download photo.jpg" })).toBeTruthy();
  });

  it("says that uploading an unscanned file again holds every copy (M3)", async () => {
    fakeServer({ [LIST]: [200, { files: [scanned("not_yet_scanned")], maxFileBytes: 1000 }] });
    show(false);
    expect(await screen.findByText(/every copy of it waits for that scan/)).toBeTruthy();
  });

  it("says plainly when the server or the scanner refuses a file's size", async () => {
    fakeServer({ [LIST]: [200, { files: [], maxFileBytes: 1000 }] });
    let n = 0;
    fakeXhr(() => {
      n += 1;
      return [413, { error: n === 1 ? "too_large_to_scan" : "file_too_large" }];
    });
    show();
    await screen.findByText("No files yet.");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    await userEvent.upload(input, [file("scan.tif", 10), file("other.tif", 10)]);
    expect(await screen.findByText("It is larger than the virus scanner accepts.")).toBeTruthy();
    expect(await screen.findByText("It is larger than this server takes.")).toBeTruthy();
  });

  it("keeps asking while a scan is due: often for a new upload, slowly for a retry", () => {
    const f = (scan: string, scanQueued: boolean) =>
      ({ ...PHOTO, scan, scanQueued }) as Parameters<typeof scanPollMs>[0][number];
    expect(scanPollMs([f("pending", true)])).toBe(SCAN_POLL_MS);
    expect(scanPollMs([f("failed", true)])).toBe(SCAN_RETRY_POLL_MS);
    expect(scanPollMs([f("not_yet_scanned", true)])).toBe(SCAN_RETRY_POLL_MS);
    // A failed scan not tried again by itself (too large) isn't waited for.
    expect(scanPollMs([f("failed", false), f("clean", false)])).toBeUndefined();
    expect(scanPollMs([f("infected", false), f("not_scanned", false)])).toBeUndefined();
  });

  it("reads the list again in the background while a file is being scanned", async () => {
    let reads = 0;
    const sent = fakeServer({
      [LIST]: () => {
        reads += 1;
        return [200, { files: [scanned(reads < 2 ? "pending" : "clean")], maxFileBytes: 1000 }];
      },
    });
    show(false);
    expect(await screen.findByText("Scanning…")).toBeTruthy();
    expect(await screen.findByText("Clean", {}, { timeout: 8000 })).toBeTruthy();
    const lists = sent.filter((s) => s.path === `/api/records/${RECORD_ID}/files`);
    expect(lists[0]?.headers["x-oculus-background"]).toBeUndefined();
    expect(lists[1]?.headers["x-oculus-background"]).toBe("1");
    // Clean: no more polling.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.filter((s) => s.path === `/api/records/${RECORD_ID}/files`)).toHaveLength(2);
  }, 12_000);
});
