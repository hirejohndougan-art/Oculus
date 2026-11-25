/**
 * What backup and restore must never leave behind (D-064): the private
 * directory holding the service file and password file, a partial backup
 * file, and the process groups of running tools. Each is registered while it
 * exists; the ordinary paths remove them as they finish, and a synchronous
 * handler on the process's `exit` removes whatever is left, so a second
 * Ctrl-C or the command's forced exit (both `process.exit`) still clean up.
 * Only SIGKILL of this process skips it; then the tools' watchdog still ends
 * the tools, and the private directory (0700, in the temporary directory) is
 * all that can remain.
 */
import { rmSync } from "node:fs";

const paths = new Set<string>();
const groups = new Set<number>();
const processes = new Set<number>();
let installed = false;

/** Kills every registered tool group and removes every registered path, synchronously. */
export function cleanUpNow(): void {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  groups.clear();
  for (const pid of processes) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  processes.clear();
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Nothing more can be done while exiting.
    }
  }
  paths.clear();
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on("exit", cleanUpNow);
}

/** Registers a path to remove on exit; returns the function that unregisters it. */
export function trackPath(path: string): () => void {
  install();
  paths.add(path);
  return () => {
    paths.delete(path);
  };
}

/** Registers a tool's process group to kill on exit; returns the function that unregisters it. */
export function trackGroup(pgid: number): () => void {
  install();
  groups.add(pgid);
  return () => {
    groups.delete(pgid);
  };
}

/** Registers a tool run directly (no process group, as on Windows) to kill on exit. */
export function trackProcess(pid: number): () => void {
  install();
  processes.add(pid);
  return () => {
    processes.delete(pid);
  };
}
