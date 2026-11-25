// The update package's ZIP reader (T-060, D-092): what the writer makes reads
// back exactly, and every shape outside it is refused: names that leave the
// folder, links, folders, encrypted or described entries, other methods,
// appended bytes and comments, ZIP64, overlapping entries, size and CRC lies,
// a deflate bomb, and names that collide on a case-insensitive disk.
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { tempDir, writeTemp } from "./update.fixtures.js";
import {
  DEFAULT_ZIP_LIMITS,
  ZipError,
  ZipReader,
  checkNameSet,
  writeZip,
  zipNameProblem,
} from "./update-zip.js";

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await tempDir("zip");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readAll(
  bytes: Uint8Array,
  limits = DEFAULT_ZIP_LIMITS,
): Promise<Map<string, string>> {
  const path = await writeTemp(dir, `t${String(n++)}.zip`, bytes);
  const zip = await ZipReader.open(path, limits);
  try {
    const out = new Map<string, string>();
    for (const e of zip.entries) out.set(e.name, (await zip.read(e)).toString("latin1"));
    return out;
  } finally {
    await zip.close();
  }
}

async function refusal(bytes: Uint8Array, limits = DEFAULT_ZIP_LIMITS): Promise<string> {
  try {
    await readAll(bytes, limits);
  } catch (error) {
    if (error instanceof ZipError) return error.code;
    throw error;
  }
  return "accepted";
}

interface RawEntry {
  name: string;
  data: Buffer;
  method?: number;
  flags?: number;
  mode?: number;
  external?: number;
  crc?: number;
  size?: number;
  /** Where the central entry says the local header is (default: where it was written). */
  offset?: number;
  extraLocal?: Buffer;
}

