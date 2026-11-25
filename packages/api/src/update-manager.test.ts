// Installing updates on the server (T-060, D-092), in a throwaway updates
// folder with the release scripts stubbed: the upload in ordered parts of a
// fixed size, verification into the waiting release, the install (backup
// and migrations only when the release brings new migrations, and nothing
// switched when either fails), the swap of `current`, the restart request,
// rollback only when the database wasn't changed, older releases removed,
// and the refusals: older or same versions, a server not running from the
// updates folder, a busy folder and bad settings.
import { readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UPLOAD_PART_BYTES,
  UpdateManager,
  UpdateRefusal,
  updateManagerFromEnv,
  type HistoryEntry,
  type RunScript,
} from "./update-manager.js";
import { tempDir, testKey, testPackage, writeTemp, type TestKey } from "./update.fixtures.js";

let home: string;
let scratch: string;
let key: TestKey;
let calls: { script: string; args: readonly string[] }[];
let fail: string | undefined;

let envs: Readonly<Record<string, string>>[];
const runScript: RunScript = (script, args, _cwd, env) => {
  calls.push({ script, args });
  envs.push(env);
  const code = fail !== undefined && script.endsWith(fail) ? 1 : 0;
  return Promise.resolve({ code, output: "" });
};

function manager(
  extra: Partial<ConstructorParameters<typeof UpdateManager>[0]> = {},
): UpdateManager {
  return new UpdateManager({
    home,
    keys: key.trusted,
    runScript,
    runningRoot: join(home, "current"),
    migrateUrl: "postgresql://owner@db.example.org/oculus",
    writerRole: "oculus_writer",
    ...extra,
  });
}

async function refusal(work: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    if (error instanceof UpdateRefusal) return error.code;
    throw error;
  }
  return "accepted";
}

/** Uploads `bytes` through the manager in parts, then waits for the check. */
async function upload(m: UpdateManager, bytes: Buffer) {
  const { uploadId, partBytes } = await m.startUpload(bytes.length);
  for (let i = 0, part = 0; i < bytes.length; i += partBytes, part++) {
    await m.addPart(uploadId, part, bytes.subarray(i, i + partBytes));
  }
  m.finishUpload(uploadId);
  await m.idle();
  return m.status();
}

/** Puts version `v` in place as current, as the first install by the release command does. */
async function firstInstall(v: string, migrations?: readonly string[]) {
  const m = manager();
  const file = await writeTemp(scratch, `first-${v}.zip`, testPackage(key, v, migrations));
  await m.verifyInto(file);
  await m.install(v, "release-cli", undefined, { requireRunningFromCurrent: false });
}

