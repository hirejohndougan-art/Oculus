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
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newOrganizationId } from "@oculus/core";
import { LEASE_LOCK, STORE_MARKER, openFileStore, type FileStore } from "./file-store.js";

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
    rmSync(join(dir, other), { recursive: true, force: true });
  });
});

describe("the second review's changes", () => {
  it("writes, replaces and reads the marker with its epoch, never over an existing one", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "oculus-store-marker-"));
    const own = await openFileStore({ dir: fresh });
    expect(await own.isEmpty()).toBe(true);
    expect(await own.readMarker()).toBeUndefined();
    expect(await own.markerAge()).toBeUndefined();
    const id = "11111111-2222-4333-8444-555555555555";
    const epoch = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await own.writeMarker({ storeId: id, database: "7001:16384", epoch });
    expect(await own.readMarker()).toEqual({ storeId: id, database: "7001:16384", epoch });
    expect(statSync(join(fresh, STORE_MARKER)).mode & 0o777).toBe(0o600);
    await expect(
      own.writeMarker({ storeId: id, database: "7001:16384", epoch: id }),
    ).rejects.toThrow();
    expect((await own.readMarker())?.epoch).toBe(epoch);
    const next = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    await own.replaceMarker({ storeId: id, database: "7001:16384", epoch: next });
    expect((await own.readMarker())?.epoch).toBe(next);
    const age = await own.markerAge();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);
    const past = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(fresh, STORE_MARKER), past, past);
    expect(await own.markerAge()).toBeGreaterThan(3600_000);
    expect(await own.markerInProgress()).toBe(false);
    // A marker that isn't one is an error, never taken as one.
    writeFileSync(join(fresh, STORE_MARKER), "../../etc\n");
    await expect(own.readMarker()).rejects.toThrow(/can't be read/);
    writeFileSync(join(fresh, STORE_MARKER), `${id}\n7001:20000\nnot-an-epoch\n`);
    await expect(own.readMarker()).rejects.toThrow(/can't be read/);
    writeFileSync(join(fresh, STORE_MARKER), `${id}\n`);
    expect(await own.readMarker()).toEqual({ storeId: id });
    // Another server's marker being written shows as in progress.
    writeFileSync(join(fresh, `${STORE_MARKER}.0123456789abcdef`), "");
    expect(await own.markerInProgress()).toBe(true);
    rmSync(join(fresh, `${STORE_MARKER}.0123456789abcdef`));
    expect(own.boundTo()).toBeUndefined();
    own.bind(id);
    expect(own.boundTo()).toBe(id);
    expect(() => {
      own.bind("../not-an-id");
    }).toThrow(TypeError);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("lets servers of one database share the folder and refuses a second database's", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "oculus-store-servers-"));
    const own = await openFileStore({ dir: fresh });
    const folder = join(fresh, ".oculus-servers");
    const notes = (): string[] => readdirSync(folder).sort();
    const first = await own.claimServer("7001:16384|oculus|5432");
    expect(first.ok).toBe(true);
    expect(notes()).toHaveLength(1);
    // The same database (this process stands in for a second server of it).
    const same = await own.claimServer("7001:16384|oculus|5432");
    expect(same.ok).toBe(true);
    expect(notes()).toHaveLength(2);
    // Another database in this very process: refused, and its note gone.
    expect((await own.claimServer("7001:20000|copy|5432")).ok).toBe(false);
    expect(notes()).toHaveLength(2);
    if (same.ok) same.release();
    // Another live server with another database: a stand-in note for the
    // parent process, which is alive. Refused, and nothing of ours is left.
    const host = hostname()
      .replace(/[^A-Za-z0-9.-]/g, "_")
      .slice(0, 100);
    const theirs = join(folder, `${host}-${String(process.ppid)}-0123456789abcdef`);
    writeFileSync(theirs, "7001:20000|copy|5432\n");
    const before = notes();
    expect((await own.claimServer("7001:16384|oculus|5432")).ok).toBe(false);
    expect(notes()).toEqual(before);
    // A note being written (its temporary name) is not read as one.
    rmSync(theirs);
    writeFileSync(join(folder, `.${host}-${String(process.ppid)}-0123456789abcdef.tmp`), "");
    const meanwhile = await own.claimServer("7001:16384|oculus|5432");
    expect(meanwhile.ok).toBe(true);
    if (meanwhile.ok) meanwhile.release();
    rmSync(join(folder, `.${host}-${String(process.ppid)}-0123456789abcdef.tmp`));
    // A server that has gone doesn't count, nor a note of this process's
    // PID that this process doesn't hold (left by an earlier process).
    const gone = join(folder, `${host}-999999999-0123456789abcdef`);
    const earlier = join(folder, `${host}-${String(process.pid)}-fedcba9876543210`);
    writeFileSync(gone, "7001:20000|copy|5432\n");
    writeFileSync(earlier, "7001:20000|copy|5432\n");
    const later = await own.claimServer("7001:16384|oculus|5432");
    expect(later.ok).toBe(true);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(earlier)).toBe(false);
    if (later.ok) later.release();
    if (first.ok) first.release();
    expect(notes()).toEqual([]);
    expect(await own.isEmpty()).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("touches a stored copy by the file system's clock, and only a plain copy of its own", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "oculus-store-touch-"));
    const own = await openFileStore({ dir: fresh });
    const org = newOrganizationId();
    const got = await own.receive(org, chunksOf(Buffer.from("touched")));
    if (!got.ok) throw new Error(got.code);
    await own.place(got.file);
    const path = own.pathFor(org, got.file.sha256);
    const past = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(path, past, past);
    expect(await own.touch(org, got.file.sha256)).toBe("touched");
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60_000);
    // None there.
    expect(await own.touch(org, "0".repeat(64))).toBe("missing");
    // A link where the copy should be is never followed.
    const target = join(fresh, "elsewhere");
    writeFileSync(target, "x");
    utimesSync(target, past, past);
    const linked = "a".repeat(64);
    mkdirSync(dirname(own.pathFor(org, linked)), { recursive: true });
    symlinkSync(target, own.pathFor(org, linked));
    expect(await own.touch(org, linked)).toBe("missing");
    expect(Date.now() - lstatSync(target).mtimeMs).toBeGreaterThan(86_400_000);
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
    const hash = done.file.sha256;
    // The purge's two steps (S-052): only while the copy's time is the one given.
    const stamp = await store.copyStamp(other, hash);
    if (stamp === undefined) throw new Error("no stamp");
    expect(stamp.size).toBe(done.file.size);
    expect(await store.trashContent(other, hash, stamp.mtimeNs + 1n)).toBe("changed");
    expect(await store.contents(other)).toEqual([hash]);
    await store.writeThumbnail(other, hash, "small", "none");
    expect(await store.trashContent(other, hash, stamp.mtimeNs)).toBe("trashed");
    expect(await store.contents(other)).toEqual([]);
    expect(await store.readThumbnail(other, hash, "small")).toBeUndefined();
    const [entry] = await store.trashEntries(other);
    expect(entry).toMatchObject({ sha256: hash, size: done.file.size, mtimeNs: stamp.mtimeNs });
    expect(Number.isFinite(entry?.markedMs)).toBe(true);
    expect(readdirSync(join(dir, other, "trash", hash)).sort()).toEqual([
      "content",
      "marked",
      "thumbnail-small-v1.none",
    ]);
    expect(await store.trashContent(other, hash, stamp.mtimeNs)).toBe("missing");
    // Put back: the same bytes, the same time.
    expect(await store.restoreFromTrash(other, hash)).toBe("restored");
    expect((await store.copyStamp(other, hash))?.mtimeNs).toBe(stamp.mtimeNs);
    expect(existsSync(join(dir, other, "trash", hash))).toBe(false);
    expect(await store.restoreFromTrash(other, hash)).toBe("none");
    // Trashed again, then deleted only with the right time.
    expect(await store.trashContent(other, hash, stamp.mtimeNs)).toBe("trashed");
    expect(await store.deleteTrashed(other, hash, stamp.mtimeNs - 1n)).toBe("changed");
    expect(await store.deleteTrashed(other, hash, stamp.mtimeNs)).toBe("deleted");
    expect(await store.deleteTrashed(other, hash, stamp.mtimeNs)).toBe("missing");
    expect(await store.trashEntries(other)).toEqual([]);
    expect(tree().filter((p) => p.includes(other) && !p.includes("incoming"))).toEqual([]);
    // Something that isn't a regular file at a content path is counted, never moved.
    mkdirSync(join(dir, other, "sha256", "ef", "ef".repeat(32)), { recursive: true });
    expect(await store.listContents(other)).toEqual({ hashes: [], skipped: 1 });
    expect(await store.copyStamp(other, "ef".repeat(32))).toBeUndefined();
    expect(await store.trashContent(other, "ef".repeat(32), 0n)).toBe("changed");
    expect(existsSync(join(dir, other, "sha256", "ef", "ef".repeat(32)))).toBe(true);
    rmSync(join(dir, other), { recursive: true, force: true });
  });

  it("puts a trashed copy back for an upload, or drops it when the same content is stored again", async () => {
    const other = newOrganizationId();
    const body = randomBytes(300);
    const first = await store.receive(other, chunksOf(body));
    if (!first.ok) throw new Error(first.code);
    await store.place(first.file);
    await store.discard(first.file);
    const stamp = await store.copyStamp(other, sha(body));
    if (stamp === undefined) throw new Error("no stamp");
    expect(await store.trashContent(other, sha(body), stamp.mtimeNs)).toBe("trashed");
    // An upload placed the same bytes again meanwhile: the trashed copy goes.
    const again = await store.receive(other, chunksOf(body));
    if (!again.ok) throw new Error(again.code);
    expect(await store.place(again.file)).toBe("stored");
    await store.discard(again.file);
    expect(await store.restoreFromTrash(other, sha(body))).toBe("already_stored");
    expect(readFileSync(store.pathFor(other, sha(body))).equals(body)).toBe(true);
    expect(existsSync(join(dir, other, "trash", sha(body)))).toBe(false);
    rmSync(join(dir, other), { recursive: true, force: true });
  });
});

