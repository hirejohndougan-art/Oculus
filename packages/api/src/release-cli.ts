/**
 * `npm run release -- <command>` (after `npm run build`): makes and installs
 * signed update packages (T-060, D-092). Run `keygen` and `pack` on the
 * publisher's own computer; the private key never goes to the server or
 * into the repository.
 *
 * - `keygen --out <file>`: a new Ed25519 signing key (PKCS#8 PEM, readable
 *   by its owner only). Prints the public key for `OCULUS_UPDATE_KEYS` and
 *   its ID. Make two, a main key and a backup kept somewhere else, and list
 *   both on the server.
 * - `pack --key <file> --version <x.y.z> [--notes <text>] [--out <file>]`:
 *   the built app (every package's `dist`, the database migrations, the
 *   built admin and the production dependencies, nothing else) as one
 *   signed package, `oculus-<version>.zip` by default.
 * - `verify <package>`: checks a package against `OCULUS_UPDATE_KEYS`.
 * - `install <package> --dir <updates folder>`: the first install on a
 *   server (or one without the admin): verifies, unpacks, runs the
 *   migrations (`OCULUS_DATABASE_URL`) and points `current` at it. Later
 *   updates go through the admin's Updates screen.
 *
 * Relative paths are taken from where npm was run (INIT_CWD). Exit codes:
 * 0 done, 1 refused or failed, 2 usage.
 */
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase, type Database } from "@oculus/db";
import { updateChangeLog } from "./update-change-log.js";
import { UpdateManager, UpdateRefusal, UPDATE_KEYS_ENV } from "./update-manager.js";
import {
  MANIFEST_NAME,
  PACKAGE_FORMAT,
  PackageError,
  RELEASE_FILE,
  SIGNATURE_NAME,
  generateSigningKey,
  isVersion,
  migrationsIn,
  parseTrustedKeys,
  readSigningKey,
  sha256Hex,
  signManifest,
  verifyPackage,
  type UpdateManifest,
} from "./update-package.js";
import { writeZip, zipNameProblem, type ZipInput } from "./update-zip.js";

type Line = (line: string) => void;

/** The repository root, from this file (packages/api/dist or src). */
export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/** The workspace packages the server runs, and the admin's built files. */
const SERVER_PACKAGES = ["core", "db", "service", "api"] as const;

/** Every regular file under `dir` (relative, `/`-separated), skipping nested `node_modules`. */
async function walk(dir: string, root: string, skipNodeModules: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipNodeModules && entry.name === "node_modules") continue;
      out.push(...(await walk(full, root, skipNodeModules)));
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    } else {
      throw new Error(
        `${relative(root, full)} is a link or special file; packages hold files only.`,
      );
    }
  }
  return out;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

async function readJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}

/**
 * Where Node would find `name` from `from` (a package folder): the nearest
 * `node_modules/<name>` going up, but not above `root`. `undefined` if none.
 */
async function findDependency(
  name: string,
  from: string,
  root: string,
): Promise<string | undefined> {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (
      (await isDirectory(candidate)) ||
      (await lstat(candidate).catch(() => undefined))?.isSymbolicLink()
    ) {
      return candidate;
    }
    if (dir === root) return undefined;
    const up = dirname(dir);
    if (!up.startsWith(root)) return undefined;
    dir = up;
  }
}

/**
 * The production dependency folders of the server's packages, as paths
 * under `root` (`node_modules/...`), workspace packages excluded:
 * `dependencies` must be installed; optional and peer ones go in when they are.
 */
export async function productionDependencies(root: string): Promise<string[]> {
  const found = new Set<string>();
  const queue: string[] = SERVER_PACKAGES.map((p) => join(root, "packages", p));
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    const pkg = await readJson(join(dir, "package.json"));
    const wanted: [string, boolean][] = [
      ...Object.keys(pkg.dependencies ?? {}).map((n): [string, boolean] => [n, true]),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((n): [string, boolean] => [n, false]),
      ...Object.keys(pkg.peerDependencies ?? {}).map((n): [string, boolean] => [n, false]),
    ];
    for (const [name, required] of wanted) {
      if (name.startsWith("@oculus/")) continue;
      const at = await findDependency(name, dir, root);
      if (at === undefined) {
        if (required) throw new Error(`${name} isn't installed; run npm ci first.`);
        continue;
      }
      if ((await lstat(at)).isSymbolicLink()) {
        throw new Error(`${relative(root, at)} is a link; packages hold files only.`);
      }
      const rel = relative(root, at).split(sep).join("/");
      found.add(rel);
      if (!seen.has(at)) {
        seen.add(at);
        queue.push(at);
      }
    }
  }
  return [...found].sort();
}

