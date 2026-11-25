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

describe("the files panel", () => {
  it("lists the files with names as text, and no upload control for read-only people", async () => {
    fakeServer({ [LIST]: [200, { files: [FILE], maxFileBytes: 1000 }] });
    show(false);
    const table = await screen.findByRole("table", { name: "Files on this record" });
    expect(within(table).getByText(FILE.name)).toBeTruthy();
    expect(within(table).getByText("2.0 KB")).toBeTruthy();
    expect(within(table).getByText("image/png")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add files" })).toBeNull();
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