describe("the S-052 review's store changes", () => {
  it("keeps sub-second times (the purge's self-test), and every touch changes a copy's time", async () => {
    expect(await store.mtimeSelfTest()).toBe(true);
    expect(readdirSync(dir).filter((n) => n.startsWith(".mtime-"))).toEqual([]);
    const other = newOrganizationId();
    const body = randomBytes(64);
    const got = await store.receive(other, chunksOf(body));
    if (!got.ok) throw new Error(got.code);
    await store.place(got.file);
    await store.discard(got.file);
    const time = () => lstatSync(store.pathFor(other, sha(body)), { bigint: true }).mtimeNs;
    let before = time();
    for (let i = 0; i < 5; i++) {
      expect(await store.touch(other, sha(body))).toBe("touched");
      expect(time()).not.toBe(before);
      before = time();
    }
    rmSync(join(dir, other), { recursive: true, force: true });
  });

  it("takes the lease lock one at a time, and takes over a lock its holder left", async () => {
    const lock = join(dir, LEASE_LOCK);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const first = store.withLeaseLock(async () => {
      order.push("first in");
      await held;
      order.push("first out");
    });
    await new Promise((r) => setTimeout(r, 30));
    const second = store.withLeaseLock(() => {
      order.push("second");
      return Promise.resolve(7);
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual(["first in"]);
    release();
    expect(await second).toBe(7);
    await first;
    expect(order).toEqual(["first in", "first out", "second"]);
    expect(existsSync(lock)).toBe(false);
    // A lock left by a process on this host that is gone.
    writeFileSync(lock, `${hostname().replace(/[^A-Za-z0-9.-]/g, "_")}\n999999999\nabcd\n`);
    expect(await store.withLeaseLock(() => Promise.resolve("taken"))).toBe("taken");
    // A lock from elsewhere, older than two minutes by the file system's clock.
    writeFileSync(lock, "another-host\n12\nabcd\n");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    expect(await store.withLeaseLock(() => Promise.resolve("taken"))).toBe("taken");
    expect(existsSync(lock)).toBe(false);
    // Nor is the lock counted as the folder's content.
    writeFileSync(lock, "another-host\n12\nabcd\n");
    const empty = mkdtempSync(join(tmpdir(), "oculus-store-lock-"));
    writeFileSync(join(empty, LEASE_LOCK), "x");
    expect(await (await openFileStore({ dir: empty })).isEmpty()).toBe(true);
    rmSync(empty, { recursive: true, force: true });
    rmSync(lock, { force: true });
  });

  it("reports a trashed copy with a second link as stuck and never deletes or moves it", async () => {
    const other = newOrganizationId();
    const body = randomBytes(80);
    const got = await store.receive(other, chunksOf(body));
    if (!got.ok) throw new Error(got.code);
    await store.place(got.file);
    await store.discard(got.file);
    const stamp = await store.copyStamp(other, sha(body));
    if (stamp === undefined) throw new Error("no stamp");
    expect(await store.trashContent(other, sha(body), stamp.mtimeNs)).toBe("trashed");
    const trashed = join(dir, other, "trash", sha(body), "content");
    const extra = join(dir, other, "kept-elsewhere");
    linkSync(trashed, extra);
    expect(await store.trashEntries(other)).toEqual([
      expect.objectContaining({ sha256: sha(body), stuck: true, size: body.length }),
    ]);
    expect(await store.deleteTrashed(other, sha(body), stamp.mtimeNs)).toBe("changed");
    expect(await store.restoreFromTrash(other, sha(body))).toBe("none");
    expect(readFileSync(trashed).equals(body)).toBe(true);
    expect(existsSync(store.pathFor(other, sha(body)))).toBe(false);
    rmSync(join(dir, other), { recursive: true, force: true });
  });
});

describe("the S-052 second review's store changes", () => {
  const host = () => hostname().replace(/[^A-Za-z0-9.-]/g, "_");

  it("L1: two takers of a stale lock never hold it at once", async () => {
    const lock = join(dir, LEASE_LOCK);
    for (let round = 0; round < 5; round++) {
      writeFileSync(lock, `${host()}\n999999999\nstale\n`);
      let inside = 0;
      let most = 0;
      const work = async () => {
        inside++;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 20));
        inside--;
      };
      await Promise.all([store.withLeaseLock(work), store.withLeaseLock(work)]);
      expect(most).toBe(1);
      expect(existsSync(lock)).toBe(false);
      expect(readdirSync(dir).filter((n) => n.startsWith(`${LEASE_LOCK}.`))).toEqual([]);
    }
  });

  it("L3: a lock with this PID but a nonce it doesn't hold, or a time in the future, is stale", async () => {
    const lock = join(dir, LEASE_LOCK);
    writeFileSync(lock, `${host()}\n${String(process.pid)}\nnot-mine\n`);
    expect(await store.withLeaseLock(() => Promise.resolve("taken"))).toBe("taken");
    writeFileSync(lock, "another-host\n12\nabcd\n");
    const future = new Date(Date.now() + 3600_000);
    utimesSync(lock, future, future);
    expect(await store.withLeaseLock(() => Promise.resolve("taken"))).toBe("taken");
    expect(existsSync(lock)).toBe(false);
  });

  it("L2: a held lock's time moves on while the work runs, and a release only removes its own", async () => {
    const beating = await openFileStore({ dir, leaseLockBeatMs: 30 });
    const lock = join(dir, LEASE_LOCK);
    await beating.withLeaseLock(async () => {
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(lock, old, old);
      await new Promise((r) => setTimeout(r, 200));
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(60_000);
      // Someone else's lock in its place by the end: left alone.
      writeFileSync(lock, "another-host\n12\ntheirs\n");
    });
    expect(readFileSync(lock, "utf8")).toBe("another-host\n12\ntheirs\n");
    rmSync(lock);
  });

  it("L2: place trusts the hash taken before the lock only while the copy is the one hashed", async () => {
    const other = newOrganizationId();
    const body = randomBytes(90);
    const first = await store.receive(other, chunksOf(body));
    if (!first.ok) throw new Error(first.code);
    await store.place(first.file);
    await store.discard(first.file);
    const again = await store.receive(other, chunksOf(body));
    if (!again.ok) throw new Error(again.code);
    const prior = await store.inspect(again.file);
    expect(prior?.same).toBe(true);
    expect(await store.place(again.file, prior)).toBe("already_stored");
    await store.discard(again.file);
    // The copy changed after it was hashed (same size, other bytes): replaced.
    const third = await store.receive(other, chunksOf(body));
    if (!third.ok) throw new Error(third.code);
    const seen = await store.inspect(third.file);
    const path = store.pathFor(other, sha(body));
    writeFileSync(path, randomBytes(90));
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    expect(await store.place(third.file, seen)).toBe("stored");
    expect(readFileSync(path).equals(body)).toBe(true);
    await store.discard(third.file);
    rmSync(join(dir, other), { recursive: true, force: true });
  });
});
