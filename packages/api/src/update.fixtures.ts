// Test-only: signing keys and small invented release packages (T-060).
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage } from "./release-cli.js";
import {
  MANIFEST_NAME,
  RELEASE_FILE,
  SIGNATURE_NAME,
  generateSigningKey,
  migrationsIn,
  parseTrustedKeys,
  readSigningKey,
  sha256Hex,
  signManifest,
  type TrustedKey,
} from "./update-package.js";
import { writeZip, type ZipInput } from "./update-zip.js";

export interface TestKey {
  readonly pem: string;
  readonly publicKey: string;
  readonly keyId: string;
  readonly trusted: readonly TrustedKey[];
}

export function testKey(): TestKey {
  const k = generateSigningKey();
  return {
    pem: k.privateKeyPem,
    publicKey: k.publicKey,
    keyId: k.keyId,
    trusted: parseTrustedKeys(k.publicKey),
  };
}

export const BUILT_AT = "2026-11-24T12:00:00.000Z";

/** The files of an invented release: a release file, a script and the given migrations. */
export function releaseFiles(
  version: string,
  migrations: readonly string[] = ["0001_start.sql"],
): ZipInput[] {
  const files: ZipInput[] = [
    {
      name: RELEASE_FILE,
      data: Buffer.from(JSON.stringify({ version, builtAt: BUILT_AT }) + "\n"),
    },
    { name: "packages/api/dist/admin-cli.js", data: Buffer.from(`// Oculus ${version}\n`) },
    { name: "packages/db/dist/migrate-cli.js", data: Buffer.from("// migrate\n") },
    { name: "packages/db/dist/backup-cli.js", data: Buffer.from("// backup\n") },
    ...migrations.map((m) => ({
      name: `packages/db/migrations/${m}`,
      data: Buffer.from(`-- ${m}\n`),
    })),
  ];
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** A signed package's bytes. */
export function testPackage(
  key: TestKey,
  version: string,
  migrations?: readonly string[],
  notes = "Invented test release.",
): Buffer {
  return buildPackage(releaseFiles(version, migrations), {
    version,
    builtAt: BUILT_AT,
    notes,
    key: key.pem,
  });
}

/** A package with a hand-made manifest (signed by `key`) and the given archive files. */
export function craftedPackage(
  key: TestKey,
  manifest: unknown,
  files: readonly ZipInput[],
  options: { readonly signature?: Buffer; readonly manifestBytes?: Buffer } = {},
): Buffer {
  const manifestBytes = options.manifestBytes ?? Buffer.from(JSON.stringify(manifest));
  return writeZip([
    { name: MANIFEST_NAME, data: manifestBytes },
    {
      name: SIGNATURE_NAME,
      data: options.signature ?? signManifest(manifestBytes, readSigningKey(key.pem)),
    },
    ...files,
  ]);
}

/** The manifest the release command would write for `files`. */
export function manifestFor(version: string, files: readonly ZipInput[]) {
  return {
    format: 1,
    product: "oculus",
    version,
    builtAt: BUILT_AT,
    notes: "",
    migrations: migrationsIn(files.map((f) => f.name)),
    files: files.map((f) => ({ path: f.name, size: f.data.length, sha256: sha256Hex(f.data) })),
  };
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `oculus-${prefix}-`));
}

export async function writeTemp(dir: string, name: string, data: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}
