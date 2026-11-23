import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPostgresBin, serverEnvironment, serverOptions, socketUrl } from "./test-database.mjs";

describe("throwaway test database helpers", () => {
  it("builds a socket URL the pg driver reads, with the directory encoded", () => {
    const url = socketUrl("/tmp/oculus-pg-abc");
    expect(url).toBe("postgresql://postgres@localhost/postgres?host=%2Ftmp%2Foculus-pg-abc");
    expect(decodeURIComponent(url.split("?host=")[1])).toBe("/tmp/oculus-pg-abc");
  });

  it("finds no binaries in a PG_BIN without both initdb and pg_ctl", () => {
    expect(findPostgresBin({ PG_BIN: "/nonexistent/oculus" })).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "oculus-bin-"));
    try {
      writeFileSync(join(dir, "initdb"), "");
      expect(findPostgresBin({ PG_BIN: dir })).toBeUndefined();
      writeFileSync(join(dir, "pg_ctl"), "");
      expect(findPostgresBin({ PG_BIN: dir })).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the server commands only PATH and a C locale, never the caller's environment", () => {
    const env = serverEnvironment({
      PATH: "/usr/bin",
      OCULUS_DATABASE_URL: "postgresql://fake@example.invalid/x",
      PGPASSWORD: "obviously-fake",
      LD_PRELOAD: "/tmp/x.so",
    });
    expect(env).toEqual({ PATH: "/usr/bin", LANG: "C", LC_ALL: "C" });
  });

  it("passes settings on the command line: no TCP, socket in the directory, fsync off", () => {
    const options = serverOptions("/tmp/oculus-pg-abc");
    expect(options).toContain("-h ''");
    expect(options).toContain("-k /tmp/oculus-pg-abc");
    expect(options).toContain("-F");
    for (const unsafe of ["/tmp/a b", "/tmp/a'b", "/tmp/a;rm -rf x", "/tmp/$(x)"]) {
      expect(() => serverOptions(unsafe)).toThrow(/can't pass on safely/);
    }
  });
});
