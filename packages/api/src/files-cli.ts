/**
 * The operator's file commands (M-002, D-086), after `npm run build`, with
 * `OCULUS_DATABASE_URL` and `OCULUS_FILES_DIR` set as for the admin server:
 *
 * - `npm run files:purge [-- --yes]`: Oculus never deletes stored files on
 *   its own. This lists the copies this database may delete (files it
 *   removed at least 7 days ago, and copies an attach placed but never
 *   committed at least a day ago), with their size and last event, asks
 *   before deleting them (`--yes` doesn't ask) and deletes only those. It
 *   is refused unless the folder's lease epoch is this database's.
 * - `npm run files:adopt`: after restoring or copying a database, makes it
 *   the folder's own again: a new epoch, and a time before which no file
 *   event counts for the purge (so nothing attached or removed before it is
 *   ever purged). Refused while the folder's marker changed within the
 *   last hour: another database still uses the folder.
 *
 * No URL, path or secret is printed.
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { openDatabase } from "@oculus/db";
import { createService, type PurgeEntry } from "@oculus/service";
import { fileStoreFromEnv } from "./admin-server.js";

const DATABASE_URL_VARIABLE = "OCULUS_DATABASE_URL";

export interface FilesCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Asks a yes/no question; true for yes. */
  readonly confirm: (question: string) => Promise<boolean>;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "TB"}`;
}

const PURGE_PROBLEMS: Readonly<Record<string, string>> = {
  no_store: "no files folder is configured.",
  not_bound:
    "the files folder isn't this database's (its .oculus-store-id names another install, or is missing).",
  lease_mismatch:
    "the files folder's lease isn't this database's: another database uses this folder, or this one was restored or copied. Nothing was deleted. Make sure no other database uses the folder, then run `npm run files:adopt`.",
};

const ADOPT_PROBLEMS: Readonly<Record<string, string>> = {
  no_store: "no files folder is configured.",
  marker_missing: "the files folder has no .oculus-store-id.",
  other_install: "the files folder belongs to another Oculus install.",
  epoch_moving:
    "the files folder's marker changed within the last hour: another database is still using it. Stop every other Oculus server that uses this folder, wait an hour, and try again.",
};

/** Runs `purge` or `adopt`; resolves with the exit code. */
export async function runFilesCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: FilesCliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "purge" && command !== "adopt") {
    io.err("Use: files-cli purge [--yes] | files-cli adopt");
    return 2;
  }
  const yes = rest.includes("--yes");
  if (rest.some((a) => a !== "--yes") || (command === "adopt" && yes)) {
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
    if (command === "adopt") {
      const adopted = await service.adoptFileStore();
      if (!adopted.ok) {
        io.err(`Not adopted: ${ADOPT_PROBLEMS[adopted.problem] ?? adopted.problem}`);
        return 1;
      }
      io.out(
        "This database now owns the files folder. Files attached or removed before now are never purged.",
      );
      return 0;
    }
    const plan = await service.purgeFiles({ apply: false });
    if (!plan.ok) {
      io.err(`Nothing purged: ${PURGE_PROBLEMS[plan.problem] ?? plan.problem}`);
      return 1;
    }
    const entries: readonly PurgeEntry[] = plan.value.candidates;
    if (entries.length === 0) {
      io.out("Nothing to purge.");
      return 0;
    }
    const total = entries.reduce((n, e) => n + e.size, 0);
    io.out(`${String(entries.length)} stored file(s), ${sizeText(total)}, can be deleted:`);
    for (const e of entries) {
      io.out(
        `  ${e.sha256.slice(0, 16)}…  ${sizeText(e.size)}  ${e.lastEvent === "removed" ? "removed" : "never attached"} ${e.lastEventAt}`,
      );
    }
    if (!yes && !(await io.confirm("Delete them for good? (yes/no) "))) {
      io.out("Nothing deleted.");
      return 0;
    }
    const done = await service.purgeFiles({
      apply: true,
      only: entries.map((e) => `${e.organizationId}/${e.sha256}`),
    });
    if (!done.ok) {
      io.err(`Nothing purged: ${PURGE_PROBLEMS[done.problem] ?? done.problem}`);
      return 1;
    }
    io.out(`Deleted ${String(done.value.deleted)} stored file(s).`);
    return 0;
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const confirm = async (question: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(question)).trim());
    } finally {
      rl.close();
    }
  };
  const code = await runFilesCli(process.argv.slice(2), process.env, {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
    confirm,
  });
  process.exitCode = code;
}
