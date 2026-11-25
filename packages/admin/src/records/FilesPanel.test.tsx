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
import { FilesPanel, sizeText } from "./FilesPanel";
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
  it("shows a placeholder when the server makes no thumbnail, and tries again when it was busy", async () => {
    const thumb = `/api/records/${RECORD_ID}/files/${SKY.id}/thumbnail?size=small`;
    const photoThumb = `/api/records/${RECORD_ID}/files/${PHOTO.id}/thumbnail?size=small`;
    fakeServer({
      [LIST]: [200, { files: [SKY, PHOTO], maxFileBytes: 1000 }],
      [`HEAD ${thumb}`]: [422, { error: "no_thumbnail" }],
      [`HEAD ${photoThumb}`]: [405, { error: "method_not_allowed" }],
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      show(false);
      const button = await screen.findByRole("button", { name: "Preview sky.webp" });
      const img = button.querySelector("img");
      if (img === null) throw new Error("no thumbnail");
      expect(img.getAttribute("loading")).toBe("lazy");
      img.dispatchEvent(new Event("error"));
      await waitFor(() => {
        expect(button.querySelector("img")).toBeNull();
      });
      // The placeholder names the format (the server refused it, or killed its decode).
      expect(within(button).getByText("WebP")).toBeTruthy();
      // Busy (not cached yet): the same thumbnail is asked for again later.
      const photo = screen.getByRole("button", { name: "Preview photo.jpg" });
      photo.querySelector("img")?.dispatchEvent(new Event("error"));
      await vi.advanceTimersByTimeAsync(4500);
      await waitFor(() => {
        expect(photo.querySelector("img")?.getAttribute("src")).toBe(`${photoThumb}&attempt=1`);
      });
    } finally {
      vi.useRealTimers();
    }
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
    // Both images (WebP included) show the server's thumbnail; the HTML file none.
    expect([...document.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual([
      `/api/records/${RECORD_ID}/files/${PHOTO.id}/thumbnail?size=small`,
      `/api/records/${RECORD_ID}/files/${SKY.id}/thumbnail?size=small`,
    ]);
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
    // M-003: the name is never markup; the only image is the server's thumbnail.
    const images = [...document.querySelectorAll("img")];
    expect(images.map((i) => i.getAttribute("src"))).toEqual([
      `/api/records/${RECORD_ID}/files/${FILE.id}/thumbnail?size=small`,
    ]);
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
