/**
 * Installs and rollbacks into the change log (T-060a, D-104): the update
 * manager's `changeLog` hook, writing one `system_events` row once the
 * switch is made. From the admin, the system manager who asked is the
 * actor (the manager's `by` is their user ID); from the release command on
 * the server's command line there is no account, so the row says so. A
 * `by` from the admin that isn't a user ID is refused (logged by the
 * manager), never written as if it came from the command line.
 */
import { isUserId } from "@oculus/core";
import { insertSystemEvent, type Database } from "@oculus/db";
import type { HistoryEntry } from "./update-manager.js";

export function updateChangeLog(
  db: Database,
  from: "admin" | "command_line",
): (entry: HistoryEntry) => Promise<void> {
  return async (entry) => {
    if (from === "admin" && !isUserId(entry.by)) {
      throw new TypeError("updateChangeLog: no system manager named.");
    }
    const actorId = from === "admin" && isUserId(entry.by) ? entry.by : null;
    await db.transaction((tx) =>
      insertSystemEvent(tx, {
        actorId,
        kind: entry.kind === "install" ? "update_installed" : "update_rolled_back",
        version: entry.version,
        fromVersion: entry.from,
      }),
    );
  };
}