beforeEach(async () => {
  home = await tempDir("updates");
  scratch = await tempDir("scratch");
  key = testKey();
  calls = [];
  envs = [];
  fail = undefined;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe("the first install (release command)", () => {
  it("unpacks the release, runs its migrations and points current at it", async () => {
    await firstInstall("0.1.0");
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.1.0"));
    expect(calls.map((c) => c.script)).toEqual([
      join(home, "releases", "0.1.0", "packages/db/dist/migrate-cli.js"),
      join(home, "releases", "0.1.0", "packages/db/dist/grant-cli.js"),
    ]);
    const status = await manager().status();
    expect(status.runningVersion).toBe("0.1.0");
    expect(status.runningFromCurrent).toBe(true);
    expect(status.history).toMatchObject([
      { kind: "install", version: "0.1.0", from: null, by: "release-cli" },
    ]);
  });
});

describe("the updates folder (S-050)", () => {
  it.skipIf(process.platform === "win32")(
    "is made private, with its releases folder, when it doesn't exist yet",
    async () => {
      const parent = home;
      home = join(parent, "new-home");
      try {
        await firstInstall("0.1.0");
        expect((await stat(home)).mode & 0o777).toBe(0o700);
        expect((await stat(join(home, "releases"))).mode & 0o777).toBe(0o700);
      } finally {
        home = parent; // afterEach removes the whole throwaway folder
      }
    },
  );
});

describe("uploading", () => {
  it("takes parts in order, each the fixed size but the last", async () => {
    await firstInstall("0.1.0");
    const m = manager();
    const big = testPackage(key, "0.2.0", ["0001_start.sql"], "x".repeat(10));
    const bytes = Buffer.concat([big]);
    const { uploadId } = await m.startUpload(bytes.length);
    expect(await refusal(m.addPart(uploadId, 1, bytes.subarray(0, 10)))).toBe("wrong_part");
    expect(await refusal(m.addPart("f".repeat(32), 0, bytes))).toBe("unknown_upload");
    expect(await refusal(m.addPart("../../x", 0, bytes))).toBe("unknown_upload");
    if (bytes.length > UPLOAD_PART_BYTES) {
      expect(await refusal(m.addPart(uploadId, 0, bytes.subarray(0, 10)))).toBe("wrong_part_size");
    } else {
      expect(await refusal(m.addPart(uploadId, 0, bytes.subarray(0, bytes.length - 1)))).toBe(
        "wrong_part_size",
      );
    }
    expect(
      await refusal(() => {
        m.finishUpload(uploadId);
      }),
    ).toBe("incomplete");
    await m.addPart(uploadId, 0, bytes);
    expect(await refusal(m.addPart(uploadId, 1, Buffer.alloc(1)))).toBe("wrong_part_size");
    m.finishUpload(uploadId);
    await m.idle();
    expect((await m.status()).pending?.version).toBe("0.2.0");
    expect(await readdir(join(home, "uploads"))).toEqual([]);
  });

  it("splits a large package into many parts", async () => {
    await firstInstall("0.1.0");
    const m = manager();
    // Notes can't be large, so pad with a big incompressible file instead.
    const { buildPackage } = await import("./release-cli.js");
    const { releaseFiles, BUILT_AT } = await import("./update.fixtures.js");
    const { randomBytes } = await import("node:crypto");
    const files = [
      ...releaseFiles("0.2.0"),
      { name: "packages/admin/dist/big.bin", data: randomBytes(UPLOAD_PART_BYTES * 2 + 123) },
    ];
    files.sort((a, b) => (a.name < b.name ? -1 : 1));
    const bytes = buildPackage(files, {
      version: "0.2.0",
      builtAt: BUILT_AT,
      notes: "",
      key: key.pem,
    });
    const status = await upload(m, bytes);
    expect(status.job).toMatchObject({ kind: "verify", state: "done" });
    expect(status.pending).toMatchObject({ version: "0.2.0", files: files.length });
  });

  it("refuses sizes it can't take", async () => {
    const m = manager({ maxPackageBytes: 1000 });
    expect(await refusal(m.startUpload(1001))).toBe("too_large");
    expect(await refusal(m.startUpload(-5))).toBe("invalid_size");
    expect(await refusal(m.startUpload("12"))).toBe("invalid_size");
    expect(await refusal(m.startUpload(1.5))).toBe("invalid_size");
  });

  it("drops an upload left idle for an hour", async () => {
    let now = 0;
    const m = manager({ clock: () => now });
    const { uploadId } = await m.startUpload(100);
    now = 61 * 60 * 1000;
    expect(await refusal(m.addPart(uploadId, 0, Buffer.alloc(100)))).toBe("unknown_upload");
  });

  it("starting again replaces the earlier upload", async () => {
    const m = manager();
    const first = await m.startUpload(100);
    const second = await m.startUpload(100);
    expect(await refusal(m.addPart(first.uploadId, 0, Buffer.alloc(100)))).toBe("unknown_upload");
    expect((await m.addPart(second.uploadId, 0, Buffer.alloc(100))).received).toBe(100);
    expect(await readdir(join(home, "uploads"))).toEqual([`${second.uploadId}.zip`]);
  });
});

describe("checking an uploaded package", () => {
  beforeEach(async () => {
    await firstInstall("0.1.0");
  });

  it("refuses a package signed by another key, and removes the upload", async () => {
    const status = await upload(manager(), testPackage(testKey(), "0.2.0"));
    expect(status.job).toMatchObject({ state: "failed", error: "unknown_key" });
    expect(status.pending).toBeNull();
    expect((await readdir(join(home, "releases"))).sort()).toEqual([
      "0.1.0",
      "0.1.0.verified.json",
    ]);
    expect(await readdir(join(home, "uploads"))).toEqual([]);
  });

  it("refuses the running version and older ones", async () => {
    expect((await upload(manager(), testPackage(key, "0.1.0"))).job).toMatchObject({
      error: "not_newer",
    });
    expect((await upload(manager(), testPackage(key, "0.0.9"))).job).toMatchObject({
      error: "not_newer",
    });
  });

  it("refuses something that isn't a package", async () => {
    const status = await upload(manager(), Buffer.from("just some text, not an update package"));
    expect(status.job).toMatchObject({ state: "failed", error: "zip_not_zip" });
  });

  it("shows the waiting release's details and the migrations it adds", async () => {
    const status = await upload(
      manager(),
      testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"], "Fixes."),
    );
    expect(status.pending).toMatchObject({
      version: "0.2.0",
      notes: "Fixes.",
      keyId: key.keyId,
      newMigrations: ["0002_more.sql"],
    });
  });

  it("a newer upload replaces the waiting one; discarding removes it", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0"));
    await upload(m, testPackage(key, "0.3.0"));
    expect((await m.status()).pending?.version).toBe("0.3.0");
    expect(await readdir(join(home, "releases"))).not.toContain("0.2.0");
    await m.discardPending();
    expect((await m.status()).pending).toBeNull();
    expect(await readdir(join(home, "releases"))).not.toContain("0.3.0");
    expect(await refusal(m.discardPending())).toBe("nothing_pending");
  });
});

describe("installing", () => {
  beforeEach(async () => {
    await firstInstall("0.1.0");
    calls = [];
    envs = [];
  });

  it("backs up, migrates, then switches when the release adds migrations", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"]));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    const status = await m.status();
    expect(status.job).toMatchObject({ kind: "install", state: "done" });
    expect(calls.map((c) => c.script)).toEqual([
      join(home, "releases", "0.1.0", "packages/db/dist/backup-cli.js"),
      join(home, "releases", "0.2.0", "packages/db/dist/migrate-cli.js"),
      join(home, "releases", "0.2.0", "packages/db/dist/grant-cli.js"),
    ]);
    expect(calls[2]?.args).toEqual(["oculus_writer"]);
    // Every step connects as the owner; the app's own URL is never changed.
    expect(envs.map((e) => e.OCULUS_DATABASE_URL)).toEqual(
      Array(3).fill("postgresql://owner@db.example.org/oculus"),
    );
    expect(calls[0]?.args[0]).toBe("backup");
    expect(calls[0]?.args[1]).toMatch(/backups\/before-0\.2\.0-.*\.oculus-backup$/);
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.2.0"));
    expect(status.restartNeeded).toBe(true);
    expect(status.pending).toBeNull();
    expect(status.history[0]).toMatchObject({
      kind: "install",
      version: "0.2.0",
      from: "0.1.0",
      by: "user-1",
    });
  });

  it("runs nothing when the release adds no migrations", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0"));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect(calls).toEqual([]);
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.2.0"));
  });

  it("skips the backup when backups are off", async () => {
    const m = manager({ backups: false });
    await upload(m, testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"]));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect(calls.map((c) => c.args[0])).toEqual([undefined, "oculus_writer"]);
  });

  it("refuses a release with database changes when the owner's URL isn't set", async () => {
    const m = new UpdateManager({
      home,
      keys: key.trusted,
      runScript,
      runningRoot: join(home, "current"),
    });
    expect((await m.status()).migrationsFromWeb).toBe(false);
    await upload(m, testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"]));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect((await m.status()).job).toMatchObject({ error: "migrations_need_owner" });
    expect(calls).toEqual([]);
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.1.0"));
  });

  it("keeps a failed step's output in the updates folder, not in the reply", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"]));
    fail = "grant-cli.js";
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    const job = (await m.status()).job;
    expect(job).toMatchObject({ error: "grant_failed" });
    expect(job?.message).toMatch(/logs\/grant-0\.2\.0-/);
    expect((await readdir(join(home, "logs")))[0]).toMatch(/^grant-0\.2\.0-/);
  });

  it("changes nothing when the backup fails", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"]));
    fail = "backup-cli.js";
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    const status = await m.status();
    expect(status.job).toMatchObject({ state: "failed", error: "backup_failed" });
    expect(calls).toHaveLength(1);
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.1.0"));
    expect(status.pending?.version).toBe("0.2.0");
    expect(status.restartNeeded).toBe(false);
  });

  it("keeps the running release current when the migrations fail", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"]));
    fail = "migrate-cli.js";
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect((await m.status()).job).toMatchObject({ state: "failed", error: "migrations_failed" });
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.1.0"));
  });

  it("asks for a restart when set to exit", async () => {
    let restarts = 0;
    const m = manager({ restart: "exit", requestRestart: () => restarts++ });
    await upload(m, testPackage(key, "0.2.0"));
    expect(restarts).toBe(0);
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    await new Promise((r) => setTimeout(r, 1700));
    expect(restarts).toBe(1);
  });

  it("refuses a version that isn't the waiting one", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0"));
    m.startInstall("0.3.0", "user-1");
    await m.idle();
    expect((await m.status()).job).toMatchObject({ error: "not_pending" });
    expect(
      await refusal(() => {
        m.startInstall("../0.2.0", "user-1");
      }),
    ).toBe("invalid_version");
  });

  it("refuses when the server doesn't run from the updates folder", async () => {
    const m = manager({ runningRoot: scratch });
    await upload(m, testPackage(key, "0.2.0"));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect((await m.status()).job).toMatchObject({ error: "not_running_from_updates_folder" });
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.1.0"));
  });

  it("runs one job at a time and respects another process's lock", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0"));
    m.startInstall("0.2.0", "user-1");
    expect(
      await refusal(() => {
        m.startInstall("0.2.0", "user-1");
      }),
    ).toBe("busy");
    expect(await refusal(m.startUpload(100))).toBe("busy");
    await m.idle();

    const other = manager();
    await upload(other, testPackage(key, "0.3.0"));
    // A live process (this one) holds the lock: refused.
    await writeFile(join(home, "update.lock"), String(process.pid));
    other.startInstall("0.3.0", "user-1");
    await other.idle();
    expect((await other.status()).job).toMatchObject({ error: "busy" });
    // A lock left by a process that is gone is taken over.
    await writeFile(join(home, "update.lock"), "999999999");
    other.startInstall("0.3.0", "user-1");
    await other.idle();
    expect((await other.status()).job).toMatchObject({ state: "done" });
  });

  it("keeps only the newest releases besides current and the rollback target", async () => {
    const m = manager();
    for (const v of ["0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0"]) {
      await upload(m, testPackage(key, v));
      m.startInstall(v, "user-1");
      await m.idle();
    }
    const left = (await readdir(join(home, "releases"))).filter((n) => !n.endsWith(".json")).sort();
    expect(left).toEqual(["0.4.0", "0.5.0", "0.6.0"]);
  });
});