/** A hand-built archive, for shapes the writer refuses to make. */
function raw(
  entries: RawEntry[],
  options: { comment?: Buffer; trailer?: Buffer; prefix?: Buffer } = {},
): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = options.prefix?.length ?? 0;
  if (options.prefix) parts.push(options.prefix);
  for (const e of entries) {
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "latin1");
    const flags = e.flags ?? 0x0800;
    const crc = e.crc ?? crc32(e.data);
    const size = e.size ?? e.data.length;
    const extra = e.extraLocal ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(e.external ?? ((e.mode ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(e.offset ?? offset, 42);
    parts.push(local, name, extra, body);
    central.push(c, name);
    offset += 30 + name.length + extra.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(options.comment?.length ?? 0, 20);
  return Buffer.concat([
    ...parts,
    cd,
    end,
    options.comment ?? Buffer.alloc(0),
    options.trailer ?? Buffer.alloc(0),
  ]);
}

const file = (name: string, text = "x"): RawEntry => ({ name, data: Buffer.from(text) });

describe("the writer and the reader", () => {
  it("reads back exactly what was written, stored and deflated", async () => {
    const big = "an invented line\n".repeat(500);
    const read = await readAll(
      writeZip([
        { name: "a.txt", data: Buffer.from("tiny") },
        { name: "folder/b.txt", data: Buffer.from(big) },
        { name: "empty", data: Buffer.alloc(0) },
      ]),
    );
    expect([...read.entries()]).toEqual([
      ["a.txt", "tiny"],
      ["folder/b.txt", big],
      ["empty", ""],
    ]);
  });

  it("makes the same bytes for the same files", () => {
    const files = [{ name: "a", data: Buffer.from("1") }];
    expect(writeZip(files).equals(writeZip(files))).toBe(true);
  });

  it("refuses to write a name the reader would refuse", () => {
    expect(() => writeZip([{ name: "../x", data: Buffer.alloc(1) }])).toThrow(ZipError);
    expect(() =>
      writeZip([
        { name: "a", data: Buffer.alloc(1) },
        { name: "A", data: Buffer.alloc(1) },
      ]),
    ).toThrow(ZipError);
  });

  it("accepts a hand-built archive of the same shape", async () => {
    expect(await refusal(raw([file("ok.txt")]))).toBe("accepted");
  });
});

describe("names", () => {
  it.each([
    ["../escape", "segment"],
    ["a/../../escape", "segment"],
    ["/etc/passwd", "not_relative_file"],
    ["folder/", "not_relative_file"],
    ["a//b", "segment"],
    ["./a", "segment"],
    ["a\\..\\b", "characters"],
    ["C:evil", "characters"],
    ["tab\there", "characters"],
    ["nul\u0000", "characters"],
    ["café", "characters"],
    ["trailing.", "segment"],
    [" lead", "segment"],
    ["x".repeat(401), "length"],
  ])("%j is refused (%s)", async (name, problem) => {
    expect(zipNameProblem(name)).toBe(problem);
    expect(await refusal(raw([file(name)]))).toBe("bad_name");
  });

  it("refuses names that collide on a case-insensitive disk", async () => {
    expect(await refusal(raw([file("Read.me"), file("read.ME")]))).toBe("duplicate_name");
    expect(await refusal(raw([file("same"), file("same")]))).toBe("duplicate_name");
  });

  it("refuses a file that is also another file's folder", async () => {
    expect(await refusal(raw([file("a/b"), file("a/b/c")]))).toBe("name_conflict");
    expect(() => {
      checkNameSet(["x/y/z", "X/Y"]);
    }).toThrow(ZipError);
  });
});

describe("entry types and flags", () => {
  it("refuses a symbolic link", async () => {
    expect(await refusal(raw([{ ...file("link", "/etc/passwd"), mode: 0o120777 }]))).toBe(
      "not_a_file",
    );
  });

  it("refuses a folder entry by its mode or DOS attribute", async () => {
    expect(await refusal(raw([{ ...file("d"), mode: 0o040755 }]))).toBe("not_a_file");
    expect(await refusal(raw([{ ...file("d"), external: 0x10 }]))).toBe("not_a_file");
  });

  it("refuses encryption, data descriptors and names not marked UTF-8", async () => {
    expect(await refusal(raw([{ ...file("e"), flags: 0x0801 }]))).toBe("unsupported");
    expect(await refusal(raw([{ ...file("e"), flags: 0x0808 }]))).toBe("unsupported");
    expect(await refusal(raw([{ ...file("e"), flags: 0 }]))).toBe("unsupported");
  });

  it("refuses methods other than stored and deflate", async () => {
    expect(await refusal(raw([{ ...file("e"), method: 12 }]))).toBe("unsupported");
  });
});

describe("the archive's shape", () => {
  it("refuses bytes after the archive and an archive comment", async () => {
    expect(await refusal(raw([file("a")], { trailer: Buffer.from("tail") }))).toBe("not_zip");
    expect(await refusal(raw([file("a")], { comment: Buffer.from("hi") }))).toBe("not_zip");
  });

  it("refuses bytes before the archive (a script with a ZIP glued on)", async () => {
    expect(await refusal(raw([file("a")], { prefix: Buffer.from("#!/bin/sh\n") }))).toBe("gap");
  });

  it("refuses ZIP64 markers", async () => {
    expect(await refusal(raw([{ ...file("a"), size: 0xffffffff }]))).toBe("unsupported");
  });

  it("refuses an empty archive and a file that isn't one", async () => {
    expect(await refusal(raw([]))).toBe("empty");
    expect(await refusal(Buffer.from("not a zip at all, just text"))).toBe("not_zip");
    expect(await refusal(Buffer.alloc(3))).toBe("not_zip");
  });

  it("refuses bytes hidden in a local header's extra field", async () => {
    expect(await refusal(raw([{ ...file("a"), extraLocal: Buffer.alloc(8, 0x41) }]))).toBe(
      "bad_entry",
    );
  });

  it("refuses a central entry pointing at another entry's header", async () => {
    const bytes = raw([file("a"), { ...file("b"), offset: 0 }]);
    expect(await refusal(bytes)).toBe("bad_entry");
  });

  it("refuses overlapping entries (one hidden inside another's data)", async () => {
    // Entry "b"'s whole local record sits inside "a"'s stored bytes.
    const inner = raw([file("b", "hidden")]).subarray(0, 30 + 1 + 6);
    const bytes = raw([
      { name: "a", data: inner },
      { name: "b", data: Buffer.from("hidden"), offset: 30 + 1 },
    ]);
    expect(await refusal(bytes)).toBe("overlap");
  });

  it("refuses too many entries and too large a file", async () => {
    const limits = { ...DEFAULT_ZIP_LIMITS, maxEntries: 2 };
    expect(await refusal(raw([file("a"), file("b"), file("c")]), limits)).toBe("too_many_entries");
    const small = { ...DEFAULT_ZIP_LIMITS, maxFileBytes: 50 };
    expect(await refusal(raw([file("a", "y".repeat(100))]), small)).toBe("too_large");
  });

  it("refuses entries past the size limits before inflating anything", async () => {
    const limits = { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 10 };
    expect(await refusal(raw([file("a", "y".repeat(11))]), limits)).toBe("too_large");
    const total = { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 15 };
    expect(await refusal(raw([file("a", "y".repeat(8)), file("b", "y".repeat(8))]), total)).toBe(
      "too_large",
    );
  });
});

describe("the data", () => {
  it("refuses a wrong CRC-32", async () => {
    expect(await refusal(raw([{ ...file("a", "data"), crc: 1234 }]))).toBe("bad_crc");
  });

  it("refuses a stored entry whose sizes disagree", async () => {
    expect(await refusal(raw([{ ...file("a", "data"), size: 3 }]))).toBe("bad_size");
  });

  it("stops a deflate bomb at the declared size", async () => {
    const bomb = Buffer.alloc(5 * 1024 * 1024);
    const bytes = raw([
      { name: "bomb", data: bomb, method: 8, size: 100, crc: crc32(bomb.subarray(0, 100)) },
    ]);
    expect(await refusal(bytes)).toBe("bad_data");
  });
});
