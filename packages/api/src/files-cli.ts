/**
 * The operator's file command (M-002, D-086), after `npm run build`, with
 * `OCULUS_DATABASE_URL` and `OCULUS_FILES_DIR` set as for the admin server:
 *
 * - `npm run files:adopt`: after restoring or copying a database, makes it
 *   the folder's own again: a new lease epoch, and a time before which no
 *   file event will count for a later purge. It deletes nothing and enables
 *   nothing that deletes. Refused while the folder's marker changed within
 *   the last three hours (three lease renewals): another database may
 *   still use the folder.
 *
 * There is no purge in this version (D-086, fifth review): removed files
 * keep using disk space for now; a later version will add a safe way to
 * free it (S-043). No URL, path or secret is printed.
 */
import { pathToFileURL } from "node:url";
import { openDatabase } from "@oculus/db";
import { createService } from "@oculus/service";
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

/** Runs `adopt`; resolves with the exit code. */
export async function runFilesCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: FilesCliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (command === "purge") {
    io.err(
      "There is no purge in this version: removed files keep using disk space for now; a later version will add a safe way to free it.",
    );
    return 2;
  }
  if (command !== "adopt") {
    io.err("Use: files-cli adopt");
    return 2;
  }
  if (rest.length > 0) {
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
