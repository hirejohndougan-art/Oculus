// Signed update packages (T-060, D-092): only a package signed by a trusted
// key, holding exactly the files its manifest lists with their checksums,
// is accepted; the manifest isn't even parsed before its signature checks
// out; and unpacking writes nothing in place until every file has matched.
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PackageError,
  RELEASE_FILE,
  checkManifest,
  compareVersions,
  isVersion,
  parseTrustedKeys,
  readSigningKey,
  signManifest,
  unpackPackage,
  verifyPackage,
} from "./update-package.js";
import {
  craftedPackage,
  manifestFor,
  releaseFiles,
  tempDir,
  testKey,
  testPackage,
  writeTemp,
  type TestKey,
} from "./update.fixtures.js";

let dir: string;
let key: TestKey;
let otherKey: TestKey;
let n = 0;

beforeAll(async () => {
  dir = await tempDir("package");
  key = testKey();
  otherKey = testKey();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const save = (bytes: Uint8Array) => writeTemp(dir, `p${String(n++)}.zip`, bytes);

async function refusal(bytes: Uint8Array, trusted = key.trusted): Promise<string> {
  try {
    await verifyPackage(await save(bytes), trusted);
  } catch (error) {
    if (error instanceof PackageError) return error.code;
    throw error;
  }
  return "accepted";
}

describe("a good package", () => {
  it("verifies, naming its version, key and files", async () => {
    const verified = await verifyPackage(
      await save(testPackage(key, "1.2.3", ["0001_a.sql", "0002_b.sql"])),
      key.trusted,
    );
    expect(verified.keyId).toBe(key.keyId);
    expect(verified.manifest.version).toBe("1.2.3");
    expect(verified.manifest.migrations).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(verified.manifest.files.map((f) => f.path)).toContain(RELEASE_FILE);
  });

  it("verifies with the backup key when it signed", async () => {
    const both = parseTrustedKeys(`${key.publicKey}, ${otherKey.publicKey}`);
    expect(await refusal(testPackage(otherKey, "1.0.0"), both)).toBe("accepted");
  });

  it("unpacks into a new folder with exactly the listed files", async () => {
    const target = join(dir, "unpacked-good");
    await unpackPackage(await save(testPackage(key, "1.0.0")), key.trusted, target);
    const files = await readdir(target, { recursive: true });
    expect(files).toContain(RELEASE_FILE);
    expect(files).not.toContain("oculus-update.json");
    expect(JSON.parse(await readFile(join(target, RELEASE_FILE), "utf8"))).toMatchObject({
      version: "1.0.0",
    });
    expect((await stat(join(target, RELEASE_FILE))).mode & 0o777).toBe(0o644);
  });
});

describe("signatures", () => {
  it("refuses a package signed by a key the server doesn't trust", async () => {
    expect(await refusal(testPackage(otherKey, "1.0.0"))).toBe("unknown_key");
  });

  it("refuses a manifest changed after signing (a file swapped in)", async () => {
    const files = releaseFiles("1.0.0");
    const manifest = manifestFor("1.0.0", files);
    const signed = Buffer.from(JSON.stringify(manifest));
    const evil = files.map((f) =>
      f.name === "packages/api/dist/admin-cli.js"
        ? { ...f, data: Buffer.from("process.exit(66)\n") }
        : f,
    );
    const changed = Buffer.from(JSON.stringify(manifestFor("1.0.0", evil)));
    const bytes = craftedPackage(key, undefined, evil, {
      manifestBytes: changed,
      signature: signManifest(signed, readSigningKey(key.pem)),
    });
    expect(await refusal(bytes)).toBe("bad_signature");
  });

  it("refuses a signature claiming a trusted key ID but made by another key", async () => {
    const files = releaseFiles("1.0.0");
    const bytes = Buffer.from(JSON.stringify(manifestFor("1.0.0", files)));
    const forged = JSON.parse(signManifest(bytes, readSigningKey(otherKey.pem)).toString()) as {
      signature: string;
    };
    const signature = Buffer.from(
      JSON.stringify({ keyId: key.keyId, signature: forged.signature }),
    );
    expect(
      await refusal(craftedPackage(key, undefined, files, { manifestBytes: bytes, signature })),
    ).toBe("bad_signature");
  });

  it.each([
    ["not JSON", "nope"],
    ["extra keys", JSON.stringify({ keyId: "0123456789abcdef", signature: "AA==", more: 1 })],
    ["a short signature", JSON.stringify({ keyId: "0123456789abcdef", signature: "AAAA" })],
    [
      "a non-canonical signature",
      JSON.stringify({ keyId: "0123456789abcdef", signature: `${"A".repeat(85)}B==` }),
    ],
    ["a bad key ID", JSON.stringify({ keyId: "../../etc", signature: "A".repeat(86) + "==" })],
  ])("refuses a signature file with %s", async (_what, text) => {
    const files = releaseFiles("1.0.0");
    expect(
      await refusal(
        craftedPackage(key, manifestFor("1.0.0", files), files, { signature: Buffer.from(text) }),
      ),
    ).toBe("bad_signature");
  });

  it("refuses a package with no manifest or no signature", async () => {
    const { writeZip } = await import("./update-zip.js");
    expect(await refusal(writeZip(releaseFiles("1.0.0")))).toBe("not_signed");
  });

  it("checks the signature before parsing the manifest", async () => {
    // A manifest that isn't even JSON, unsigned by a trusted key: refused for the key.
    const files = releaseFiles("1.0.0");
    const bytes = craftedPackage(otherKey, undefined, files, { manifestBytes: Buffer.from("{{{") });
    expect(await refusal(bytes)).toBe("unknown_key");
  });
});

describe("the files", () => {
  it("refuses a file the manifest doesn't list", async () => {
    const files = releaseFiles("1.0.0");
    const extra = [...files, { name: "packages/api/dist/backdoor.js", data: Buffer.from("x") }];
    expect(await refusal(craftedPackage(key, manifestFor("1.0.0", files), extra))).toBe(
      "unlisted_file",
    );
  });

  it("refuses a missing file", async () => {
    const files = releaseFiles("1.0.0");
    expect(await refusal(craftedPackage(key, manifestFor("1.0.0", files), files.slice(1)))).toBe(
      "missing_file",
    );
  });

  it("refuses a file whose bytes don't match its checksum", async () => {
    const files = releaseFiles("1.0.0");
    const manifest = manifestFor("1.0.0", files);
    const swapped = files.map((f) =>
      f.name === "packages/api/dist/admin-cli.js"
        ? { ...f, data: Buffer.from("// Oculus 6.6.6\n") }
        : f,
    );
    expect(await refusal(craftedPackage(key, manifest, swapped))).toBe("bad_checksum");
  });

  it("leaves nothing behind when unpacking fails part way", async () => {
    const files = releaseFiles("1.0.0");
    const manifest = manifestFor("1.0.0", files);
    const swapped = files.map((f, i) =>
      i === files.length - 1 ? { ...f, data: Buffer.from("-- 9999\n") } : f,
    );
    const target = join(dir, "unpacked-bad");
    await expect(
      unpackPackage(await save(craftedPackage(key, manifest, swapped)), key.trusted, target),
    ).rejects.toThrow(PackageError);
    expect((await readdir(dir)).filter((f) => f.startsWith("unpacked-bad"))).toEqual([]);
  });

  it("refuses to unpack over an existing folder", async () => {
    const target = join(dir, "unpacked-twice");
    const path = await save(testPackage(key, "1.0.0"));
    await unpackPackage(path, key.trusted, target);
    await expect(unpackPackage(path, key.trusted, target)).rejects.toThrow(PackageError);
  });
});

describe("the manifest", () => {
  const files = releaseFiles("1.0.0");
  const good = manifestFor("1.0.0", files);
  const signedRefusal = (manifest: unknown) => refusal(craftedPackage(key, manifest, files));

  it.each([
    ["another product", { ...good, product: "omeka" }],
    ["another format", { ...good, format: 2 }],
    ["a bad version", { ...good, version: "1.0" }],
    ["a pre-release version", { ...good, version: "1.0.0-beta" }],
    ["an extra key", { ...good, postInstall: "rm -rf /" }],
    ["a missing key", { ...good, notes: undefined }],
    ["long notes", { ...good, notes: "x".repeat(4001) }],
    ["a bad date", { ...good, builtAt: "yesterday" }],
    ["a wrong migrations list", { ...good, migrations: [] }],
    [
      "a traversing path",
      { ...good, files: [...good.files, { path: "../x", size: 0, sha256: "0".repeat(64) }] },
    ],
    [
      "a reserved path",
      {
        ...good,
        files: [...good.files, { path: "oculus-update.sig", size: 0, sha256: "0".repeat(64) }],
      },
    ],
    ["a bad checksum", { ...good, files: good.files.map((f) => ({ ...f, sha256: "XYZ" })) }],
    ["a negative size", { ...good, files: good.files.map((f) => ({ ...f, size: -1 })) }],
    ["no release file", { ...good, files: good.files.filter((f) => f.path !== RELEASE_FILE) }],
    ["not an object", [good]],
  ])("refuses %s", async (_what, manifest) => {
    expect(await signedRefusal(manifest)).toBe("bad_manifest");
  });

  it("refuses an object with an inherited prototype trick", () => {
    expect(() => checkManifest(JSON.parse(`{"__proto__":{"format":1}}`))).toThrow(PackageError);
  });
});

describe("keys and versions", () => {
  it("reads one or more trusted keys and refuses bad ones", () => {
    expect(parseTrustedKeys(`${key.publicKey} ${otherKey.publicKey}`)).toHaveLength(2);
    expect(parseTrustedKeys(`${key.publicKey},${key.publicKey}`)).toHaveLength(1);
    for (const text of ["", "rsa:abc", "ed25519:short", `ed25519:${"!".repeat(43)}`]) {
      expect(() => parseTrustedKeys(text)).toThrow(PackageError);
    }
  });

  it("refuses a signing key that isn't Ed25519", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => readSigningKey(privateKey.export({ format: "pem", type: "pkcs8" }))).toThrow(
      PackageError,
    );
    expect(() => readSigningKey("not a key")).toThrow(PackageError);
  });

  it("compares versions by number", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.3", "1.10.0")).toBeLessThan(0);
    expect(isVersion("01.0.0")).toBe(false);
    expect(isVersion("1.0.0")).toBe(true);
  });
});