/** The files of a release built from the repository at `root`, with the release file and root package.json for `version`. */
export async function collectRelease(
  root: string,
  version: string,
  builtAt: string,
): Promise<ZipInput[]> {
  const files = new Map<string, Uint8Array>();
  const add = async (path: string, from = path) => {
    files.set(path, await readFile(join(root, ...from.split("/"))));
  };
  for (const p of [...SERVER_PACKAGES, "admin"] as const) {
    const dist = join(root, "packages", p, "dist");
    if (!(await isDirectory(dist)))
      throw new Error(`packages/${p}/dist is missing; run npm run build first.`);
  }
  for (const name of ["LICENSE", "README.md"]) await add(name);
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  files.set(
    "package.json",
    Buffer.from(
      JSON.stringify(
        {
          name: rootPackage.name,
          private: true,
          version,
          description: rootPackage.description,
          license: rootPackage.license,
          type: rootPackage.type,
          engines: rootPackage.engines,
          scripts: {
            start: "node packages/api/dist/admin-cli.js",
            "db:migrate": "node packages/db/dist/migrate-cli.js",
            release: "node packages/api/dist/release-cli.js",
          },
        },
        null,
        2,
      ) + "\n",
    ),
  );
  files.set(RELEASE_FILE, Buffer.from(JSON.stringify({ version, builtAt }) + "\n"));
  /** A workspace package's runtime files, at `at` (its own folder and its node_modules copy). */
  const workspace = async (p: string, at: string) => {
    const base = join(root, "packages", p);
    files.set(`${at}/package.json`, await readFile(join(base, "package.json")));
    for (const f of await walk(join(base, "dist"), base, false)) {
      files.set(`${at}/${f}`, await readFile(join(base, f)));
    }
    if (p === "db") {
      for (const f of await walk(join(base, "migrations"), base, false)) {
        files.set(`${at}/${f}`, await readFile(join(base, f)));
      }
    }
  };
  for (const p of SERVER_PACKAGES) {
    await workspace(p, `packages/${p}`);
    // Node finds `@oculus/<p>` in node_modules; a copy, not npm's link.
    await workspace(p, `node_modules/@oculus/${p}`);
  }
  await workspace("admin", "packages/admin");
  for (const dep of await productionDependencies(root)) {
    for (const f of await walk(join(root, ...dep.split("/")), root, true)) await add(f);
  }
  const unsafe = [...files.keys()].filter((f) => zipNameProblem(f) !== undefined);
  if (unsafe.length > 0) {
    throw new Error(`These files can't go in a package: ${unsafe.slice(0, 5).join(", ")}`);
  }
  return [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, data]) => ({ name, data }));
}

/** The signed package's bytes: the files, the manifest and its signature. */
export function buildPackage(
  files: readonly ZipInput[],
  options: {
    readonly version: string;
    readonly builtAt: string;
    readonly notes: string;
    readonly key: string;
  },
): Buffer {
  const privateKey = readSigningKey(options.key);
  const manifest: UpdateManifest = {
    format: PACKAGE_FORMAT,
    product: "oculus",
    version: options.version,
    builtAt: options.builtAt,
    notes: options.notes,
    migrations: migrationsIn(files.map((f) => f.name)),
    files: files.map((f) => ({ path: f.name, size: f.data.length, sha256: sha256Hex(f.data) })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1) + "\n");
  return writeZip([
    { name: MANIFEST_NAME, data: manifestBytes },
    { name: SIGNATURE_NAME, data: signManifest(manifestBytes, privateKey) },
    ...files,
  ]);
}

