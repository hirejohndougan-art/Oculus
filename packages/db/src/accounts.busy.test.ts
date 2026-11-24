// signIn when the password work queue is full before this process has made
// its dummy hash (D-068): it answers `busy` instead of throwing, and touches
// no database. Its own file, so the dummy hash isn't made yet.
import { describe, expect, it } from "vitest";
import { MAX_CONCURRENT_HASHES, MAX_QUEUED_HASHES, hashPassword } from "@oculus/core";
import { signIn } from "./accounts.js";
import type { Database } from "./client.js";

const noDatabase = new Proxy({} as Database, {
  get() {
    throw new Error("signIn reached the database");
  },
});

describe("signIn under a full password queue", () => {
  it("answers busy when even the first dummy hash can't be queued", async () => {
    const flood = Array.from({ length: MAX_CONCURRENT_HASHES + MAX_QUEUED_HASHES }, () =>
      hashPassword("filling the queue for a test"),
    );
    const r = await signIn(noDatabase, {
      email: "nobody@example.org",
      password: "any guess at all",
      source: "192.0.2.10",
    });
    expect(r).toMatchObject({ ok: false, code: "busy" });
    await Promise.all(flood);
  }, 60_000);
});
