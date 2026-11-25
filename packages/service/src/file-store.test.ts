// The file store on disk (M-002, D-086): paths from the organization and
// the content hash only, the per-file cap mid-stream with nothing left
// behind, a client that goes away, the checksum, placing over an existing
// copy (kept when it is the same, replaced when damaged or a link), and the
// refusals when opening. Every byte is invented.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  statSync,
  utimesSync,
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
import { STORE_MARKER, openFileStore, type FileStore } from "./file-store.js";

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
    await expect(store.receive(org, slow(), { signal: controller.signal })).rejects.toThrow();
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

describe("the safety and limits added after review", () => {
  it("refuses a root writable by group or others", async () => {
    const open = mkdtempSync(join(tmpdir(), "oculus-store-open-"));
    chmodSync(open, 0o777);
    await expect(openFileStore({ dir: open })).rejects.toThrow(/writable by it alone/);
    chmodSync(open, 0o770);
    await expect(openFileStore({ dir: open })).rejects.toThrow(/writable by it alone/);
    chmodSync(open, 0o700);
    await expect(openFileStore({ dir: open })).resolves.toBeDefined();
    rmSync(open, { recursive: true, force: true });
  });

  it("never follows a link planted for a folder below the root", async () => {
    const other = newOrganizationId();
    const outside = mkdtempSync(join(tmpdir(), "oculus-store-outside-"));
    mkdirSync(join(dir, other));
    symlinkSync(outside, join(dir, other, "incoming"));
    await expect(store.receive(other, chunksOf(randomBytes(10)))).rejects.toThrow(/plain folder/);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(dir, other, "incoming"));
    // A folder writable by others is refused too.
    mkdirSync(join(dir, other, "incoming"));
    chmodSync(join(dir, other, "incoming"), 0o777);
    await expect(store.receive(other, chunksOf(randomBytes(10)))).rejects.toThrow(/plain folder/);
    rmSync(join(dir, other), { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("leaves a stored copy with one link, and replaces a copy with another link to it", async () => {
    const body = randomBytes(3000);
    const got = await store.receive(org, chunksOf(body));
    if (!got.ok) throw new Error(got.code);
    expect(await store.place(got.file)).toBe("stored");
    const target = store.pathFor(org, sha(body));
    expect(statSync(target).nlink).toBe(1);
    expect(tree().filter((p) => p.includes("incoming"))).toEqual([]);
    await store.discard(got.file);
    // Someone keeps a second link to the copy (to change it later in place).
    const planted = join(dir, "planted-link");
    linkSync(target, planted);
    const again = await store.receive(org, chunksOf(body));
    if (!again.ok) throw new Error(again.code);
    expect(await store.place(again.file)).toBe("stored");
    await store.discard(again.file);
    expect(statSync(target).nlink).toBe(1);
    rmSync(planted);
  });

  it("counts every upload of an organization in flight against its total", async () => {
    const small = await openFileStore({ dir, maxFileBytes: 10_000, maxOrganizationBytes: 6_000 });
    const other = newOrganizationId();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    async function* slowFirst(): AsyncIterable<Uint8Array> {
      yield randomBytes(4000);
      await held;
    }
    const first = small.receive(other, slowFirst(), { usedBytes: 0 });
    await new Promise((r) => setTimeout(r, 20));
    // While 4,000 bytes are in flight, 3,000 more don't fit in 6,000.
    expect(await small.receive(other, chunksOf(randomBytes(3000)), { usedBytes: 0 })).toEqual({
      ok: false,
      code: "quota_exceeded",
    });
    release();
    const done = await first;
    if (!done.ok) throw new Error(done.code);
    // Released when discarded: now it fits.
    await small.discard(done.file);
    const later = await small.receive(other, chunksOf(randomBytes(3000)), { usedBytes: 0 });
    expect(later.ok).toBe(true);
    if (later.ok) await small.discard(later.file);
    // What the organization stores counts too.
    expect(await small.receive(other, chunksOf(randomBytes(3000)), { usedBytes: 4000 })).toEqual({
      ok: false,
      code: "quota_exceeded",
    });
    expect(tree().filter((p) => p.includes("incoming") && p.includes(other))).toEqual([]);
  });

  it("refuses when the disk would drop below the free-space floor", async () => {
    let free = 10 * 1024 * 1024 * 1024;
    const total = 100 * 1024 * 1024 * 1024;
    const watched = await openFileStore({
      dir,
      freeSpace: () => Promise.resolve({ free, total }),
    });
    expect(await watched.lowOnSpace(0)).toBe(false);
    // The floor: 5% of 100 GiB is 5 GiB, more than 2 GiB, so 2 GiB.
    expect(await watched.lowOnSpace(8 * 1024 * 1024 * 1024 + 1)).toBe(true);
    free = 1024 * 1024 * 1024;
    expect(await watched.receive(org, chunksOf(randomBytes(10)))).toEqual({
      ok: false,
      code: "disk_full",
    });
    const configured = await openFileStore({
      dir,
      minFreeBytes: 0,
      freeSpace: () => Promise.resolve({ free: 0, total }),
    });
    expect(await configured.lowOnSpace(1)).toBe(false);
  });

  it("sweeps old temporary files and removes copies on request, never fresh ones", async () => {
    const other = newOrganizationId();
    const incoming = join(dir, other, "incoming");
    mkdirSync(incoming, { recursive: true, mode: 0o700 });
    writeFileSync(join(incoming, "old.part"), "x");
    writeFileSync(join(incoming, "new.part"), "x");
    writeFileSync(join(incoming, "other.txt"), "x");
    const past = new Date(Date.now() - 3 * 3600_000);
    utimesSync(join(incoming, "old.part"), past, past);
    expect(await store.staleIncoming(3600_000)).toBe(1);
    expect(readdirSync(incoming).sort()).toEqual(["new.part", "other.txt"]);
    const body = randomBytes(100);
    const got = await store.receive(other, chunksOf(body));
    if (!got.ok) throw new Error(got.code);
    await store.place(got.file);
    await store.discard(got.file);
    expect(await store.organizations()).toContain(other);
    expect(await store.contents(other)).toEqual([sha(body)]);
    await store.removeContent(other, sha(body));
    expect(await store.contents(other)).toEqual([]);
    rmSync(join(dir, other), { recursive: true, force: true });
  });
});

describe("the second review's changes", () => {
  it("writes and reads the install marker, never over an existing one", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "oculus-store-marker-"));
    const own = await openFileStore({ dir: fresh });
    expect(await own.isEmpty()).toBe(true);
    expect(await own.readMarker()).toBeUndefined();
    const id = "11111111-2222-4333-8444-555555555555";
    await own.writeMarker(id);
    expect(await own.readMarker()).toBe(id);
    expect(statSync(join(fresh, STORE_MARKER)).mode & 0o777).toBe(0o600);
    await expect(own.writeMarker("66666666-7777-4888-9999-aaaaaaaaaaaa")).rejects.toThrow();
    expect(await own.readMarker()).toBe(id);
    expect(own.boundTo()).toBeUndefined();
    own.bind(id);
    expect(own.boundTo()).toBe(id);
    expect(() => {
      own.bind("../not-an-id");
    }).toThrow(TypeError);
    expect(readdirSync(fresh)).toEqual([STORE_MARKER]);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("holds declared lengths against the free-space floor, so uploads starting together can't overshoot", async () => {
    const MiB = 1024 * 1024;
    const tight = await openFileStore({
      dir,
      minFreeBytes: 100 * MiB,
      // 150 MiB free above a 100 MiB floor: room for one 30 MiB upload, not two.
      freeSpace: () => Promise.resolve({ free: 150 * MiB, total: 1000 * MiB }),
    });
    const other = newOrganizationId();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    async function* waits(): AsyncIterable<Uint8Array> {
      yield randomBytes(10);
      await held;
    }
    const first = tight.receive(other, waits(), { declaredBytes: 30 * MiB });
    await new Promise((r) => setTimeout(r, 20));
    // 30 MiB already reserved: another 30 would leave 90 MiB, under the floor.
    expect(
      await tight.receive(other, chunksOf(randomBytes(10)), { declaredBytes: 30 * MiB }),
    ).toEqual({ ok: false, code: "disk_full" });
    release();
    const done = await first;
    if (done.ok) await tight.discard(done.file);
    // Released: now it fits.
    const later = await tight.receive(other, chunksOf(randomBytes(10)), {
      declaredBytes: 30 * MiB,
    });
    expect(later.ok).toBe(true);
    if (later.ok) await tight.discard(later.file);
    rmSync(join(dir, other), { recursive: true, force: true });
  });

  it("never sweeps a temporary file it is still writing, and moves copies to the trash before deleting them", async () => {
    const other = newOrganizationId();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    async function* waits(): AsyncIterable<Uint8Array> {
      yield randomBytes(10);
      await held;
    }
    const writing = store.receive(other, waits());
    await new Promise((r) => setTimeout(r, 20));
    // Even with a maximum age of 0, the upload in progress stays.
    expect(await store.staleIncoming(0)).toBe(0);
    release();
    const done = await writing;
    if (!done.ok) throw new Error(done.code);
    expect(await store.place(done.file)).toBe("stored");
    await store.discard(done.file);
    const listed = await store.listContents(other);
    expect(listed).toEqual({ hashes: [done.file.sha256], skipped: 0 });
    await store.trash(other, done.file.sha256);
    expect(await store.contents(other)).toEqual([]);
    expect(await store.emptyTrash(other)).toBe(1);
    expect(tree().filter((p) => p.includes(other))).toEqual([]);
    // Something that isn't a regular file at a content path is counted, never removed.
    mkdirSync(join(dir, other, "sha256", "ef", "ef".repeat(32)), { recursive: true });
    expect(await store.listContents(other)).toEqual({ hashes: [], skipped: 1 });
    await store.trash(other, "ef".repeat(32));
    expect(existsSync(join(dir, other, "sha256", "ef", "ef".repeat(32)))).toBe(true);
    rmSync(join(dir, other), { recursive: true, force: true });
  });
});
