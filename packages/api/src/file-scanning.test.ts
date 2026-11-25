// The virus scanner's settings (S-040, D-113): none set means no scanner
// (the desktop trial runs without ClamAV); a socket or a loopback host;
// the defaults; and every malformed value refused, naming the variable and
// never the value.
import { describe, expect, it } from "vitest";
import { CLAMD_DEFAULT_STREAM_MAX_BYTES } from "@oculus/service";
import { scannerFromEnv } from "./file-scanning.js";

describe("scannerFromEnv", () => {
  it("is off when nothing says where clamd is", () => {
    expect(scannerFromEnv({})).toBeUndefined();
    expect(scannerFromEnv({ OCULUS_CLAMD_SOCKET: " ", OCULUS_CLAMD_HOST: "" })).toBeUndefined();
  });

  it("takes a socket, with the defaults", () => {
    expect(scannerFromEnv({ OCULUS_CLAMD_SOCKET: "/run/clamav/clamd.ctl" })).toEqual({
      clamd: {
        address: { socket: "/run/clamav/clamd.ctl" },
        timeoutMs: 120_000,
        streamMaxBytes: CLAMD_DEFAULT_STREAM_MAX_BYTES,
      },
      concurrency: 2,
    });
  });

  it("takes a loopback host and port, and the limits", () => {
    expect(
      scannerFromEnv({
        OCULUS_CLAMD_HOST: "127.0.0.1",
        OCULUS_CLAMD_PORT: "3311",
        OCULUS_CLAMD_TIMEOUT_SECONDS: "30",
        OCULUS_CLAMD_STREAM_MAX_MIB: "500",
        OCULUS_CLAMD_CONCURRENCY: "1",
      }),
    ).toEqual({
      clamd: {
        address: { host: "127.0.0.1", port: 3311 },
        timeoutMs: 30_000,
        streamMaxBytes: 500 * 1024 * 1024,
      },
      concurrency: 1,
    });
    expect(scannerFromEnv({ OCULUS_CLAMD_HOST: "::1" })?.clamd.address).toEqual({
      host: "::1",
      port: 3310,
    });
  });

  it("refuses what it can't use, naming the variable but never the value", () => {
    const cases: [Record<string, string>, string][] = [
      [{ OCULUS_CLAMD_HOST: "192.0.2.7" }, "OCULUS_CLAMD_HOST"],
      [{ OCULUS_CLAMD_HOST: "secret-host.example" }, "OCULUS_CLAMD_HOST"],
      [{ OCULUS_CLAMD_SOCKET: "relative/secret.sock" }, "OCULUS_CLAMD_SOCKET"],
      [{ OCULUS_CLAMD_SOCKET: "/run/clamd.ctl", OCULUS_CLAMD_HOST: "127.0.0.1" }, "not both"],
      [{ OCULUS_CLAMD_SOCKET: "/run/clamd.ctl", OCULUS_CLAMD_PORT: "3310" }, "OCULUS_CLAMD_PORT"],
      [{ OCULUS_CLAMD_HOST: "127.0.0.1", OCULUS_CLAMD_PORT: "99999" }, "OCULUS_CLAMD_PORT"],
      [{ OCULUS_CLAMD_HOST: "127.0.0.1", OCULUS_CLAMD_PORT: "secret" }, "OCULUS_CLAMD_PORT"],
      [
        { OCULUS_CLAMD_HOST: "127.0.0.1", OCULUS_CLAMD_TIMEOUT_SECONDS: "0" },
        "OCULUS_CLAMD_TIMEOUT_SECONDS",
      ],
      [
        { OCULUS_CLAMD_HOST: "127.0.0.1", OCULUS_CLAMD_STREAM_MAX_MIB: "4096" },
        "OCULUS_CLAMD_STREAM_MAX_MIB",
      ],
      [
        { OCULUS_CLAMD_HOST: "127.0.0.1", OCULUS_CLAMD_CONCURRENCY: "17" },
        "OCULUS_CLAMD_CONCURRENCY",
      ],
      // A limit without an address is a mistake, not "off".
      [{ OCULUS_CLAMD_TIMEOUT_SECONDS: "30" }, "OCULUS_CLAMD_TIMEOUT_SECONDS"],
    ];
    for (const [env, named] of cases) {
      let message = "";
      try {
        scannerFromEnv(env);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message, JSON.stringify(env)).toMatch(/^refusing to start: /);
      expect(message).toContain(named);
      expect(message).not.toMatch(/secret|192\.0\.2\.7|99999/);
    }
  });
});
