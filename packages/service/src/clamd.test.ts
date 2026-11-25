// The clamd client (S-040, D-113) against a fake clamd (clamd.fixtures.ts)
// on a Unix socket and on 127.0.0.1: clean, an EICAR-style FOUND, clamd's
// size limit (ours before connecting, and its own mid-stream), a clamd that
// never answers (the time limit), one that goes down mid-stream, garbage,
// an ERROR, a reply flood, chunk framing and backpressure, and the address
// rules. No real virus sample: the fake "finds" an invented marker.
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  clamdAddressProblem,
  isLoopback,
  parseClamdReply,
  pingClamd,
  scanWithClamd,
  type ClamdOptions,
} from "./clamd.js";
import {
  FAKE_SIGNATURE,
  FAKE_VIRUS_MARKER,
  startFakeClamd,
  type FakeClamd,
} from "./clamd.fixtures.js";
import { scanBackoffMs, MAX_SCAN_BACKOFF_MS } from "./file-scans.js";

const fakes: FakeClamd[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
});

async function fake(mode: Parameters<typeof startFakeClamd>[0] = {}): Promise<FakeClamd> {
  const started = await startFakeClamd(mode);
  fakes.push(started);
  return started;
}

const options = (f: FakeClamd, more: Partial<ClamdOptions> = {}): ClamdOptions => ({
  address: f.address,
  timeoutMs: 2000,
  streamMaxBytes: 1024 * 1024,
  ...more,
});

const bytes = (n: number, fill = 0x61): Buffer => Buffer.alloc(n, fill);

describe("scanning a stream", () => {
  for (const tcp of [false, true]) {
    it(`answers clean for "stream: OK" (${tcp ? "TCP 127.0.0.1" : "Unix socket"})`, async () => {
      const f = await fake({ mode: "ok", tcp });
      const body = bytes(200_000);
      expect(await scanWithClamd(options(f), Readable.from([body]), body.length)).toEqual({
        ok: true,
        verdict: "clean",
      });
      // Every byte arrived, framed as INSTREAM chunks of at most 64 KiB.
      expect(f.streams).toHaveLength(1);
      expect(f.streams[0]?.equals(body)).toBe(true);
      expect(f.largestChunk()).toBeLessThanOrEqual(64 * 1024);
      expect(f.problems).toEqual([]);
    });
  }

  it("reads an EICAR-style FOUND reply as infected, with the signature's name", async () => {
    const f = await fake({ mode: "detect" });
    const body = Buffer.from(`invented document ${FAKE_VIRUS_MARKER} more invented text`);
    expect(await scanWithClamd(options(f), Readable.from([body]), body.length)).toEqual({
      ok: true,
      verdict: "infected",
      signature: FAKE_SIGNATURE,
    });
    const harmless = Buffer.from("an invented harmless document");
    expect(await scanWithClamd(options(f), Readable.from([harmless]), harmless.length)).toEqual({
      ok: true,
      verdict: "clean",
    });
  });

  it("chunks as asked and never sends one longer than chunkBytes", async () => {
    const f = await fake({ mode: "ok" });
    const body = bytes(10_000);
    const answer = await scanWithClamd(
      options(f, { chunkBytes: 1000 }),
      Readable.from([body.subarray(0, 4500), body.subarray(4500)]),
      body.length,
    );
    expect(answer.ok).toBe(true);
    expect(f.largestChunk()).toBe(1000);
    expect(f.streams[0]?.equals(body)).toBe(true);
  });

  it("refuses a file over streamMaxBytes before connecting (too_large)", async () => {
    const f = await fake({ mode: "ok" });
    const body = bytes(2000);
    expect(
      await scanWithClamd(options(f, { streamMaxBytes: 1000 }), Readable.from([body]), 2000),
    ).toEqual({ ok: false, failure: "too_large" });
    expect(f.connections()).toBe(0);
  });

  it("stops sending when a stream turns out longer than its size says", async () => {
    const f = await fake({ mode: "ok" });
    const answer = await scanWithClamd(
      options(f, { streamMaxBytes: 1000, chunkBytes: 100 }),
      Readable.from([bytes(5000)]),
      900,
    );
    expect(answer).toEqual({ ok: false, failure: "too_large" });
  });

  it("reads clamd's own size limit mid-stream as too_large", async () => {
    const f = await fake({ mode: "size_limit", limit: 100_000 });
    const body = bytes(600_000);
    expect(await scanWithClamd(options(f), Readable.from([body]), body.length)).toEqual({
      ok: false,
      failure: "too_large",
    });
  });

  it("fails a clamd that never answers with a timeout, within the limit", async () => {
    const f = await fake({ mode: "silent" });
    const started = Date.now();
    const body = bytes(1000);
    expect(
      await scanWithClamd(options(f, { timeoutMs: 300 }), Readable.from([body]), body.length),
    ).toEqual({ ok: false, failure: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("fails a clamd that goes down mid-stream as unavailable, never clean", async () => {
    const f = await fake({ mode: "drop" });
    const body = bytes(400_000);
    expect(await scanWithClamd(options(f), Readable.from([body]), body.length)).toEqual({
      ok: false,
      failure: "unavailable",
    });
  });

  it("fails when nothing listens as unavailable", async () => {
    const f = await fake({ mode: "ok" });
    const address = f.address;
    await f.close();
    fakes.splice(fakes.indexOf(f), 1);
    const body = bytes(10);
    expect(
      await scanWithClamd(
        { address, timeoutMs: 1000, streamMaxBytes: 1000 },
        Readable.from([body]),
        10,
      ),
    ).toEqual({ ok: false, failure: "unavailable" });
  });

  it("reads garbage, a reply that isn't clamd's and a flood as protocol failures", async () => {
    const body = bytes(100);
    for (const mode of ["garbage", "nonsense", "flood"] as const) {
      const f = await fake({ mode });
      expect(await scanWithClamd(options(f), Readable.from([body]), body.length), mode).toEqual({
        ok: false,
        failure: "protocol",
      });
    }
  });

  it("reads an ERROR reply as refused", async () => {
    const f = await fake({ mode: "error" });
    const body = bytes(100);
    expect(await scanWithClamd(options(f), Readable.from([body]), body.length)).toEqual({
      ok: false,
      failure: "refused",
    });
  });

  it("fails a stream that can't be read to its end, without a verdict", async () => {
    const f = await fake({ mode: "ok" });
    const broken = new Readable({
      read() {
        this.destroy(new Error("invented read error"));
      },
    });
    expect(await scanWithClamd(options(f), broken, 100)).toEqual({
      ok: false,
      failure: "unavailable",
    });
  });

  it("waits for the socket to drain with a large file (backpressure)", async () => {
    const f = await fake({ mode: "ok" });
    const parts = Array.from({ length: 64 }, (_, i) => bytes(64 * 1024, i));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const answer = await scanWithClamd(
      options(f, { streamMaxBytes: 8 * 1024 * 1024 }),
      Readable.from(parts),
      total,
    );
    expect(answer).toEqual({ ok: true, verdict: "clean" });
    expect(f.streams[0]?.length).toBe(total);
  });
});

describe("the replies", () => {
  it("knows clamd's lines and nothing else", () => {
    expect(parseClamdReply("stream: OK")).toEqual({ ok: true, verdict: "clean" });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND")).toEqual({
      ok: true,
      verdict: "infected",
      signature: "Win.Test.EICAR_HDB-1",
    });
    // A name that isn't printable ASCII without spaces is kept as "unknown".
    expect(parseClamdReply("stream: two words FOUND")).toEqual({
      ok: true,
      verdict: "infected",
      signature: "unknown",
    });
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR")).toEqual({
      ok: false,
      failure: "too_large",
    });
    expect(parseClamdReply("lstat() failed ERROR")).toEqual({ ok: false, failure: "refused" });
    for (const text of ["", "stream: ok", "OK", "stream: OK extra", "PONG", "stream: FOUND"]) {
      expect(parseClamdReply(text), text).toEqual({ ok: false, failure: "protocol" });
    }
  });

  it("pings", async () => {
    const f = await fake({ mode: "ok" });
    expect(await pingClamd(options(f))).toBe(true);
    const g = await fake({ mode: "silent" });
    // The fake answers PING whatever its mode; a closed address doesn't.
    expect(await pingClamd(options(g))).toBe(true);
    const address = g.address;
    await g.close();
    fakes.splice(fakes.indexOf(g), 1);
    expect(await pingClamd({ address, timeoutMs: 500, streamMaxBytes: 10 })).toBe(false);
  });
});

