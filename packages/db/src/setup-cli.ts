/**
 * `npm run setup` (T-055): sets up a new, empty Oculus database so it can run
 * on one computer without typing SQL. For the database named by
 * OCULUS_DATABASE_URL it applies every migration, then asks for the
 * organization's name, the first site's name, and the first system admin's
 * name, email address and password (typed twice, never shown), and makes
 * them with `setUpFirstInstall` (first-setup.ts) along with a starter
 * template. It refuses, before asking anything, if the database already has
 * people or organizations, so it never runs twice.
 *
 * The answers other than the password can come from OCULUS_SETUP_ORGANIZATION,
 * OCULUS_SETUP_SITE, OCULUS_SETUP_NAME and OCULUS_SETUP_EMAIL instead. The
 * password is only ever typed (or, with no terminal, read from standard
 * input), never taken from the environment or the command line. Nothing
 * printed shows the URL or the password.
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */
import { createInterface, type Interface } from "node:readline";
import { normalizeEmail } from "@oculus/core";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { openDatabase, type Database } from "./client.js";
import { redact, secretsOf } from "./backup-connection.js";
import { databaseBeforeSetup, isEmptyInstall, setUpFirstInstall } from "./first-setup.js";
import { migrate, MigrationError } from "./migrate.js";
import { DATABASE_URL_VARIABLE } from "./migrate-cli.js";

type Line = (line: string) => void;

/** Asks one question; `secret` answers are not echoed. `undefined` at end of input. */
export type Ask = (question: string, options: { secret: boolean }) => Promise<string | undefined>;

const ANSWERS = [
  ["organizationName", "OCULUS_SETUP_ORGANIZATION", "Your organization's name"],
  ["siteName", "OCULUS_SETUP_SITE", "The first site's name (for example, Digital Archive)"],
  ["displayName", "OCULUS_SETUP_NAME", "Your name"],
  ["email", "OCULUS_SETUP_EMAIL", "Your email address (you sign in with it)"],
] as const;

const PATHS: Record<string, string> = {
  organizationName: "Organization name",
  siteName: "Site name",
  displayName: "Your name",
  email: "Email address",
  password: "Password",
};

/** Runs the command; returns the exit code. */
export async function runSetupCli(
  env: Readonly<Record<string, string | undefined>>,
  ask: Ask,
  rawOut: Line,
  rawErr: Line,
  /** Called once every question is answered (the terminal lets go of the keyboard). */
  finished?: () => void,
): Promise<number> {
  const url = env[DATABASE_URL_VARIABLE];
  if (url === undefined || url.trim() === "") {
    rawErr(
      `${DATABASE_URL_VARIABLE} is not set. Set it to an empty database, e.g. postgresql://user@localhost:5432/oculus (put any password in ~/.pgpass or PGPASSWORD, not in a file in the repository).`,
    );
    return 2;
  }
  const secrets = secretsOf(url);
  const out: Line = (line) => {
    rawOut(redact(line, secrets));
  };
  const err: Line = (line) => {
    rawErr(redact(line, secrets));
  };
  let db: Database;
  try {
    db = openDatabase(url, { applicationName: "oculus-setup", max: 1 });
  } catch {
    err(`${DATABASE_URL_VARIABLE} is not a usable postgresql:// URL (its value is not shown).`);
    return 2;
  }
  try {
    // Checked before migrating, so setup never changes a database it refuses.
    let before: "empty" | "set_up" | "other";
    try {
      before = await databaseBeforeSetup(db);
    } catch (error) {
      err(`Setup stopped: could not check the database: ${messageOf(error)}`);
      return 1;
    }
    if (before === "set_up") {
      err(
        "Setup refused: this database is already set up (it has people or organizations). Setup only runs once, on an empty database. Sign in instead.",
      );
      return 1;
    }
    if (before === "other") {
      err(
        "Setup refused: this database isn't empty and isn't an Oculus database (it has tables, functions, extensions or settings of its own). Make a new, empty database for Oculus (`createdb oculus`) and point OCULUS_DATABASE_URL at it.",
      );
      return 1;
    }
    try {
      await migrate({ connectionString: url, log: out });
    } catch (error) {
      if (error instanceof MigrationError) {
        err(`Setup stopped: the database could not be prepared (${error.code}): ${error.message}`);
      } else {
        err(`Setup stopped: the database could not be prepared: ${messageOf(error)}`);
      }
      return 1;
    }
    if (!(await isEmptyInstall(db))) {
      err(
        "Setup refused: this database is already set up (it has people or organizations). Setup only runs once, on an empty database. Sign in instead.",
      );
      return 1;
    }
    out("");
    out("Setting up Oculus. Answer a few questions; nothing is saved until the end.");
    const answers: Record<string, string> = {};
    for (const [key, variable, question] of ANSWERS) {
      const given = env[variable];
      if (given !== undefined && given.trim() !== "") {
        answers[key] = given.trim();
        out(`${question}: ${given.trim()} (from ${variable})`);
        continue;
      }
      const typed = await ask(`${question}: `, { secret: false });
      if (typed === undefined) return endOfInput(err);
      answers[key] = typed.trim();
    }
    out(
      "Choose a password of at least 15 characters. A few unrelated words make a good one. It is not shown as you type.",
    );
    const password = await ask("Password: ", { secret: true });
    if (password === undefined) return endOfInput(err);
    const again = await ask("Password again: ", { secret: true });
    if (again === undefined) return endOfInput(err);
    if (password !== again) {
      err("Setup stopped: the two passwords were different. Nothing was saved; run it again.");
      return 1;
    }
    finished?.();
    const result = await setUpFirstInstall(db, { ...answers, password });
    if (!result.ok) {
      const already = result.issues.some((i) => i.code === "already_set_up");
      err(already ? "Setup refused:" : "Setup stopped. Nothing was saved. Please fix:");
      for (const issue of result.issues) {
        const where = PATHS[String(issue.path[0])];
        err(`- ${where === undefined ? "" : `${where}: `}${issue.message}`);
      }
      return 1;
    }
    out("");
    out(`Done. Oculus is set up for ${answers.organizationName ?? ""}.`);
    out(`- Site: ${answers.siteName ?? ""}`);
    out(
      `- System admin: ${answers.displayName ?? ""} (${normalizeEmail(answers.email) ?? answers.email ?? ""})`,
    );
    out(`- A starter template, "Item", that you can change later.`);
    out(
      "Next: on this computer, `npm run build` then `npm run desktop` (with the same OCULUS_DATABASE_URL, or the database in desktop.json) opens Oculus in its own window; on a server, start the admin as packages/admin/README.md describes (`npm run build`, then `npm run admin` with OCULUS_DATABASE_URL, OCULUS_ORIGINS, OCULUS_ADMIN_ORIGIN, OCULUS_SECRET_KEY and OCULUS_FILES_DIR set). Then sign in. At your first sign-in you set up two-step sign-in with an authenticator app.",
    );
    return 0;
  } catch (error) {
    err(`Setup failed: ${messageOf(error)}. Nothing was saved.`);
    return 1;
  } finally {
    await db.close();
  }
}

