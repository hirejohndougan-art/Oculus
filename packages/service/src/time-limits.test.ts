// A database time limit inside a service operation (S-063): a lock wait past
// the staff pool's `lock_timeout` (55P03) is answered like a statement past
// `statement_timeout` (57014): a clean `timeout` refusal, nothing thrown,
// the raw error only to `onError`.
import { randomUUID } from "node:crypto";
import { newOrganizationId, newRecordId } from "@oculus/core";
import { describe, expect, it } from "vitest";
import type { Database } from "@oculus/db";
import { createService } from "./service.js";

function failingWith(code: string): Database {
  const fail = (): Promise<never> =>
    Promise.reject(
      Object.assign(new Error("invented: role oculus_writer on db.example.org"), { code }),
    );
  return { rows: fail, execute: fail, transaction: fail, close: () => Promise.resolve() };
}

/** pg-pool's own error when no connection came free within its wait. */
function poolFull(): Database {
  const fail = (): Promise<never> =>
    Promise.reject(new Error("timeout exceeded when trying to connect"));
  return { rows: fail, execute: fail, transaction: fail, close: () => Promise.resolve() };
}

describe("time limits in the service (S-063)", () => {
  it("answers a lock timeout, a full pool and a statement timeout as a clean timeout refusal", async () => {
    const cases: [string, string][] = [
      ["55P03", "The database was busy and nothing was done. Try again."],
      ["pool", "The database was busy and nothing was done. Try again."],
      ["57014", "The change took too long and was stopped. Nothing was saved."],
    ];
    for (const [code, message] of cases) {
      const seen: unknown[] = [];
      const service = createService(code === "pool" ? poolFull() : failingWith(code), {
        onError: (error) => {
          seen.push(error);
        },
      });
      const result = await service.readRecord(
        { organizationId: newOrganizationId(), actor: `user:${randomUUID()}` },
        newRecordId(),
      );
      expect(result, code).toEqual({
        ok: false,
        issues: [
          {
            path: [],
            code: "timeout",
            message,
          },
        ],
      });
      expect(JSON.stringify(result)).not.toMatch(/oculus_writer|example/);
      expect(seen).toHaveLength(1);
    }
  });

  it("still answers anything else as internal_error", async () => {
    const service = createService(failingWith("XX000"), { onError: () => undefined });
    const result = await service.readRecord(
      { organizationId: newOrganizationId(), actor: `user:${randomUUID()}` },
      newRecordId(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]?.code).toBe("internal_error");
  });
});
