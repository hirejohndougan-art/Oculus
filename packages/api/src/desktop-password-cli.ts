/**
 * `npm run desktop:password` (S-034a, D-097; on Windows
 * `node packages\api\dist\desktop-password-cli.js`): sets a new password
 * for an account on this computer's Oculus, for when there is no email to
 * send a "forgot your password" link.
 *
 * It is the ordinary reset (T-039, D-078) with this console as the mailbox:
 * `requestPasswordReset` makes a link for the address typed, the link's
 * token is handed to this process instead of an email (never shown), and
 * `completePasswordReset` sets the new password with it. So the same rules
 * hold: the password checks, every session of the account ends, two-step
 * sign-in is kept (the person still needs their code or a recovery code),
 * the reset counters apply, and an account with no two-step sign-in in use
 * can't be reset this way (D-078: only a system admin can). Unlike the
 * emailed reset, no "your password was changed" email is sent: the person
 * is at this computer.
 *
 * Who can run it: whoever can use this computer's settings folder and its
 * pgpass file, which already gives full use of the database. It uses only
 * the database `desktop.json` names (the writer's address, as the server
 * does), never one from the environment, so it can't be pointed at a
 * server elsewhere.
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  completePasswordReset,
  openDatabase,
  requestPasswordReset,
  terminalAsk,
  type Ask,
  type Database,
} from "@oculus/db";
import { DesktopError, readDesktopSettings, settingsFolder, type Env } from "./desktop.js";

type Line = (line: string) => void;

export interface DesktopPasswordOptions {
  env: Env;
  ask: Ask;
  out: Line;
  err: Line;
  platform?: NodeJS.Platform;
  home?: string;
  finished?: () => void;
  /** The background wait before the link is made (tests pass 0). */
  backgroundDelayMs?: { min: number; max: number };
}

const OUTCOMES: Record<string, string> = {
  not_sent: "No account that can sign in has that email address. Nothing was changed.",
  needs_admin:
    "That account has no two-step sign-in in use (never set up, or reset), so its password can only be reset by a system admin, from People in the admin (D-078). Nothing was changed.",
  busy: "Oculus is busy checking passwords. Try again in a moment.",
  database_unavailable: "Can't reach the database. Check that PostgreSQL is running.",
};

/** Runs the command; returns the exit code. */
export async function runDesktopPassword(options: DesktopPasswordOptions): Promise<number> {
  const { ask, out, err } = options;
  const platform = options.platform ?? process.platform;
  let url: string | undefined;
  try {
    const folder = settingsFolder(platform, options.env, options.home ?? homedir());
    url = readDesktopSettings(folder).databaseUrl;
  } catch (error) {
    if (error instanceof DesktopError) {
      err(error.message);
      return 1;
    }
    throw error;
  }
  if (url === undefined) {
    err(
      "This computer's Oculus settings (desktop.json) don't name a database yet. Set Oculus up first (start-oculus.cmd, or `npm run desktop:database`).",
    );
    return 2;
  }

  out("This sets a new password for an Oculus account on this computer.");
  const email = await ask("The account's email address: ", { secret: false });
  if (email === undefined || email.trim() === "") {
    err("No email address was given. Nothing was changed.");
    return 1;
  }

  let db: Database;
  try {
    db = openDatabase(url, { applicationName: "oculus-desktop-password", max: 2 });
  } catch {
    err('"databaseUrl" in desktop.json is not a usable postgresql:// address.');
    return 1;
  }
  try {
    // This console is the mailbox: the token stays in this process.
    let token: string | undefined;
    const settled = new Promise<string>((resolve) => {
      void requestPasswordReset(
        db,
        { email: email.trim(), source: "127.0.0.1" },
        (message) => {
          token = message.token;
          return Promise.resolve();
        },
        {
          backgroundDelayMs: options.backgroundDelayMs ?? { min: 0, max: 0 },
          onSettled: resolve,
        },
      ).then(
        (reply) => {
          if (!reply.ok) resolve(reply.code);
        },
        () => {
          resolve("failed");
        },
      );
    });
    const outcome = await settled;
    if (outcome !== "sent" || token === undefined) {
      err(
        outcome === "throttled"
          ? "Too many new-password requests (for that address, or from this computer). Wait a few minutes and try again."
          : (OUTCOMES[outcome] ?? "No new password was set. Try again."),
      );
      return 1;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const password = await ask("New password: ", { secret: true });
      if (password === undefined) {
        err("No password was given. Nothing was changed.");
        return 1;
      }
      const again = await ask("New password again: ", { secret: true });
      if (again !== password) {
        err("The two passwords aren't the same. Try again.");
        continue;
      }
      const done = await completePasswordReset(db, { token, password });
      if (done.ok) {
        options.finished?.();
        out(
          "Done. The new password works now; anyone signed in to that account was signed out. Two-step sign-in is unchanged: you still need your authenticator code (or a recovery code).",
        );
        return 0;
      }
      err(done.issues.map((i) => i.message).join(" "));
      // A password the rules refuse can be typed again; anything else (the
      // link, the database) can't be fixed here.
      if (!done.issues.every((i) => i.path[0] === "password")) return 1;
    }
    err("No new password was set.");
    return 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const terminal = terminalAsk();
  try {
    process.exitCode = await runDesktopPassword({
      env: process.env,
      ask: terminal.ask,
      out: (line) => {
        console.log(line);
      },
      err: (line) => {
        console.error(line);
      },
      finished: terminal.close,
    });
  } finally {
    terminal.close();
  }
}