function endOfInput(err: Line): number {
  err("Setup stopped: the input ended before every question was answered. Nothing was saved.");
  return 2;
}

function messageOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : "unknown error";
  return typeof code === "string" ? `${message} (${code})` : message;
}

/**
 * Questions on the terminal (or standard input). The prompt is made at the
 * first question, after migrating, so Ctrl+C still stops a migration; it
 * keeps no history (Up can't recall the first password), and on a terminal
 * anything typed before a question (during migration, or a half-typed
 * line between questions) is thrown away rather than taken as the answer,
 * and secret answers are not echoed. Ctrl+C at a question ends the
 * input, so the command stops with nothing saved.
 */
export function terminalAsk(): { ask: Ask; close: () => void } {
  const tty = process.stdin.isTTY;
  let muted = false;
  let rl: Interface | undefined;
  let settled: Promise<void> = Promise.resolve();
  let settling = false;
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  /** On a terminal, throws away a half-typed line (Ctrl+E, then Ctrl+U). */
  const clearLine = (r: Interface): void => {
    if (!tty) return;
    r.write(null, { ctrl: true, name: "e" });
    r.write(null, { ctrl: true, name: "u" });
  };
  const open = (): Interface => {
    if (rl !== undefined) return rl;
    const made = createInterface({ input: process.stdin, output, terminal: tty, historySize: 0 });
    made.on("line", (line) => {
      if (settling) return; // typed before the first question (during migration)
      const next = waiting.shift();
      if (next !== undefined) next(line);
      else if (!tty) lines.push(line); // piped answers arrive before their questions
    });
    made.on("SIGINT", () => {
      made.close();
    });
    made.on("close", () => {
      ended = true;
      for (const next of waiting.splice(0)) next(undefined);
    });
    if (tty) {
      // Keys pressed while migrating were held by the terminal and arrive
      // now: let them in, unseen, and drop them before the first question.
      settling = true;
      muted = true;
      settled = new Promise((resolve) => {
        setTimeout(() => {
          made.setPrompt("");
          clearLine(made);
          settling = false;
          muted = false;
          resolve();
        }, 200);
      });
    }
    rl = made;
    return made;
  };
  const ask: Ask = async (question, { secret }) => {
    const r = open();
    await settled;
    return new Promise((resolve) => {
      const finish = (line: string | undefined): void => {
        if (muted) process.stdout.write("\n");
        muted = false;
        resolve(line);
      };
      const ready = lines.shift();
      if (ready !== undefined) {
        process.stdout.write(`${question}\n`);
        finish(ready);
        return;
      }
      if (ended) {
        finish(undefined);
        return;
      }
      // A half-typed line between questions is not an answer: drop it unseen.
      muted = true;
      r.setPrompt("");
      clearLine(r);
      muted = false;
      if (secret && tty) {
        process.stdout.write(question);
        muted = true;
        r.setPrompt("");
      } else {
        r.setPrompt(question);
      }
      waiting.push(finish);
      r.prompt();
    });
  };
  return {
    ask,
    close: () => {
      rl?.close();
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const terminal = terminalAsk();
  try {
    process.exitCode = await runSetupCli(
      process.env,
      terminal.ask,
      (line) => {
        console.log(line);
      },
      (line) => {
        console.error(line);
      },
      terminal.close,
    );
  } finally {
    terminal.close();
  }
}