function flags(args: readonly string[]): { positional: string[]; named: Map<string, string> } {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("--")) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a value.`);
      named.set(a.slice(2), value);
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, named };
}

const USAGE = [
  "Usage:",
  "  npm run release -- keygen --out <new key file>",
  "  npm run release -- pack --key <key file> --version <x.y.z> [--notes <text>] [--out <file>]",
  "  npm run release -- verify <package>",
  "  npm run release -- install <package> --dir <updates folder>",
].join("\n");

/** Runs the command; returns the exit code. */
export async function runReleaseCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Line,
  err: Line,
  root: string = REPO_ROOT,
): Promise<number> {
  const [command, ...rest] = args;
  let parsed: ReturnType<typeof flags>;
  try {
    parsed = flags(rest);
  } catch (error) {
    err((error as Error).message);
    err(USAGE);
    return 2;
  }
  const { positional, named } = parsed;
  const base = env.INIT_CWD !== undefined && env.INIT_CWD !== "" ? env.INIT_CWD : process.cwd();
  const at = (p: string) => resolve(base, p);
  const trusted = () => parseTrustedKeys(env[UPDATE_KEYS_ENV] ?? "");
  try {
    switch (command) {
      case "keygen": {
        const file = named.get("out");
        if (file === undefined || positional.length > 0) break;
        const key = generateSigningKey();
        await writeFile(at(file), key.privateKeyPem, { mode: 0o600, flag: "wx" });
        out(
          `Private key written to ${at(file)}. Keep it off the server and out of the repository.`,
        );
        out(`Public key (add to ${UPDATE_KEYS_ENV} on the server): ${key.publicKey}`);
        out(`Key ID: ${key.keyId}`);
        return 0;
      }
      case "pack": {
        const keyFile = named.get("key");
        const version = named.get("version");
        if (keyFile === undefined || version === undefined || positional.length > 0) break;
        if (!isVersion(version)) {
          err("The version must be MAJOR.MINOR.PATCH, e.g. 0.1.0.");
          return 2;
        }
        const builtAt = new Date().toISOString();
        const files = await collectRelease(root, version, builtAt);
        const zip = buildPackage(files, {
          version,
          builtAt,
          notes: named.get("notes") ?? "",
          key: await readFile(at(keyFile), "utf8"),
        });
        const file = at(named.get("out") ?? `oculus-${version}.zip`);
        await writeFile(file, zip, { flag: "wx" });
        out(
          `Wrote ${file}: Oculus ${version}, ${String(files.length)} files, ${String(zip.length)} bytes.`,
        );
        return 0;
      }
      case "verify": {
        const [file] = positional;
        if (file === undefined || positional.length !== 1) break;
        const verified = await verifyPackage(at(file), trusted());
        out(
          `Good: Oculus ${verified.manifest.version}, signed by key ${verified.keyId}, ${String(verified.manifest.files.length)} files.`,
        );
        return 0;
      }
      case "install": {
        const [file] = positional;
        const dir = named.get("dir");
        if (file === undefined || positional.length !== 1 || dir === undefined) break;
        const home = at(dir);
        if (env.OCULUS_DATABASE_URL === undefined || env.OCULUS_DATABASE_URL === "") {
          err("OCULUS_DATABASE_URL must name the database, connected as the owner of its tables.");
          return 2;
        }
        // The change log (T-060a): the install is written there once made,
        // as made on the server's command line.
        let db: Database | undefined;
        try {
          db = openDatabase(env.OCULUS_DATABASE_URL, {
            applicationName: "oculus-release",
            max: 1,
            // With the change log's lock and statement limits, closing never waits long.
            connectionTimeoutMillis: 10_000,
          });
        } catch {
          db = undefined;
        }
        // Changed by the log callback, so kept in an object the compiler doesn't narrow.
        const changeLog = { failed: false };
        const manager = new UpdateManager({
          home,
          keys: trusted(),
          runningRoot: join(home, "current"),
          backups: env.OCULUS_UPDATE_BACKUP !== "skip",
          ...(db === undefined ? {} : { changeLog: updateChangeLog(db, "command_line") }),
          log: (event) => {
            if (event === "update_change_log_failed") changeLog.failed = true;
          },
        });
        try {
          const version = await manager.verifyInto(at(file));
          out(`Verified Oculus ${version}.`);
          const role = env.OCULUS_UPDATE_WRITER_ROLE;
          await manager.install(
            version,
            "release-cli",
            (step) => {
              out(`- ${step}`);
            },
            {
              requireRunningFromCurrent: false,
              fallbackUrl: env.OCULUS_UPDATE_MIGRATE_DATABASE_URL ?? env.OCULUS_DATABASE_URL,
              ...(role === undefined || role === "" ? {} : { fallbackWriterRole: role }),
            },
          );
          if (role === undefined || role === "") {
            out(
              "Note: OCULUS_UPDATE_WRITER_ROLE isn't set, so no role was given rights to new tables.",
            );
          }
        } finally {
          await db?.close();
        }
        if (db === undefined || changeLog.failed) {
          out("Note: the install couldn't be written into the change log (the audit trail).");
        }
        out(
          `Installed. Start command: node ${join(home, "current", "packages", "api", "dist", "admin-cli.js")}`,
        );
        return 0;
      }
      default:
        break;
    }
    err(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof PackageError || error instanceof UpdateRefusal) {
      err(`Refused (${error.code}): ${error.message}`);
    } else {
      err(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return 1;
  }
}

// Through a link too: the host starts `<updates folder>/current/…` (T-060), and
// Node gives this module its real path.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exitCode = await runReleaseCli(
    process.argv.slice(2),
    process.env,
    (line) => {
      console.log(line);
    },
    (line) => {
      console.error(line);
    },
  );
}
