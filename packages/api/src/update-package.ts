/**
 * Signed update packages (T-060, D-092; PLATFORM_PLAN §9).
 *
 * A package is a ZIP (update-zip.ts) holding the whole built app plus two
 * control files at its root:
 *
 * - `oculus-update.json`, the manifest: `format` 1, `product` "oculus", the
 *   `version` (`MAJOR.MINOR.PATCH`), `builtAt`, short release `notes`, the
 *   database `migrations` it carries, and every other file with its size
 *   and SHA-256.
 * - `oculus-update.sig`: `{ keyId, signature }`, an Ed25519 signature
 *   (`node:crypto`) of the manifest's exact bytes.
 *
 * `verifyPackage` checks, in this order, and refuses at the first problem:
 * the ZIP's shape; the signature, by a key in the server's trusted list
 * (`OCULUS_UPDATE_KEYS`: the main key and a backup key), **before** the
 * manifest is even parsed; the manifest's shape; that the archive holds
 * exactly the manifest's files, no more and no fewer; and each file's size
 * and SHA-256. `unpackPackage` does all of that and writes the files into
 * a new folder, created for it, which is renamed into place only when
 * every file matched.
 *
 * The private key never reaches the server or the repository: the release
 * command (release-cli.ts) signs on the publisher's own computer.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_ZIP_LIMITS,
  ZipError,
  ZipReader,
  checkNameSet,
  zipNameProblem,
  type ZipEntry,
  type ZipLimits,
} from "./update-zip.js";

export const MANIFEST_NAME = "oculus-update.json";
export const SIGNATURE_NAME = "oculus-update.sig";
/** Written into every release's root by the release command; the version the code is. */
export const RELEASE_FILE = "oculus-release.json";
export const PACKAGE_FORMAT = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_NOTES = 4000;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const MIGRATION = /^packages\/db\/migrations\/(\d{4}_[a-z0-9_]+\.sql)$/;

/** A refused package; `code` is a fixed word the API and the screen show. */
export class PackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PackageError";
  }
}

export interface ManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface UpdateManifest {
  readonly format: 1;
  readonly product: "oculus";
  readonly version: string;
  readonly builtAt: string;
  readonly notes: string;
  /** The migration file names it carries (`0001_….sql`), sorted. */
  readonly migrations: readonly string[];
  readonly files: readonly ManifestFile[];
}

/** A trusted public key: its ID and the key. */
export interface TrustedKey {
  readonly keyId: string;
  readonly key: KeyObject;
}

/** What the screen shows about a verified package. */
export interface VerifiedPackage {
  readonly manifest: UpdateManifest;
  readonly keyId: string;
}

// ---------------------------------------------------------------- versions

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// -------------------------------------------------------------------- keys

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new PackageError("bad_key", "The key isn't an Ed25519 key.");
  }
  return Buffer.from(jwk.x, "base64url");
}

/** The key's ID: the first 16 hex digits of the SHA-256 of its 32 raw bytes. */
export function keyIdOf(key: KeyObject): string {
  return createHash("sha256").update(rawPublicKey(key)).digest("hex").slice(0, 16);
}

/** `ed25519:<base64url of the 32 raw bytes>`, the form `OCULUS_UPDATE_KEYS` lists. */
export function publicKeyText(key: KeyObject): string {
  return `ed25519:${rawPublicKey(key).toString("base64url")}`;
}

/**
 * Reads `OCULUS_UPDATE_KEYS`: one or more `ed25519:…` keys separated by
 * commas or spaces (the main key and a backup). Throws `PackageError` for
 * a malformed list; an empty list is refused too.
 */
export function parseTrustedKeys(text: string): readonly TrustedKey[] {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0 || parts.length > 8) {
    throw new PackageError("bad_key", "OCULUS_UPDATE_KEYS must list one to eight keys.");
  }
  const keys: TrustedKey[] = [];
  for (const part of parts) {
    const match = /^ed25519:([A-Za-z0-9_-]{43})$/.exec(part);
    const x = match?.[1];
    if (x === undefined || Buffer.from(x, "base64url").length !== 32) {
      throw new PackageError(
        "bad_key",
        "Each OCULUS_UPDATE_KEYS entry is ed25519: and 43 letters.",
      );
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    } catch {
      throw new PackageError("bad_key", "An OCULUS_UPDATE_KEYS entry isn't a usable key.");
    }
    const keyId = keyIdOf(key);
    if (!keys.some((k) => k.keyId === keyId)) keys.push({ keyId, key });
  }
  return keys;
}

