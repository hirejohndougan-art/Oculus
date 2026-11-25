// The file store on disk (M-002, D-086): paths from the organization and
// the content hash only, the per-file cap mid-stream with nothing left
// behind, a client that goes away, the checksum, placing over an existing
// copy (kept when it is the same, replaced when damaged or a link), and the
// refusals when opening. Every byte is invented.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrganizationId } from "@oculus/core";
import { openFileStore, type FileStore } from "./file-store.js";

let dir: string;
let store: FileStore;
const org = newOrganizationId();

async function* chunksOf(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

function tree(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)));
    }
  };
  walk(dir);
  return out.sort();
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oculus-store-test-"));
  store = await openFileStore({ dir, maxFileBytes: 10_000, maxOrganizationBytes: 50_000 });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openFileStore", () => {
  it("refuses a relative, missing or non-folder path and bad caps", async () => {
    await expect(openFileStore({ dir: "relative/files" })).rejects.toThrow(/absolute/);
    await expect(openFileStore({ dir: join(dir, "missing") })).rejects.toThrow(/existing/);
    const file = join(dir, "plain");
    writeFileSync(file, "x");
    await expect(openFileStore({ dir: file })).rejects.toThrow(/existing directory/);
    rmSync(file);
    await expect(openFileStore({ dir, maxFileBytes: 0 })).rejects.toThrow(RangeError);
    await expect(openFileStore({ dir, maxOrganizationBytes: 1.5 })).rejects.toThrow(RangeError);
    const defaults = await openFileStore({ dir });
    expect(defaults.maxFileBytes).toBe(500 * 1024 * 1024);
  });

  it("builds paths from an organization ID and a hash only", () => {
    const hash = "ab".repeat(32);
    expect(store.pathFor(org, hash)).toBe(join(dir, org, "sha256", "ab", hash));
    expect(() => store.pathFor("../x" as never, hash)).toThrow(TypeError);
    expect(() => store.pathFor(org, "../../etc/passwd")).toThrow(TypeError);
  });
});

describe("receive, place and discard", () => {
  it("streams, checks and places a file, then leaves no temporary file", async () => {
    const body = randomBytes(5000);
    const got = await store.receive(org, chunksOf(body.subarray(0, 100), body.subarray(100)));
    if (!got.ok) throw new Error(got.code);
    expect(got.file.sha256).toBe(sha(body));
    expect(got.file.size).toBe(5000);
    expect(Buffer.from(got.file.head).equals(body.subarray(0, 4096))).toBe(true);
    expect(await store.place(got.file)).toBe("stored");
    await store.discard(got.file);
    await store.discard(got.file);
    expect(readFileSync(store.pathFor(org, sha(body))).equals(body)).toBe(true);
    expect(tree().filter((p) => p.includes("incoming"))).toEqual([]);
    await expect(store.place(got.file)).rejects.toThrow(/Not a file this store received/);
  });

  it("stops at the cap and removes the partial file", async () => {
    const before = tree();
    let pulled = 0;
    async function* endless(): AsyncIterable<Uint8Array> {
      for (;;) {
        pulled++;
        await Promise.resolve();
        yield randomBytes(3000);
      }
    }
    const got = await store.receive(org, endless());
    expect(got).toEqual({ ok: false, code: "file_too_large" });
    expect(pulled).toBe(4);
    expect(tree()).toEqual(before);
    expect(await store.receive(org, chunksOf())).toEqual({ ok: false, code: "empty_file" });
    expect(tree()).toEqual(before);
  });

  it("removes the partial file when the client goes away or the request ends", async () => {
    const before = tree();
    async function* broken(): AsyncIterable<Uint8Array> {
      yield randomBytes(1000);
      await Promise.resolve();
      throw new Error("aborted");
    }
    await expect(store.receive(org, broken())).rejects.toThrow("aborted");
    const controller = new AbortController();
    async function* slow(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      yield randomBytes(1000);
      controller.abort(new Error("the request has ended"));
      yield randomBytes(1000);
    }
    await expect(store.receive(org, slow(), controller.signal)).rejects.toThrow();
    expect(tree()).toEqual(before);
  });

  it("keeps an identical copy, and replaces a damaged one or a link in its place", async () => {
    const body = randomBytes(2000);
    const first = await store.receive(org, chunksOf(body));
    if (!first.ok) throw new Error(first.code);
    expect(await store.place(first.file)).toBe("stored");
    await store.discard(first.file);
    const again = await store.receive(org, chunksOf(body));
    if (!again.ok) throw new Error(again.code);
    expect(await store.place(again.file)).toBe("already_stored");
    await store.discard(again.file);

    const target = store.pathFor(org, sha(body));
    writeFileSync(target, Buffer.alloc(2000));
    const repair = await store.receive(org, chunksOf(body));
    if (!repair.ok) throw new Error(repair.code);
    expect(await store.place(repair.file)).toBe("stored");
    await store.discard(repair.file);
    expect(readFileSync(target).equals(body)).toBe(true);

    // A link planted at the content path is replaced, never followed.
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "untouched");
    rmSync(target);
    symlinkSync(outside, target);
    const relink = await store.receive(org, chunksOf(body));
    if (!relink.ok) throw new Error(relink.code);
    expect(await store.place(relink.file)).toBe("stored");
    await store.discard(relink.file);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(existsSync(target)).toBe(true);
  });

  it("refuses chunks that aren't bytes", async () => {
    async function* strings(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      yield "text" as unknown as Uint8Array;
    }
    await expect(store.receive(org, strings())).rejects.toThrow(TypeError);
    expect(tree().filter((p) => p.includes("incoming"))).toEqual([]);
  });
});
