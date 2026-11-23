import { describe, expect, it } from "vitest";
import { findPostgresBin, socketUrl } from "./test-database.mjs";

describe("throwaway test database helpers", () => {
  it("builds a socket URL the pg driver reads, with the directory encoded", () => {
    const url = socketUrl("/tmp/oculus-pg-abc");
    expect(url).toBe("postgresql://postgres@localhost/postgres?host=%2Ftmp%2Foculus-pg-abc");
    expect(decodeURIComponent(url.split("?host=")[1])).toBe("/tmp/oculus-pg-abc");
  });

  it("finds no binaries in a PG_BIN without initdb", () => {
    expect(findPostgresBin({ PG_BIN: "/nonexistent/oculus" })).toBeUndefined();
  });
});