/** A new signing key pair: the private key as PKCS#8 PEM, and the public key's text. */
export function generateSigningKey(): {
  readonly privateKeyPem: string;
  readonly publicKey: string;
  readonly keyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKey: publicKeyText(publicKey),
    keyId: keyIdOf(publicKey),
  };
}

/** Reads a PEM private key; throws `PackageError` unless it is Ed25519. */
export function readSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new PackageError("bad_key", "The signing key file can't be read.");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new PackageError("bad_key", "The signing key isn't an Ed25519 key.");
  }
  return key;
}

/** The manifest's bytes signed with `privateKey`: the `oculus-update.sig` file. */
export function signManifest(manifestBytes: Uint8Array, privateKey: KeyObject): Buffer {
  const publicKey = createPublicKey(privateKey);
  const signature = sign(null, manifestBytes, privateKey).toString("base64");
  return Buffer.from(JSON.stringify({ keyId: keyIdOf(publicKey), signature }) + "\n");
}

// ---------------------------------------------------------------- manifest

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function bad(message: string): never {
  throw new PackageError("bad_manifest", message);
}

/** Checks a parsed manifest's shape; returns a frozen copy. Throws `PackageError`. */
export function checkManifest(value: unknown): UpdateManifest {
  if (!plainObject(value)) bad("The manifest isn't an object.");
  const keys = ["format", "product", "version", "builtAt", "notes", "migrations", "files"];
  if (!exactKeys(value, keys)) bad(`The manifest has exactly these keys: ${keys.join(", ")}.`);
  if (value.format !== PACKAGE_FORMAT) bad("This package format isn't one Oculus can install.");
  if (value.product !== "oculus") bad("This package isn't for Oculus.");
  if (!isVersion(value.version)) bad("The version must be MAJOR.MINOR.PATCH.");
  if (typeof value.builtAt !== "string" || Number.isNaN(Date.parse(value.builtAt))) {
    bad("builtAt must be a date and time.");
  }
  if (typeof value.notes !== "string" || value.notes.length > MAX_NOTES) {
    bad(`The notes must be text of at most ${String(MAX_NOTES)} characters.`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) bad("The file list is empty.");
  const files: ManifestFile[] = [];
  for (const f of value.files as unknown[]) {
    if (!plainObject(f) || !exactKeys(f, ["path", "size", "sha256"])) {
      bad("Each file is path, size and sha256.");
    }
    const { path, size, sha256 } = f;
    if (typeof path !== "string" || zipNameProblem(path) !== undefined)
      bad("A file path is unsafe.");
    if (path === MANIFEST_NAME || path === SIGNATURE_NAME) bad("A file path is reserved.");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
      bad("A size is wrong.");
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) bad("A checksum is wrong.");
    files.push(Object.freeze({ path, size, sha256 }));
  }
  try {
    checkNameSet(files.map((f) => f.path));
  } catch {
    bad("Two files have the same path, or a file is another's folder.");
  }
  if (!files.some((f) => f.path === RELEASE_FILE)) bad(`The package has no ${RELEASE_FILE}.`);
  const migrations = migrationsIn(files.map((f) => f.path));
  if (
    !Array.isArray(value.migrations) ||
    value.migrations.length !== migrations.length ||
    value.migrations.some((m, i) => m !== migrations[i])
  ) {
    bad("The migrations list doesn't match the migration files.");
  }
  return Object.freeze({
    format: PACKAGE_FORMAT,
    product: "oculus",
    version: value.version,
    builtAt: value.builtAt,
    notes: value.notes,
    migrations: Object.freeze(migrations),
    files: Object.freeze(files),
  });
}

/** The migration file names among `paths`, sorted. */
export function migrationsIn(paths: readonly string[]): string[] {
  const names: string[] = [];
  for (const p of paths) {
    const m = MIGRATION.exec(p);
    if (m?.[1] !== undefined) names.push(m[1]);
  }
  return names.sort();
}

// ------------------------------------------------------------ verification

function signatureOf(bytes: Buffer): { keyId: string; signature: Buffer } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PackageError("bad_signature", "The signature file can't be read.");
  }
  if (
    !plainObject(parsed) ||
    !exactKeys(parsed, ["keyId", "signature"]) ||
    typeof parsed.keyId !== "string" ||
    !KEY_ID.test(parsed.keyId) ||
    typeof parsed.signature !== "string"
  ) {
    throw new PackageError("bad_signature", "The signature file can't be read.");
  }
  const signature = Buffer.from(parsed.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== parsed.signature) {
    throw new PackageError("bad_signature", "The signature file can't be read.");
  }
  return { keyId: parsed.keyId, signature };
}

function asPackageError(error: unknown): PackageError {
  if (error instanceof PackageError) return error;
  if (error instanceof ZipError) return new PackageError(`zip_${error.code}`, error.message);
  return new PackageError("unreadable", "The package can't be read.");
}

