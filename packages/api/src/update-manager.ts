/**
 * Installing updates on the server (T-060, D-092): the folder layout, the
 * upload of a package in parts, its verification, the install and the
 * rollback. Who may do any of it is the service's decision (people.ts
 * `authorizeSystemUpdate`); this module only does the work.
 *
 * The updates folder (`OCULUS_UPDATE_DIR`):
 *
 * ```
 * releases/<version>/   one unpacked, verified release per folder
 * current               a link to the running release's folder
 * uploads/              a package while its parts arrive (one at a time)
 * backups/              database backups taken before an update with migrations
 * state.json            the waiting package and the install history
 * ```
 *
 * The host's start command runs `<updates folder>/current/packages/api/dist/admin-cli.js`.
 * An install never changes the running release's files: it unpacks the new
 * release beside it, backs up the database when the release brings new
 * migrations (unless `OCULUS_UPDATE_BACKUP=skip`), runs the new release's
 * migrations, then swaps `current` in one rename and asks for a restart
 * (`OCULUS_UPDATE_RESTART`: `exit` ends the process for the host's process
 * manager to start again; `none`, the default, leaves the restart to a
 * person). A failure before the swap leaves the running release current.
 *
 * Rolling back points `current` at the release that was running before the
 * last install, only when both carry the same migrations: a database
 * already changed by newer migrations is restored from the backup instead.
 *
 * Only one job (verifying, installing, rolling back) runs at a time, and a
 * lock file keeps the release command (release-cli.ts) and the server from
 * working on the folder together.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PackageError,
  RELEASE_FILE,
  compareVersions,
  isVersion,
  migrationsIn,
  parseTrustedKeys,
  unpackPackage,
  type TrustedKey,
  type UpdateManifest,
} from "./update-package.js";
import { DEFAULT_ZIP_LIMITS } from "./update-zip.js";

export const UPDATE_DIR_ENV = "OCULUS_UPDATE_DIR";
export const UPDATE_KEYS_ENV = "OCULUS_UPDATE_KEYS";
export const UPDATE_RESTART_ENV = "OCULUS_UPDATE_RESTART";
export const UPDATE_BACKUP_ENV = "OCULUS_UPDATE_BACKUP";
/**
 * The database URL of the tables' owner (the migrating role, D-057), given
 * only to the backup, migration and grant steps, never used by the app
 * itself (D-063: the app must never connect as the owner). Without it, a
 * release that brings migrations is refused from the web and installed with
 * `npm run release -- install` instead.
 */
export const UPDATE_MIGRATE_URL_ENV = "OCULUS_UPDATE_MIGRATE_DATABASE_URL";
/** The writer role re-granted after migrations, so new tables get its privileges. */
export const UPDATE_WRITER_ROLE_ENV = "OCULUS_UPDATE_WRITER_ROLE";

/** Raw bytes per uploaded part: well under the API's 1 MiB body limit once in base64. */
export const UPLOAD_PART_BYTES = 512 * 1024;
/** An upload untouched this long is dropped. */
const UPLOAD_IDLE_MS = 60 * 60 * 1000;
/** How long the change log's row may take after a switch (T-060a). */
export const CHANGE_LOG_TIMEOUT_MS = 15_000;

/** Releases kept besides the current one, the rollback target and the waiting one. */
const KEEP_RELEASES = 3;
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const HISTORY_LIMIT = 50;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const KEEP_BACKUPS = 5;
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The running code's own root: three folders above this file (packages/api/dist). */
export const RUNNING_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

export type RestartMode = "exit" | "none";

/** A refusal the API answers with a fixed code (update-api.ts). */
export class UpdateRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpdateRefusal";
  }
}

export interface HistoryEntry {
  readonly kind: "install" | "rollback";
  readonly version: string;
  /** The version that was current before; `null` for a development build. */
  readonly from: string | null;
  readonly at: string;
  /** The system manager who asked (a user ID, never a name). */
  readonly by: string;
}

interface StoredState {
  readonly pending: string | null;
  readonly history: readonly HistoryEntry[];
}

export interface JobStatus {
  readonly kind: "verify" | "install" | "rollback";
  readonly state: "running" | "failed" | "done";
  readonly step: string;
  readonly version?: string;
  /** A fixed code when it failed. */
  readonly error?: string;
  readonly message?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
}

export interface PendingRelease {
  readonly version: string;
  readonly builtAt: string;
  readonly notes: string;
  readonly keyId: string;
  readonly files: number;
  readonly bytes: number;
  /** Migrations the running release doesn't have. */
  readonly newMigrations: readonly string[];
}