describe("rolling back", () => {
  beforeEach(async () => {
    await firstInstall("0.1.0");
  });

  it("goes back to the release before the last install when the database is unchanged", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0"));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect((await m.status()).rollback).toEqual({ version: "0.1.0", allowed: true });
    m.startRollback("0.1.0", "user-2");
    await m.idle();
    const status = await m.status();
    expect(status.job).toMatchObject({ kind: "rollback", state: "done" });
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.1.0"));
    expect(status.history[0]).toMatchObject({
      kind: "rollback",
      version: "0.1.0",
      from: "0.2.0",
      by: "user-2",
    });
    expect(status.rollback).toBeNull();
  });

  it("refuses when the last install changed the database", async () => {
    const m = manager();
    await upload(m, testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"]));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect((await m.status()).rollback).toEqual({ version: "0.1.0", allowed: false });
    m.startRollback("0.1.0", "user-1");
    await m.idle();
    expect((await m.status()).job).toMatchObject({ error: "database_changed" });
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.2.0"));
  });

  it("refuses any other version", async () => {
    const m = manager();
    m.startRollback("0.0.1", "user-1");
    await m.idle();
    expect((await m.status()).job).toMatchObject({ error: "no_rollback" });
  });
});

describe("the change log (T-060a)", () => {
  beforeEach(async () => {
    await firstInstall("0.1.0");
  });

  it("is written once each switch is made, never for a failed install", async () => {
    const written: HistoryEntry[] = [];
    // The folder's own record is saved first: the entry is in state.json already.
    let saved = true;
    const m = manager({
      changeLog: async (entry) => {
        const state = JSON.parse(await readFile(join(home, "state.json"), "utf8")) as {
          history: HistoryEntry[];
        };
        saved &&= state.history.at(-1)?.version === entry.version;
        written.push(entry);
      },
    });
    fail = "migrate-cli.js";
    await upload(m, testPackage(key, "0.2.0", ["0001_start.sql", "0002_more.sql"]));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect((await m.status()).job).toMatchObject({ state: "failed" });
    expect(written).toEqual([]);
    fail = undefined;
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    await upload(m, testPackage(key, "0.3.0", ["0001_start.sql", "0002_more.sql"]));
    m.startInstall("0.3.0", "user-1");
    await m.idle();
    m.startRollback("0.2.0", "user-2");
    await m.idle();
    expect(written.map(({ kind, version, from, by }) => ({ kind, version, from, by }))).toEqual([
      { kind: "install", version: "0.2.0", from: "0.1.0", by: "user-1" },
      { kind: "install", version: "0.3.0", from: "0.2.0", by: "user-1" },
      { kind: "rollback", version: "0.2.0", from: "0.3.0", by: "user-2" },
    ]);
    expect(saved).toBe(true);
  });

  it("only logs a failure or a database that doesn't answer: the switch stands", async () => {
    const events: string[] = [];
    const m = manager({
      changeLog: () => Promise.reject(new Error("invented")),
      log: (event) => events.push(event),
    });
    await upload(m, testPackage(key, "0.2.0"));
    m.startInstall("0.2.0", "user-1");
    await m.idle();
    expect((await m.status()).job).toMatchObject({ kind: "install", state: "done" });
    expect(await readlink(join(home, "current"))).toBe(join("releases", "0.2.0"));
    expect(events).toContain("update_change_log_failed");
    const slow = manager({
      changeLog: () => new Promise<void>(() => undefined),
      changeLogTimeoutMs: 50,
      log: (event) => events.push(event),
    });
    slow.startRollback("0.1.0", "user-1");
    await slow.idle();
    expect((await slow.status()).job).toMatchObject({ kind: "rollback", state: "done" });
    expect(events.filter((e) => e === "update_change_log_failed")).toHaveLength(2);
  });
});

