/**
 * `npm run holds` (T-034f, D-120), after `npm run build`, with
 * `OCULUS_DATABASE_URL` set as for the admin server (the writer's account):
 * one access-holds pass over every organization. Published records an
 * accession now holds back (a deed not signed, an access restriction in
 * force on the organization's day) are withdrawn, and records the pass
 * withdrew earlier are published again once nothing holds them. Every
 * change is a version in the record's history, by `system:access-holds`.
 * `-- --dry-run` says what a pass would do and changes nothing.
 *
 * Run it once a day, soon after midnight in the organizations' time zones
 * (cron, or Site Tools' cron on SiteGround); the desktop runs it at each
 * start. No URL, record or accession detail is printed.
 */
import { pathToFileURL } from "node:url";
import { openDatabase } from "@oculus/db";
import { applyAccessHolds, type AccessHoldsReport } from "@oculus/service";

const DATABASE_URL_VARIABLE = "OCULUS_DATABASE_URL";

export interface HoldsCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const n = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** The lines a pass's report prints. */
export function holdsLines(report: AccessHoldsReport): string[] {
  const lines = [
    report.dryRun ? "Dry run: nothing was changed." : "Access holds checked.",
    `${report.dryRun ? "Would withdraw" : "Withdrawn"} (an accession holds them back): ${n(report.withdrawn, "record", "records")}.`,
    `${report.dryRun ? "Would publish again" : "Published again"} (no longer held back): ${n(report.published, "record", "records")}.`,
  ];
  if (report.stillHeld > 0) {
    lines.push(`Still held back, left withdrawn: ${n(report.stillHeld, "record", "records")}.`);
  }
  if (report.blocked > 0) {
    lines.push(
      `No longer held back, but the publish check refuses them for another reason; left withdrawn for staff to look at: ${n(report.blocked, "record", "records")}.`,
    );
  }
  if (report.failed > 0) {
    lines.push(
      `Couldn't be checked or changed (an error, above): ${n(report.failed, "record", "records")}.`,
    );
  }
  if (report.unknownDay > 0) {
    lines.push(
      `Left alone, because their time zone is no longer known (a system manager picks a current one): ${n(report.unknownDay, "organization", "organizations")}.`,
    );
  }
  return lines;
}

/** Runs one pass; resolves with the exit code. */
export async function runHoldsCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: HoldsCliIo,
): Promise<number> {
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (args.length > 0 && !dryRun) {
    io.err("Use: holds-cli [--dry-run]");
    return 2;
  }
  const url = env[DATABASE_URL_VARIABLE];
  if (url === undefined || url.trim() === "") {
    io.err(`${DATABASE_URL_VARIABLE} is not set.`);
    return 2;
  }
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(url, { applicationName: "oculus-holds", max: 2 });
  } catch {
    io.err(`${DATABASE_URL_VARIABLE} is not a usable postgresql:// URL (its value is not shown).`);
    return 2;
  }
  try {
    let errors = 0;
    const report = await applyAccessHolds(db, {
      apply: !dryRun,
      onError: (error) => {
        errors += 1;
        // Only a code (a SQLSTATE or a refusal's): a database message can quote a value.
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "unknown";
        io.err(`A record couldn't be checked or changed (${code}); it was left as it was.`);
      },
    });
    for (const line of holdsLines(report)) io.out(line);
    return report.failed > 0 || errors > 0 ? 1 : 0;
  } catch {
    io.err("The access holds couldn't be checked: the database couldn't be read.");
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runHoldsCli(process.argv.slice(2), process.env, {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
  process.exitCode = code;
}