export interface UpdateStatus {
  readonly configured: true;
  /** The running code's version; `null` for a development build. */
  readonly runningVersion: string | null;
  readonly runningFromCurrent: boolean;
  readonly startCommand: string;
  readonly restart: RestartMode;
  readonly backups: boolean;
  /** Whether releases with database changes can be installed from the web (owner URL and writer role set). */
  readonly migrationsFromWeb: boolean;
  readonly partBytes: number;
  readonly maxPackageBytes: number;
  readonly upload: {
    readonly uploadId: string;
    readonly size: number;
    readonly received: number;
  } | null;
  readonly pending: PendingRelease | null;
  readonly job: JobStatus | null;
  readonly restartNeeded: boolean;
  readonly rollback: { readonly version: string; readonly allowed: boolean } | null;
  readonly history: readonly HistoryEntry[];
}

/** Runs one Node script of a release; resolves with its exit code. */
export type RunScript = (
  script: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
) => Promise<{ readonly code: number; readonly output: string }>;

export interface UpdateManagerOptions {
  readonly home: string;
  readonly keys: readonly TrustedKey[];
  readonly restart?: RestartMode;
  /** Back up the database before migrations (default true). */
  readonly backups?: boolean;
  /** `OCULUS_UPDATE_MIGRATE_DATABASE_URL`: the owner's URL for backup, migrations and grants. */
  readonly migrateUrl?: string;
  /** `OCULUS_UPDATE_WRITER_ROLE`: granted the writer's privileges after migrations. */
  readonly writerRole?: string;
  /** The running code's root (default `RUNNING_ROOT`). */
  readonly runningRoot?: string;
  /** Asked for when `restart` is `exit`, after an install or rollback. */
  readonly requestRestart?: () => void;
  readonly runScript?: RunScript;
  readonly clock?: () => number;
  readonly maxPackageBytes?: number;
  /** For logs: called with a fixed event and code, never a path or a secret. */
  readonly log?: (event: string, fields: Readonly<Record<string, string>>) => void;
  /**
   * Writes an install or rollback into the change log (T-060a, D-104), once
   * the switch is made. A failure can't undo the switch, so it is logged
   * (`update_change_log_failed`), never reported as the job's failure.
   */
  readonly changeLog?: (entry: HistoryEntry) => Promise<void>;
  /** How long the change log's row may take (default `CHANGE_LOG_TIMEOUT_MS`; tests). */
  readonly changeLogTimeoutMs?: number;
}

/** A Node child process with the server's environment, its output kept (capped) for the log. */
export const defaultRunScript: RunScript = (script, args, cwd, env) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      if (output.length < 20_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), STEP_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      done({ code: -1, output });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, output });
    });
  });

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The version a release folder says it is, or `null`. */
export async function releaseVersion(root: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, RELEASE_FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const v = parsed.version;
      return isVersion(v) ? v : null;
    }
  } catch {
    // A development build has no release file.
  }
  return null;
}