describe("where clamd may be", () => {
  it("takes an absolute socket path, or a loopback address only", () => {
    expect(clamdAddressProblem({ socket: "/run/clamav/clamd.ctl" })).toBeUndefined();
    expect(clamdAddressProblem({ socket: "clamd.ctl" })).toMatch(/absolute/);
    expect(clamdAddressProblem({ host: "127.0.0.1", port: 3310 })).toBeUndefined();
    expect(clamdAddressProblem({ host: "::1", port: 3310 })).toBeUndefined();
    for (const host of ["10.0.0.5", "localhost", "clamd.example.org", "0.0.0.0", "::"]) {
      expect(clamdAddressProblem({ host, port: 3310 }), host).toMatch(/loopback/);
    }
    expect(clamdAddressProblem({ host: "127.0.0.1", port: 0 })).toMatch(/port/);
    expect(clamdAddressProblem({ host: "127.0.0.1", port: 70_000 })).toMatch(/port/);
    expect(isLoopback("127.8.9.10")).toBe(true);
    expect(isLoopback("0:0:0:0:0:0:0:1")).toBe(true);
  });
});

describe("the retry backoff", () => {
  it("grows from a minute by four times a try, at most six hours apart", () => {
    expect([1, 2, 3, 4].map(scanBackoffMs)).toEqual([60_000, 240_000, 960_000, 3_840_000]);
    expect(scanBackoffMs(9)).toBe(MAX_SCAN_BACKOFF_MS);
    expect(scanBackoffMs(1_000_000)).toBe(MAX_SCAN_BACKOFF_MS);
    expect(scanBackoffMs(0)).toBe(60_000);
  });
});
