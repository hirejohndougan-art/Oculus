/**
 * The operator's file commands (M-002, D-086), after `npm run build`, with
 * `OCULUS_DATABASE_URL` and `OCULUS_FILES_DIR` set as for the admin server:
 *
 * - `npm run files:purge`: one step of the purge of removed files (S-052),
 *   by the same rules as the admin's "Clean up removed files" button: under
 *   the folder's lease, files removed at least 7 days ago (by the
 *   database's clock and the file system's) and unused since go to the
 *   trash; files in the trash for a day are deleted. `-- --dry-run` says
 *   what a step would do and changes nothing. Every step that changes
 *   something goes to the change log.
 * - `npm run files:accept-identity`: after a pg_upgrade, while the folder's
 *   lease is still this database's and its catalog is the one that took it
 *   (else `use_adopt`), makes the marker name this database's new identity
 *   (an adopt-kind epoch; the change log says so).
 * - `npm run files:adopt`: after restoring or copying a database, makes it
 *   the folder's own again: a new lease epoch, and a time before which no
 *   file event will count for a later purge. It deletes nothing and enables
 *   nothing that deletes. Refused while the folder's marker changed within
 *   the last three hours (three lease renewals): another database may
 *   still use the folder.
 *
 * No URL, path or secret is printed.
 */
import { pathToFileURL } from "node:url";
import { databaseIdentity, openDatabase } from "@oculus/db";
import { createService, type PurgeReport, type PurgeTotals } from "@oculus/service";
import { fileStoreFromEnv } from "./admin-server.js";

const DATABASE_URL_VARIABLE = "OCULUS_DATABASE_URL";

export interface FilesCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const ADOPT_PROBLEMS: Readonly<Record<string, string>> = {
  no_store: "no files folder is configured.",
  marker_missing: "the files folder has no .oculus-store-id.",
  other_install: "the files folder belongs to another Oculus install.",
  epoch_moving:
    "the files folder's marker changed within the last three hours: another database may still be using it. Stop every other Oculus server that uses this folder, wait three hours, and try again.",
};

const PURGE_PROBLEMS: Readonly<Record<string, string>> = {
  no_store: "no files folder is configured.",
  not_bound:
    "this database hasn't bound the files folder yet. Start the admin server once, then try again.",
  other_install: "the files folder belongs to another Oculus install.",
  lease_mismatch:
    "the files folder's lease isn't this database's: another database uses the folder, or this one was restored or copied. Nothing is purged until npm run files:adopt.",
  identity_changed:
    "the files folder's marker names another database's identity: this database was upgraded in place (pg_upgrade), moved by dump and restore, or is a copy of the one that uses the folder. After a pg_upgrade, run npm run files:accept-identity (or use System settings, Removed files); after a dump and restore, npm run files:adopt.",
  use_adopt:
    "this database's catalog isn't the one that last held the folder (a dump and restore, or a copy), so only an adopt can make the folder its own: npm run files:adopt.",
  identity_unknown:
    "this database's role can't read the cluster's system identifier, so a restore of it elsewhere couldn't be told apart. Have a superuser grant it EXECUTE on pg_catalog.pg_control_system().",
  mtime_unreliable:
    "the files folder's file system doesn't keep file times exactly enough to tell whether a copy was used since it was removed. Nothing is purged on it.",
};

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "TiB"}`;
}

const count = (t: PurgeTotals): string =>
  `${String(t.files)} file${t.files === 1 ? "" : "s"} (${size(t.bytes)})`;

/** The lines a purge step's report prints. */
export function purgeLines(report: PurgeReport): string[] {
  const would = report.dryRun ? "Would move" : "Moved";
  const lines = [
    report.dryRun ? "Dry run: nothing was changed." : "One purge step done.",
    `${would} to the trash: ${count(report.trashed)}.`,
    `${report.dryRun ? "Would delete" : "Deleted"} from the trash: ${count(report.deleted)}.`,
    `${report.dryRun ? "Would put back" : "Put back"} from the trash: ${count(report.restored)}.`,
    `Waiting in the trash for a later step: ${count(report.waiting)}.`,
  ];
  if (report.stuck.files > 0) {
    lines.push(
      `Stuck in the trash, left alone (not a plain copy of Oculus's own; look at them): ${count(report.stuck)}.`,
    );
  }
  if (report.stopped !== undefined) {
    lines.push(
      report.stopped === "lease_expired"
        ? "Stopped early: the step's time ran out. Run it again to go on."
        : "Stopped early: the files folder's lease moved (a server started or renewed it). Run it again to go on.",
    );
  }
  return lines;
}

/** Runs `purge` or `adopt`; resolves with the exit code. */
export async function runFilesCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: FilesCliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "adopt" && command !== "purge" && command !== "accept-identity") {
    io.err("Use: files-cli purge [--dry-run] | files-cli adopt | files-cli accept-identity");
    return 2;
  }
  const dryRun = command === "purge" && rest.length === 1 && rest[0] === "--dry-run";
  if (rest.length > 0 && !dryRun) {
    io.err("Unknown option.");
    return 2;
  }
  const url = env[DATABASE_URL_VARIABLE];
  if (url === undefined || url.trim() === "") {
    io.err(`${DATABASE_URL_VARIABLE} is not set.`);
    return 2;
  }
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(url, { applicationName: "oculus-files", max: 2 });
  } catch {
    io.err(`${DATABASE_URL_VARIABLE} is not a usable postgresql:// URL (its value is not shown).`);
    return 2;
  }
  try {
    let files;
    try {
      files = await fileStoreFromEnv(env);
    } catch (error) {
      io.err(error instanceof Error ? error.message.replace(/^refusing to start: /, "") : "");
      return 2;
    }
    const service = createService(db, { files });
    // The server's role and this command's may read the identity
    // differently (one without the cluster's system identifier): said
    // plainly, since the purge then refuses (S-052 third review).
    const marker = await files.readMarker().catch(() => undefined);
    const identity = await databaseIdentity(db).catch(() => undefined);
    if (
      marker?.database !== undefined &&
      identity !== undefined &&
      marker.database !== identity &&
      marker.database.split(":")[1] === identity.split(":")[1] &&
      (identity.startsWith("-:") || marker.database.startsWith("-:"))
    ) {
      io.err(
        "Warning: this command's database role reads the database's identity differently from the server's (one of them can't run pg_control_system()). Run it as the server's role, or grant both.",
      );
    }
    if (command === "purge") {
      const purged = await service.purgeFiles({ apply: !dryRun });
      if (!purged.ok) {
        io.err(`Not purged: ${PURGE_PROBLEMS[purged.problem] ?? purged.problem}`);
        return 1;
      }
      for (const line of purgeLines(purged.value)) io.out(line);
      return 0;
    }
    if (command === "accept-identity") {
      const accepted = await service.acceptFileStoreIdentity();
      if (!accepted.ok) {
        io.err(`Not accepted: ${PURGE_PROBLEMS[accepted.problem] ?? accepted.problem}`);
        return 1;
      }
      io.out(
        accepted.changed
          ? "The files folder now names this database. Nothing was deleted."
          : "The files folder already names this database.",
      );
      return 0;
    }
    const adopted = await service.adoptFileStore();
    if (!adopted.ok) {
      io.err(`Not adopted: ${ADOPT_PROBLEMS[adopted.problem] ?? adopted.problem}`);
      return 1;
    }
    io.out("This database now owns the files folder. Nothing was deleted.");
    return 0;
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runFilesCli(process.argv.slice(2), process.env, {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
  process.exitCode = code;
}