async function migrationsOf(root: string): Promise<string[]> {
  try {
    const names = await readdir(join(root, "packages", "db", "migrations"));
    return migrationsIn(names.map((n) => `packages/db/migrations/${n}`));
  } catch {
    return [];
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Builds the manager from the environment, or `undefined` when updates
 * aren't set up (`OCULUS_UPDATE_DIR` unset). Throws, naming the variable but
 * never its value, for a malformed setting.
 */
export function updateManagerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  extra: Omit<
    UpdateManagerOptions,
    "home" | "keys" | "restart" | "backups" | "migrateUrl" | "writerRole"
  > = {},
): UpdateManager | undefined {
  const home = env[UPDATE_DIR_ENV]?.trim();
  if (home === undefined || home === "") return undefined;
  if (!home.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(home)) {
    throw new Error(`${UPDATE_DIR_ENV} must be an absolute path.`);
  }
  let keys: readonly TrustedKey[];
  try {
    keys = parseTrustedKeys(env[UPDATE_KEYS_ENV] ?? "");
  } catch {
    throw new Error(`${UPDATE_KEYS_ENV} must list the update signing keys (ed25519:…).`);
  }
  const restartText = env[UPDATE_RESTART_ENV]?.trim() ?? "none";
  if (restartText !== "exit" && restartText !== "none") {
    throw new Error(`${UPDATE_RESTART_ENV} must be exit or none.`);
  }
  const backupText = env[UPDATE_BACKUP_ENV]?.trim() ?? "";
  if (backupText !== "" && backupText !== "skip" && backupText !== "on") {
    throw new Error(`${UPDATE_BACKUP_ENV} must be on or skip.`);
  }
  const migrateUrl = env[UPDATE_MIGRATE_URL_ENV]?.trim() ?? "";
  const writerRole = env[UPDATE_WRITER_ROLE_ENV]?.trim() ?? "";
  if (writerRole !== "" && !ROLE_NAME.test(writerRole)) {
    throw new Error(`${UPDATE_WRITER_ROLE_ENV} must be a role name (lower case, digits and _).`);
  }
  if ((migrateUrl === "") !== (writerRole === "")) {
    throw new Error(`${UPDATE_MIGRATE_URL_ENV} and ${UPDATE_WRITER_ROLE_ENV} go together.`);
  }
  return new UpdateManager({
    ...extra,
    home,
    keys,
    restart: restartText,
    backups: backupText !== "skip",
    ...(migrateUrl === "" ? {} : { migrateUrl, writerRole }),
  });
}

interface Upload {
  readonly uploadId: string;
  readonly size: number;
  received: number;
  nextPart: number;
  touchedAt: number;
  writing: boolean;
}

export class UpdateManager {
  readonly home: string;
  private readonly keys: readonly TrustedKey[];
  readonly restart: RestartMode;
  readonly backups: boolean;
  private readonly migrateUrl: string | undefined;
  private readonly writerRole: string | undefined;
  private readonly runningRoot: string;
  private readonly runScript: RunScript;
  private readonly clock: () => number;
  private readonly requestRestart: (() => void) | undefined;
  private readonly changeLog: ((entry: HistoryEntry) => Promise<void>) | undefined;
  private readonly changeLogTimeoutMs: number;
  readonly maxPackageBytes: number;
  private readonly log: (event: string, fields: Readonly<Record<string, string>>) => void;
  private upload: Upload | undefined;
  private job: JobStatus | undefined;
  /** Set once an install or rollback has swapped `current` in this process. */
  private swapped = false;
  private working: Promise<void> | undefined;

  constructor(options: UpdateManagerOptions) {
    this.home = resolve(options.home);
    this.keys = options.keys;
    this.restart = options.restart ?? "none";
    this.backups = options.backups ?? true;
    this.migrateUrl = options.migrateUrl;
    this.writerRole = options.writerRole;
    this.runningRoot = options.runningRoot ?? RUNNING_ROOT;
    this.runScript = options.runScript ?? defaultRunScript;
    this.clock = options.clock ?? Date.now;
    this.requestRestart = options.requestRestart;
    this.changeLog = options.changeLog;
    this.changeLogTimeoutMs = options.changeLogTimeoutMs ?? CHANGE_LOG_TIMEOUT_MS;
    this.maxPackageBytes = options.maxPackageBytes ?? DEFAULT_ZIP_LIMITS.maxFileBytes;
    this.log =
      options.log ??
      (() => {
        // No log by default.
      });
  }

  private path(...parts: string[]): string {
    return join(this.home, ...parts);
  }

  private releasePath(version: string): string {
    return this.path("releases", version);
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  // ------------------------------------------------------------- state file

  private async readState(): Promise<StoredState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path("state.json"), "utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("bad state");
      const p = parsed as { pending?: unknown; history?: unknown };
      const pending = isVersion(p.pending) ? p.pending : null;
      const history = Array.isArray(p.history)
        ? (p.history as unknown[]).filter(isHistoryEntry).slice(-HISTORY_LIMIT)
        : [];
      return { pending, history };
    } catch {
      return { pending: null, history: [] };
    }
  }

  private async writeState(state: StoredState): Promise<void> {
    await mkdir(this.home, { recursive: true });
    const temp = this.path(`state.json.${randomBytes(6).toString("hex")}`);
    await writeFile(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, this.path("state.json"));
  }

  // ---------------------------------------------------------- the folders

  /** Where `current` points, resolved; `undefined` when there is no link. */
  private async currentTarget(): Promise<string | undefined> {
    try {
      await readlink(this.path("current"));
      return await realpath(this.path("current"));
    } catch {
      return undefined;
    }
  }

  private async runningFromCurrent(): Promise<boolean> {
    const current = await this.currentTarget();
    if (current === undefined) return false;
    try {
      return (await realpath(this.runningRoot)) === current;
    } catch {
      return false;
    }
  }

  /** Points `current` at a release folder in one rename. */
  private async swapCurrent(version: string): Promise<void> {
    const temp = this.path(`current.${randomBytes(6).toString("hex")}`);
    await symlink(join("releases", version), temp, "dir");
    try {
      await rename(temp, this.path("current"));
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /**
   * A lock file for the folder, shared with the release command. It appears
   * whole (written under a temporary name, then hard-linked into place, which
   * fails if a lock exists), holds this process's ID and a random token, and
   * is removed only by its holder. A lock whose process is gone is taken over.
   */
  private async lock(): Promise<() => Promise<void>> {
    await mkdir(this.home, { recursive: true });
    const file = this.path("update.lock");
    const token = randomBytes(12).toString("hex");
    const text = `${String(process.pid)} ${token}`;
    const temp = this.path(`update.lock.${token}`);
    await writeFile(temp, text, { mode: 0o600, flag: "wx" });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await link(temp, file);
          return async () => {
            const now = await readFile(file, "utf8").catch(() => "");
            if (now === text) await rm(file, { force: true });
          };
        } catch {
          const held = await readFile(file, "utf8").catch(() => "");
          const pid = Number(held.split(" ")[0]);
          let alive = true;
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              // EPERM: the process exists but belongs to someone else.
              alive = (error as { code?: unknown }).code === "EPERM";
            }
          }
          if (alive) throw new UpdateRefusal("busy", 409, "Another update is in progress.");
          if ((await readFile(file, "utf8").catch(() => "")) === held) {
            await rm(file, { force: true });
          }
        }
      }
      throw new UpdateRefusal("busy", 409, "Another update is in progress.");
    } finally {
      await rm(temp, { force: true });
    }
  }

  // ---------------------------------------------------------------- status

  private dropIdleUpload(): void {
    if (this.upload !== undefined && this.clock() - this.upload.touchedAt > UPLOAD_IDLE_MS) {
      const id = this.upload.uploadId;
      this.upload = undefined;
      void rm(this.uploadFile(id), { force: true });
    }
  }

  private uploadFile(id: string): string {
    return this.path("uploads", `${id}.zip`);
  }

  private async pendingRelease(version: string): Promise<PendingRelease | undefined> {
    const root = this.releasePath(version);
    try {
      const summary: unknown = JSON.parse(await readFile(`${root}.verified.json`, "utf8"));
      if (!isPendingSummary(summary) || summary.version !== version) return undefined;
      const running = await migrationsOf(this.runningRoot);
      const theirs = await migrationsOf(root);
      return Object.freeze({
        ...summary,
        newMigrations: theirs.filter((m) => !running.includes(m)),
      });
    } catch {
      return undefined;
    }
  }

  /** The release to roll back to: the one current before the last install, if still on disk. */
  private async rollbackTarget(
    state: StoredState,
  ): Promise<{ version: string; allowed: boolean } | null> {
    const last = state.history.at(-1);
    if (last?.kind !== "install" || last.from === null) return null;
    if (!(await exists(this.releasePath(last.from)))) return null;
    const current = await this.currentTarget();
    if (current === undefined) return null;
    const allowed = sameList(
      await migrationsOf(current),
      await migrationsOf(this.releasePath(last.from)),
    );
    return { version: last.from, allowed };
  }

  async status(): Promise<UpdateStatus> {
    this.dropIdleUpload();
    const state = await this.readState();
    const pending = state.pending === null ? undefined : await this.pendingRelease(state.pending);
    return {
      configured: true,
      runningVersion: await releaseVersion(this.runningRoot),
      runningFromCurrent: await this.runningFromCurrent(),
      startCommand: `node ${join(this.home, "current", "packages", "api", "dist", "admin-cli.js")}`,
      restart: this.restart,
      backups: this.backups,
      migrationsFromWeb: this.migrateUrl !== undefined && this.writerRole !== undefined,
      partBytes: UPLOAD_PART_BYTES,
      maxPackageBytes: this.maxPackageBytes,
      upload:
        this.upload === undefined
          ? null
          : {
              uploadId: this.upload.uploadId,
              size: this.upload.size,
              received: this.upload.received,
            },
      pending: pending ?? null,
      job: this.job ?? null,
      restartNeeded: this.swapped,
      rollback: await this.rollbackTarget(state),
      history: [...state.history].reverse(),
    };
  }

  private assertIdle(): void {
    if (this.job?.state === "running") {
      throw new UpdateRefusal("busy", 409, "Wait until the current step has finished.");
    }
  }

  // --------------------------------------------------------------- uploads

  /** Starts an upload of `size` bytes; drops any earlier one. */
  async startUpload(
    size: unknown,
  ): Promise<{ readonly uploadId: string; readonly partBytes: number }> {
    this.assertIdle();
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 22) {
      throw new UpdateRefusal("invalid_size", 422, "Give the package's size in bytes.");
    }
    if (size > this.maxPackageBytes) {
      throw new UpdateRefusal("too_large", 413, "The package is larger than Oculus accepts.");
    }
    if (this.upload !== undefined) {
      await rm(this.uploadFile(this.upload.uploadId), { force: true });
      this.upload = undefined;
    }
    await mkdir(this.path("uploads"), { recursive: true, mode: 0o700 });
    // Leftovers from a stopped server.
    for (const name of await readdir(this.path("uploads"))) {
      await rm(this.path("uploads", name), { force: true, recursive: true });
    }
    const uploadId = randomBytes(16).toString("hex");
    const handle = await open(this.uploadFile(uploadId), "wx", 0o600);
    await handle.close();
    this.upload = {
      uploadId,
      size,
      received: 0,
      nextPart: 0,
      touchedAt: this.clock(),
      writing: false,
    };
    return { uploadId, partBytes: UPLOAD_PART_BYTES };
  }

  private uploadFor(uploadId: unknown): Upload {
    this.dropIdleUpload();
    if (
      typeof uploadId !== "string" ||
      !UPLOAD_ID.test(uploadId) ||
      this.upload?.uploadId !== uploadId
    ) {
      throw new UpdateRefusal("unknown_upload", 404, "That upload isn't in progress. Start again.");
    }
    return this.upload;
  }

  /** Adds part `index` (0, 1, 2…, in order); every part but the last is exactly `UPLOAD_PART_BYTES`. */
  async addPart(
    uploadId: unknown,
    index: unknown,
    data: Buffer,
  ): Promise<{ readonly received: number }> {
    this.assertIdle();
    const upload = this.uploadFor(uploadId);
    if (upload.writing) throw new UpdateRefusal("busy", 409, "Send one part at a time.");
    if (index !== upload.nextPart) {
      throw new UpdateRefusal("wrong_part", 409, "Parts must arrive in order.");
    }
    const left = upload.size - upload.received;
    const expected = Math.min(UPLOAD_PART_BYTES, left);
    if (expected === 0 || data.length !== expected) {
      throw new UpdateRefusal("wrong_part_size", 422, "That part isn't the expected size.");
    }
    upload.writing = true;
    try {
      const handle = await open(this.uploadFile(upload.uploadId), "r+");
      try {
        await handle.write(data, 0, data.length, upload.received);
      } finally {
        await handle.close();
      }
      upload.received += data.length;
      upload.nextPart++;
    } finally {
      upload.writing = false;
    }
    upload.touchedAt = this.clock();
    return { received: upload.received };
  }

  /** Stops the upload and removes its bytes. */
  async cancelUpload(uploadId: unknown): Promise<void> {
    this.assertIdle();
    const upload = this.uploadFor(uploadId);
    this.upload = undefined;
    await rm(this.uploadFile(upload.uploadId), { force: true });
  }

  /** All parts are in: starts checking the package (a background job; poll `status`). */
  finishUpload(uploadId: unknown): void {
    this.assertIdle();
    const upload = this.uploadFor(uploadId);
    if (upload.writing) throw new UpdateRefusal("busy", 409, "A part is still being written.");
    if (upload.received !== upload.size) {
      throw new UpdateRefusal("incomplete", 409, "Not every part has arrived yet.");
    }
    this.upload = undefined;
    this.startJob("verify", undefined, async (step) => {
      const file = this.uploadFile(upload.uploadId);
      try {
        await this.verifyInto(file, step);
      } finally {
        await rm(file, { force: true });
      }
    });
  }

  /** Verifies a package file and unpacks it as the waiting release (also used by release-cli.ts). */
  async verifyInto(file: string, step: (name: string) => void = () => undefined): Promise<string> {
    const unlock = await this.lock();
    try {
      await this.removeLeftovers();
      step("checking");
      const incoming = this.path("releases", `.incoming-${randomBytes(6).toString("hex")}`);
      let verified;
      try {
        verified = await unpackPackage(file, this.keys, incoming, {
          ...DEFAULT_ZIP_LIMITS,
          maxFileBytes: this.maxPackageBytes,
        });
      } catch (error) {
        if (error instanceof PackageError) {
          throw new UpdateRefusal(error.code, 422, error.message);
        }
        throw error;
      }
      const { manifest, keyId } = verified;
      try {
        step("placing");
        const running = await releaseVersion(this.runningRoot);
        if (running !== null && compareVersions(manifest.version, running) <= 0) {
          throw new UpdateRefusal(
            "not_newer",
            409,
            `This package is version ${manifest.version}; Oculus ${running} is running. Only newer versions can be installed.`,
          );
        }
        if ((await releaseVersion(incoming)) !== manifest.version) {
          throw new UpdateRefusal(
            "bad_manifest",
            422,
            "The release file disagrees with the manifest's version.",
          );
        }
        const target = this.releasePath(manifest.version);
        const current = await this.currentTarget();
        if (await exists(target)) {
          if (current !== undefined && (await realpath(target)) === current) {
            throw new UpdateRefusal("already_current", 409, "That version is already installed.");
          }
          await rm(target, { recursive: true, force: true });
        }
        await rename(incoming, target);
        await writeFile(
          `${target}.verified.json`,
          JSON.stringify(summaryOf(manifest, keyId)) + "\n",
          {
            mode: 0o600,
          },
        );
      } catch (error) {
        await rm(incoming, { recursive: true, force: true });
        throw error;
      }
      const state = await this.readState();
      if (state.pending !== null && state.pending !== manifest.version) {
        await this.removeRelease(state.pending, state);
      }
      await this.writeState({ ...state, pending: manifest.version });
      this.log("update_verified", { version: manifest.version, keyId });
      return manifest.version;
    } finally {
      await unlock();
    }
  }

  /** Half-unpacked folders left by a stopped server or command. */
  private async removeLeftovers(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.path("releases"));
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".incoming-") || name.includes(".partial-")) {
        await rm(this.path("releases", name), { recursive: true, force: true });
      }
    }
  }

  /** Keeps a step's output where only the server's own user can read it; returns the file's name. */
  private async keepOutput(stepName: string, version: string, output: string): Promise<string> {
    await mkdir(this.path("logs"), { recursive: true, mode: 0o700 });
    const name = `${stepName}-${version}-${this.now().replace(/[:.]/g, "-")}.log`;
    await writeFile(this.path("logs", name), output, { mode: 0o600 });
    return name;
  }

  /** Removes the waiting release (not installed). */
  async discardPending(): Promise<void> {
    this.assertIdle();
    const unlock = await this.lock();
    try {
      const state = await this.readState();
      if (state.pending === null)
        throw new UpdateRefusal("nothing_pending", 409, "No update is waiting.");
      await this.removeRelease(state.pending, state);
      await this.writeState({ ...state, pending: null });
    } finally {
      await unlock();
    }
  }

  private async removeRelease(version: string, state: StoredState): Promise<void> {
    const target = this.releasePath(version);
    const current = await this.currentTarget();
    if (current !== undefined && (await exists(target)) && (await realpath(target)) === current)
      return;
    const rollback = await this.rollbackTarget(state);
    if (rollback?.version === version) return;
    await rm(target, { recursive: true, force: true });
    await rm(`${target}.verified.json`, { force: true });
  }

  // -------------------------------------------------------- install, rollback

  /** Starts installing the waiting release `version` (a background job). */
  startInstall(version: unknown, by: string): void {
    this.assertIdle();
    if (!isVersion(version))
      throw new UpdateRefusal("invalid_version", 422, "Name the version to install.");
    this.startJob("install", version, (step) => this.install(version, by, step));
  }

  /** Starts rolling back to `version`, the release before the last install. */
  startRollback(version: unknown, by: string): void {
    this.assertIdle();
    if (!isVersion(version))
      throw new UpdateRefusal("invalid_version", 422, "Name the version to go back to.");
    this.startJob("rollback", version, (step) => this.rollback(version, by, step));
  }

  /** Installs the waiting release (the server's job; release-cli.ts calls it directly). */
  async install(
    version: string,
    by: string,
    step: (name: string) => void = () => undefined,
    options: {
      readonly requireRunningFromCurrent?: boolean;
      /** The release command only: the owner's URL when the owner variable isn't set. */
      readonly fallbackUrl?: string;
      readonly fallbackWriterRole?: string;
    } = {},
  ): Promise<void> {
    const unlock = await this.lock();
    try {
      const state = await this.readState();
      if (state.pending !== version) {
        throw new UpdateRefusal(
          "not_pending",
          409,
          "That version isn't the update waiting to be installed.",
        );
      }
      const pending = await this.pendingRelease(version);
      if (pending === undefined) {
        throw new UpdateRefusal(
          "not_pending",
          409,
          "The waiting update's files are missing. Upload it again.",
        );
      }
      const current = await this.currentTarget();
      if ((options.requireRunningFromCurrent ?? true) && !(await this.runningFromCurrent())) {
        throw new UpdateRefusal(
          "not_running_from_updates_folder",
          409,
          "Oculus isn't running from the updates folder, so a restart wouldn't start the new version. Change the host's start command first.",
        );
      }
      const from = current === undefined ? null : await releaseVersion(current);
      if (from !== null && compareVersions(version, from) <= 0) {
        throw new UpdateRefusal("not_newer", 409, "Only newer versions can be installed.");
      }
      // Real paths: the release scripts compare their own path with the one
      // they were started by, so a link anywhere in the folder's path would
      // make them do nothing (review).
      const target = await realpath(this.releasePath(version));
      if (pending.newMigrations.length > 0) {
        const ownerUrl = this.migrateUrl ?? options.fallbackUrl;
        if (ownerUrl === undefined) {
          throw new UpdateRefusal(
            "migrations_need_owner",
            409,
            "This update changes the database, and this server isn't set up to do that from the admin (OCULUS_UPDATE_MIGRATE_DATABASE_URL and OCULUS_UPDATE_WRITER_ROLE). Install it with npm run release -- install on the server instead.",
          );
        }
        const asOwner = { OCULUS_DATABASE_URL: ownerUrl };
        let backupName: string | undefined;
        if (this.backups && current !== undefined) {
          step("backing_up");
          await mkdir(this.path("backups"), { recursive: true, mode: 0o700 });
          backupName = `before-${version}-${this.now().replace(/[:.]/g, "-")}.oculus-backup`;
          const result = await this.runScript(
            join(current, "packages", "db", "dist", "backup-cli.js"),
            ["backup", this.path("backups", backupName)],
            current,
            asOwner,
          );
          if (result.code !== 0) {
            const log = await this.keepOutput("backup", version, result.output);
            this.log("update_backup_failed", { version });
            throw new UpdateRefusal(
              "backup_failed",
              500,
              `The database backup before the update failed, so nothing was changed. Details are in logs/${log} in the updates folder.`,
            );
          }
          await this.pruneBackups();
        }
        step("migrating");
        const migrated = await this.runScript(
          join(target, "packages", "db", "dist", "migrate-cli.js"),
          [],
          target,
          asOwner,
        );
        if (migrated.code !== 0) {
          const log = await this.keepOutput("migrate", version, migrated.output);
          this.log("update_migrations_failed", { version });
          throw new UpdateRefusal(
            "migrations_failed",
            500,
            `The new version's database changes failed, so the running version stays, but some changes may already be in the database. Details are in logs/${log} in the updates folder. ${backupName === undefined ? "No backup was taken." : `If Oculus misbehaves, restore backups/${backupName}.`}`,
          );
        }
        const role = this.writerRole ?? options.fallbackWriterRole;
        if (role !== undefined) {
          step("granting");
          const granted = await this.runScript(
            join(target, "packages", "db", "dist", "grant-cli.js"),
            [role],
            target,
            asOwner,
          );
          if (granted.code !== 0) {
            const log = await this.keepOutput("grant", version, granted.output);
            this.log("update_grant_failed", { version });
            throw new UpdateRefusal(
              "grant_failed",
              500,
              `The database was changed, but the app's role couldn't be given its rights to the new tables, so the running version stays. Details are in logs/${log} in the updates folder.`,
            );
          }
        }
      }
      step("switching");
      await this.swapCurrent(version);
      this.swapped = true;
      const entry = { kind: "install" as const, version, from, at: this.now(), by };
      const history = [...state.history, entry];
      const next = { pending: null, history: history.slice(-HISTORY_LIMIT) };
      this.log("update_installed", { version, from: from ?? "development" });
      await this.logChange(entry);
      // The switch is made: what follows can't undo it, so a failure is logged, not reported.
      try {
        await this.writeState(next);
        await this.prune(next);
      } catch {
        this.log("update_bookkeeping_failed", { version });
      }
    } finally {
      await unlock();
    }
  }

  private async rollback(version: string, by: string, step: (name: string) => void): Promise<void> {
    const unlock = await this.lock();
    try {
      const state = await this.readState();
      const target = await this.rollbackTarget(state);
      if (target?.version !== version) {
        throw new UpdateRefusal("no_rollback", 409, "That isn't the version to go back to.");
      }
      if (!target.allowed) {
        throw new UpdateRefusal(
          "database_changed",
          409,
          "The last update changed the database, so the older version can't run on it. Restore the backup taken before the update instead.",
        );
      }
      const current = await this.currentTarget();
      const from = current === undefined ? null : await releaseVersion(current);
      step("switching");
      await this.swapCurrent(version);
      this.swapped = true;
      const entry = { kind: "rollback" as const, version, from, at: this.now(), by };
      const history = [...state.history, entry];
      await this.logChange(entry);
      try {
        await this.writeState({ ...state, history: history.slice(-HISTORY_LIMIT) });
      } catch {
        this.log("update_bookkeeping_failed", { version });
      }
      this.log("update_rolled_back", { version, from: from ?? "development" });
    } finally {
      await unlock();
    }
  }

  /** The change log's row for a switch just made (T-060a); a failure is only logged. */
  private async logChange(entry: HistoryEntry): Promise<void> {
    if (this.changeLog === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      // A database that doesn't answer mustn't hold up a switch already made.
      await Promise.race([
        this.changeLog(entry),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => {
            fail(new Error("timeout"));
          }, this.changeLogTimeoutMs);
          timer.unref();
        }),
      ]);
    } catch {
      this.log("update_change_log_failed", { version: entry.version });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Keeps the newest few backups taken before updates. */
  private async pruneBackups(): Promise<void> {
    const names = (await readdir(this.path("backups")))
      .filter((n) => n.startsWith("before-") && n.endsWith(".oculus-backup"))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
      await rm(this.path("backups", name), { force: true });
    }
  }

  /** Removes old releases, keeping the current one, the waiting one, the rollback target and the newest few. */
  private async prune(state: StoredState): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.path("releases"))).filter(isVersion);
    } catch {
      return;
    }
    const current = await this.currentTarget();
    const rollback = await this.rollbackTarget(state);
    const keep = new Set<string>(names.sort(compareVersions).slice(-KEEP_RELEASES));
    if (state.pending !== null) keep.add(state.pending);
    if (rollback !== null) keep.add(rollback.version);
    for (const name of names) {
      if (keep.has(name)) continue;
      const path = this.releasePath(name);
      if (current !== undefined && (await realpath(path)) === current) continue;
      await rm(path, { recursive: true, force: true });
      await rm(`${path}.verified.json`, { force: true });
    }
  }

  // ------------------------------------------------------------------ jobs

  private startJob(
    kind: JobStatus["kind"],
    version: string | undefined,
    work: (step: (name: string) => void) => Promise<unknown>,
  ): void {
    const startedAt = this.now();
    const base = { kind, startedAt, ...(version === undefined ? {} : { version }) };
    this.job = { ...base, state: "running", step: "starting" };
    const step = (name: string) => {
      this.job = { ...base, state: "running", step: name };
    };
    this.working = (async () => {
      try {
        await work(step);
        this.job = { ...base, state: "done", step: "done", endedAt: this.now() };
        if (kind !== "verify" && this.restart === "exit" && this.requestRestart !== undefined) {
          const restart = this.requestRestart;
          this.log("update_restarting", { kind });
          setTimeout(restart, 1500).unref();
        }
      } catch (error) {
        const refusal =
          error instanceof UpdateRefusal
            ? error
            : new UpdateRefusal("failed", 500, "The step failed. See the server log.");
        if (!(error instanceof UpdateRefusal)) {
          this.log("update_failed", {
            kind,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
        this.job = {
          ...base,
          state: "failed",
          step: "failed",
          error: refusal.code,
          message: refusal.message,
          endedAt: this.now(),
        };
      }
    })();
  }

  /** Resolves when the running job (if any) has ended (tests and shutdown). */
  async idle(): Promise<void> {
    await this.working;
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "install" || v.kind === "rollback") &&
    isVersion(v.version) &&
    (v.from === null || isVersion(v.from)) &&
    typeof v.at === "string" &&
    typeof v.by === "string"
  );
}

type PendingSummary = Omit<PendingRelease, "newMigrations">;

function summaryOf(manifest: UpdateManifest, keyId: string): PendingSummary {
  return {
    version: manifest.version,
    builtAt: manifest.builtAt,
    notes: manifest.notes,
    keyId,
    files: manifest.files.length,
    bytes: manifest.files.reduce((sum, f) => sum + f.size, 0),
  };
}

function isPendingSummary(value: unknown): value is PendingSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isVersion(v.version) &&
    typeof v.builtAt === "string" &&
    typeof v.notes === "string" &&
    typeof v.keyId === "string" &&
    typeof v.files === "number" &&
    typeof v.bytes === "number"
  );
}