interface Opened {
  readonly zip: ZipReader;
  readonly verified: VerifiedPackage;
  readonly byName: ReadonlyMap<string, ZipEntry>;
}

/** The control files, the signature and the manifest; the files themselves come later. */
async function openVerified(
  path: string,
  trusted: readonly TrustedKey[],
  limits: ZipLimits,
): Promise<Opened> {
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(path, limits);
  } catch (error) {
    throw asPackageError(error);
  }
  try {
    const byName = new Map(zip.entries.map((e) => [e.name, e]));
    const manifestEntry = byName.get(MANIFEST_NAME);
    const signatureEntry = byName.get(SIGNATURE_NAME);
    if (manifestEntry === undefined || signatureEntry === undefined) {
      throw new PackageError("not_signed", "This isn't a signed Oculus update package.");
    }
    if (manifestEntry.size > MAX_MANIFEST_BYTES || signatureEntry.size > 1024) {
      throw new PackageError("bad_manifest", "The manifest is too large.");
    }
    const manifestBytes = await zip.read(manifestEntry);
    const { keyId, signature } = signatureOf(await zip.read(signatureEntry));
    const key = trusted.find((k) => k.keyId === keyId);
    if (key === undefined) {
      throw new PackageError(
        "unknown_key",
        "The package wasn't signed by a key this server trusts.",
      );
    }
    if (!verify(null, manifestBytes, key.key, signature)) {
      throw new PackageError("bad_signature", "The package's signature isn't valid.");
    }
    // Only now, with the bytes known to be the publisher's, is the manifest parsed.
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw new PackageError("bad_manifest", "The manifest can't be read.");
    }
    const manifest = checkManifest(parsed);
    const listed = new Set(manifest.files.map((f) => f.path));
    for (const name of byName.keys()) {
      if (name !== MANIFEST_NAME && name !== SIGNATURE_NAME && !listed.has(name)) {
        throw new PackageError(
          "unlisted_file",
          "The package holds a file its manifest doesn't list.",
        );
      }
    }
    for (const f of manifest.files) {
      const entry = byName.get(f.path);
      if (entry?.size !== f.size) {
        throw new PackageError(
          "missing_file",
          "A file the manifest lists is missing or the wrong size.",
        );
      }
    }
    return { zip, verified: Object.freeze({ manifest, keyId }), byName };
  } catch (error) {
    await zip.close();
    throw asPackageError(error);
  }
}

/** Every file's bytes, checked against the manifest's SHA-256, in manifest order. */
async function* checkedFiles(
  opened: Opened,
): AsyncGenerator<{ readonly file: ManifestFile; readonly data: Buffer }> {
  for (const file of opened.verified.manifest.files) {
    const entry = opened.byName.get(file.path);
    if (entry === undefined) throw new PackageError("missing_file", "A listed file is missing.");
    const data = await opened.zip.read(entry);
    if (createHash("sha256").update(data).digest("hex") !== file.sha256) {
      throw new PackageError("bad_checksum", "A file doesn't match the manifest's checksum.");
    }
    yield { file, data };
  }
}

/** Checks the whole package without writing anything. Throws `PackageError`. */
export async function verifyPackage(
  path: string,
  trusted: readonly TrustedKey[],
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<VerifiedPackage> {
  const opened = await openVerified(path, trusted, limits);
  try {
    // Each file is read and checked; nothing is kept.
    const files = checkedFiles(opened);
    let next = await files.next();
    while (next.done !== true) next = await files.next();
    return opened.verified;
  } catch (error) {
    throw asPackageError(error);
  } finally {
    await opened.zip.close();
  }
}

/**
 * Verifies the package and unpacks it into `target`, which must not exist
 * yet. Files go first into a new sibling folder (`<target>.partial-<n>`),
 * each created exclusively (never through an existing file or link), and
 * the folder is renamed to `target` only when every file has matched. On
 * any problem the partial folder is removed and `PackageError` thrown.
 */
export async function unpackPackage(
  path: string,
  trusted: readonly TrustedKey[],
  target: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<VerifiedPackage> {
  const opened = await openVerified(path, trusted, limits);
  const partial = `${target}.partial-${String(process.pid)}-${String(Date.now())}`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await mkdir(partial, { mode: 0o755 });
    for await (const { file, data } of checkedFiles(opened)) {
      const destination = join(partial, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      const handle = await open(destination, "wx", 0o644);
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
    }
    await rename(partial, target);
    return opened.verified;
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw asPackageError(error);
  } finally {
    await opened.zip.close();
  }
}

/** The SHA-256 of bytes, as lowercase hex. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
