// `npm run holds` (T-034f): its usage, its refusals without a database, and
// the lines a pass prints. The pass itself is tested in the service
// (access-holds.test.ts).
import { describe, expect, it } from "vitest";
import { holdsLines, runHoldsCli } from "./holds-cli.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line: string) => {
        out.push(line);
      },
      err: (line: string) => {
        err.push(line);
      },
    },
  };
}

describe("npm run holds (T-034f)", () => {
  it("refuses an unknown option and a missing or unusable database URL", async () => {
    const a = io();
    expect(await runHoldsCli(["--now"], {}, a.io)).toBe(2);
    expect(a.err.join("\n")).toContain("Use:");
    const b = io();
    expect(await runHoldsCli([], {}, b.io)).toBe(2);
    expect(b.err.join("\n")).toContain("OCULUS_DATABASE_URL is not set");
    const c = io();
    const url = "mysql://someone:hunter2-invented@db.example.org/oculus";
    expect(await runHoldsCli(["--dry-run"], { OCULUS_DATABASE_URL: url }, c.io)).toBe(2);
    expect(c.err.join("\n")).not.toContain("hunter2");
  });

  it("prints what a pass did, and what a dry run would do", () => {
    const report = {
      dryRun: false,
      withdrawn: 1,
      published: 2,
      stillHeld: 0,
      blocked: 0,
      failed: 0,
      unknownDay: 0,
    };
    expect(holdsLines(report)).toEqual([
      "Access holds checked.",
      "Withdrawn (an accession holds them back): 1 record.",
      "Published again (no longer held back): 2 records.",
    ]);
    const dry = holdsLines({
      ...report,
      dryRun: true,
      stillHeld: 3,
      blocked: 1,
      failed: 1,
      unknownDay: 1,
    });
    expect(dry[0]).toBe("Dry run: nothing was changed.");
    expect(dry[1]).toContain("Would withdraw");
    expect(dry.join("\n")).toContain("Still held back, left withdrawn: 3 records.");
    expect(dry.join("\n")).toContain("another reason");
    expect(dry.join("\n")).toContain("Couldn't be checked or changed");
    expect(dry.at(-1)).toContain("time zone is no longer known");
  });
});