describe("settings", () => {
  it("is off without OCULUS_UPDATE_DIR", () => {
    expect(updateManagerFromEnv({})).toBeUndefined();
  });

  it("refuses bad settings, naming the variable only", () => {
    const keys = testKey().publicKey;
    expect(() =>
      updateManagerFromEnv({ OCULUS_UPDATE_DIR: "relative/path", OCULUS_UPDATE_KEYS: keys }),
    ).toThrow(/OCULUS_UPDATE_DIR/);
    expect(() => updateManagerFromEnv({ OCULUS_UPDATE_DIR: "/srv/oculus" })).toThrow(
      /OCULUS_UPDATE_KEYS/,
    );
    expect(() =>
      updateManagerFromEnv({
        OCULUS_UPDATE_DIR: "/srv/oculus",
        OCULUS_UPDATE_KEYS: keys,
        OCULUS_UPDATE_RESTART: "reboot",
      }),
    ).toThrow(/OCULUS_UPDATE_RESTART/);
    expect(() =>
      updateManagerFromEnv({
        OCULUS_UPDATE_DIR: "/srv/oculus",
        OCULUS_UPDATE_KEYS: keys,
        OCULUS_UPDATE_BACKUP: "no",
      }),
    ).toThrow(/OCULUS_UPDATE_BACKUP/);
    const m = updateManagerFromEnv({
      OCULUS_UPDATE_DIR: "/srv/oculus",
      OCULUS_UPDATE_KEYS: keys,
      OCULUS_UPDATE_RESTART: "exit",
      OCULUS_UPDATE_BACKUP: "skip",
    });
    expect(m?.restart).toBe("exit");
    expect(m?.backups).toBe(false);
  });

  it("ignores a damaged state file", async () => {
    await writeFile(join(home, "state.json"), "{not json");
    const status = await manager().status();
    expect(status.pending).toBeNull();
    expect(status.history).toEqual([]);
    expect(await readFile(join(home, "state.json"), "utf8")).toBe("{not json");
  });
});
