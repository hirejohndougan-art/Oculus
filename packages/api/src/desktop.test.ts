import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecretKeyring } from "@oculus/db";
import {
  appWindowArgs,
  browserCandidates,
  chooseDatabaseUrl,
  choosePort,
  DesktopError,
  ensureSettingsFolder,
  findAppBrowser,
  loadOrCreateSecretKey,
  anyFreePort,
  databaseLabel,
  instanceAnswers,
  instanceProof,
  readDesktopSettings,
  readLock,
  settingsFolder,
  STARTING_LOCK_MS,
  takeLock,
  urlHasPassword,
  windowProfileFolder,
} from "./desktop.js";

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "oculus-desktop-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof DesktopError) return error.code;
    throw error;
  }
  return undefined;
}

describe("settingsFolder", () => {
  it("uses APPDATA on Windows, Application Support on macOS and XDG elsewhere", () => {
    expect(
      settingsFolder("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a"),
    ).toBe(join("C:\\Users\\a\\AppData\\Roaming", "Oculus"));
    expect(settingsFolder("darwin", {}, "/Users/a")).toBe(
      "/Users/a/Library/Application Support/Oculus",
    );
    expect(settingsFolder("linux", {}, "/home/a")).toBe("/home/a/.config/oculus");
    expect(settingsFolder("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/a")).toBe("/xdg/oculus");
  });

  it("ignores a relative XDG_CONFIG_HOME, as the spec says", () => {
    expect(settingsFolder("linux", { XDG_CONFIG_HOME: "rel" }, "/home/a")).toBe(
      "/home/a/.config/oculus",
    );
  });

  it("takes OCULUS_DESKTOP_HOME first", () => {
    expect(settingsFolder("win32", { OCULUS_DESKTOP_HOME: "/given", APPDATA: "x" }, "/h")).toBe(
      "/given",
    );
  });

  it("refuses when there is nowhere to keep settings", () => {
    expect(codeOf(() => settingsFolder("win32", {}, "C:\\h"))).toBe("no_settings_folder");
    expect(codeOf(() => settingsFolder("linux", {}, ""))).toBe("no_settings_folder");
  });

  it("makes the folder readable only by its owner", () => {
    const made = join(folder, "made", "here");
    ensureSettingsFolder(made);
    if (process.platform !== "win32") expect(statSync(made).mode & 0o077).toBe(0);
  });
});

describe("readDesktopSettings", () => {
  const write = (text: string) => {
    writeFileSync(join(folder, "desktop.json"), text);
  };

  it("is empty with no file", () => {
    expect(readDesktopSettings(folder)).toEqual({});
  });

  it("reads the database and the port", () => {
    write('{"databaseUrl":"postgresql://oculus@localhost:5432/oculus","port":4999}');
    expect(readDesktopSettings(folder)).toEqual({
      databaseUrl: "postgresql://oculus@localhost:5432/oculus",
      port: 4999,
    });
  });

  it("reads a file Notepad saved with a byte-order mark", () => {
    write('\uFEFF{"port":4999}');
    expect(readDesktopSettings(folder)).toEqual({ port: 4999 });
  });

  it("refuses a password in the address, without repeating it", () => {
    for (const url of [
      "postgresql://oculus:Invented-pw-77@localhost/oculus",
      "postgresql://oculus@localhost/oculus?password=Invented-pw-77",
    ]) {
      write(JSON.stringify({ databaseUrl: url }));
      let message = "";
      try {
        readDesktopSettings(folder);
      } catch (error) {
        message = (error as DesktopError).message;
        expect((error as DesktopError).code).toBe("password_in_settings");
      }
      expect(message).toContain("pgpass");
      expect(message).not.toContain("Invented-pw-77");
    }
  });

  it("refuses bad JSON, non-objects, unknown settings, bad ports and other addresses", () => {
    for (const [text, code] of [
      ["{", "settings_unreadable"],
      ["[1]", "settings_invalid"],
      ["null", "settings_invalid"],
      ['{"databaseURL":"postgresql://x"}', "settings_invalid"],
      ['{"port":80}', "settings_invalid"],
      ['{"port":4780.5}', "settings_invalid"],
      ['{"port":"4780"}', "settings_invalid"],
      ['{"databaseUrl":"mysql://x"}', "settings_invalid"],
      ['{"databaseUrl":7}', "settings_invalid"],
    ] as const) {
      write(text);
      expect(
        codeOf(() => readDesktopSettings(folder)),
        text,
      ).toBe(code);
    }
  });
});

describe("urlHasPassword", () => {
  it("finds a password in either place, and none in a plain address", () => {
    expect(urlHasPassword("postgresql://a:b@h/d")).toBe(true);
    expect(urlHasPassword("postgresql://a@h/d?password=b")).toBe(true);
    expect(urlHasPassword("postgresql://a@h/d")).toBe(false);
    expect(urlHasPassword("not a url")).toBe(false);
  });
});

describe("chooseDatabaseUrl", () => {
  it("takes OCULUS_DATABASE_URL first, then the settings", () => {
    expect(
      chooseDatabaseUrl(
        { OCULUS_DATABASE_URL: "postgresql://e/d" },
        { databaseUrl: "postgresql://s/d" },
        folder,
      ),
    ).toBe("postgresql://e/d");
    expect(
      chooseDatabaseUrl({ OCULUS_DATABASE_URL: " " }, { databaseUrl: "postgresql://s/d" }, folder),
    ).toBe("postgresql://s/d");
  });

  it("explains how to set one up when there is none", () => {
    try {
      chooseDatabaseUrl({}, {}, folder);
      expect.unreachable();
    } catch (error) {
      expect((error as DesktopError).code).toBe("no_database");
      expect((error as DesktopError).message).toContain("npm run desktop:database");
      expect((error as DesktopError).message).toContain(join(folder, "desktop.json"));
    }
  });
});

describe("loadOrCreateSecretKey", () => {
  const platform = process.platform === "win32" ? "linux" : process.platform;

  it("makes a usable key once, readable only by its owner, and reuses it", () => {
    const first = loadOrCreateSecretKey(folder, {}, platform);
    expect(first.created).toBe(true);
    expect(() => loadSecretKeyring({ OCULUS_SECRET_KEY: first.key })).not.toThrow();
    const file = join(folder, "secret-key");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = loadOrCreateSecretKey(folder, {}, platform);
    expect(second).toEqual({ key: first.key, created: false });
  });

  it("takes OCULUS_SECRET_KEY instead, and makes no file", () => {
    const key = "x".repeat(10);
    expect(loadOrCreateSecretKey(folder, { OCULUS_SECRET_KEY: key }, platform)).toEqual({
      key,
      created: false,
    });
    expect(existsSync(join(folder, "secret-key"))).toBe(false);
  });

  it("refuses a key file other people can read (POSIX)", () => {
    loadOrCreateSecretKey(folder, {}, "linux");
    chmodSync(join(folder, "secret-key"), 0o644);
    expect(codeOf(() => loadOrCreateSecretKey(folder, {}, "linux"))).toBe("secret_key_exposed");
  });

  it("refuses a key file that holds no usable key, without replacing it", () => {
    writeFileSync(join(folder, "secret-key"), "short\n", { mode: 0o600 });
    expect(codeOf(() => loadOrCreateSecretKey(folder, {}, platform))).toBe("secret_key_invalid");
    expect(readFileSync(join(folder, "secret-key"), "utf8")).toBe("short\n");
  });
});

describe("findAppBrowser", () => {
  it("takes OCULUS_DESKTOP_BROWSER first", () => {
    expect(findAppBrowser("linux", { OCULUS_DESKTOP_BROWSER: "/my/browser" }, () => false)).toBe(
      "/my/browser",
    );
  });

  it("prefers Edge, then Chrome, on Windows", () => {
    const env = { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\L" };
    const all = browserCandidates("win32", env);
    expect(all[0]).toBe(join("C:\\PF86", "Microsoft", "Edge", "Application", "msedge.exe"));
    const chrome = join("C:\\L", "Google", "Chrome", "Application", "chrome.exe");
    expect(findAppBrowser("win32", env, (p) => p === chrome)).toBe(chrome);
  });

  it("finds none when nothing is installed", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(findAppBrowser(platform, {}, () => false)).toBeUndefined();
    }
  });
});

describe("appWindowArgs", () => {
  it("opens an app window with Oculus's own profile and no extensions", () => {
    const args = appWindowArgs("http://127.0.0.1:4780/", "/p/window");
    expect(args).toContain("--app=http://127.0.0.1:4780/");
    expect(args).toContain("--user-data-dir=/p/window");
    expect(args).toContain("--disable-extensions");
  });
});

describe("choosePort", () => {
  let busy: Server | undefined;
  afterEach(async () => {
    const server = busy;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    busy = undefined;
  });

  it("keeps a free port and moves off a taken one", async () => {
    busy = createServer();
    const taken = await new Promise<number>((resolve) => {
      busy?.listen(0, "127.0.0.1", () => {
        const address = busy?.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    const other = await choosePort(taken);
    expect(other).not.toBe(taken);
    expect(await choosePort(other)).toBe(other);
  });
});

/** A local HTTP server answering `/desktop/instance` with `answer(challenge)` after `delayMs`. */
async function instanceServer(
  answer: (challenge: string) => unknown,
  delayMs = 0,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((request, reply) => {
    const challenge = new URL(request.url ?? "/", "http://x").searchParams.get("challenge") ?? "";
    setTimeout(() => {
      reply.setHeader("content-type", "application/json");
      reply.end(JSON.stringify(answer(challenge)));
    }, delayMs);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe("the launcher lock", () => {
  const lockFile = () => join(folder, "desktop.lock");
  const write = (value: object) => {
    writeFileSync(lockFile(), JSON.stringify(value));
  };
  const token = "t".repeat(43);

  it("is taken once; a second start while the first is still starting is told so", async () => {
    const first = await takeLock(folder, "oculus on localhost");
    expect(first.kind).toBe("taken");
    if (process.platform !== "win32") expect(statSync(lockFile()).mode & 0o777).toBe(0o600);
    // Another process holding a fresh lock with no address yet: starting.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      write({ pid: child.pid, token, database: "x", started: Date.now() });
      expect((await takeLock(folder, "x")).kind).toBe("starting");
      // The same lock, but older than a start can take: stale.
      write({ pid: child.pid, token, database: "x", started: Date.now() - STARTING_LOCK_MS - 1 });
      expect((await takeLock(folder, "x")).kind).toBe("taken");
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });

  it("treats a lock whose process lives but whose address doesn't answer as stale (a reused PID)", async () => {
    // PID 1 always lives (or answers EPERM); nothing listens on the address.
    const port = await anyFreePort();
    write({
      pid: 1,
      token,
      database: "x",
      started: Date.now(),
      url: `http://127.0.0.1:${String(port)}/`,
    });
    const outcome = await takeLock(folder, "x");
    expect(outcome.kind).toBe("taken");
  });

  it("treats a program on the lock's port that doesn't know the token as stale", async () => {
    const impostor = await instanceServer(() => ({ proof: "0".repeat(64) }));
    try {
      const url = impostor.url;
      write({ pid: 1, token, database: "x", started: Date.now(), url });
      expect(await instanceAnswers({ pid: 1, token, database: "x", started: 0, url })).toBe("no");
      expect((await takeLock(folder, "x")).kind).toBe("taken");
    } finally {
      await impostor.close();
    }
  });

  it("finds a running launcher only by a proof of its token", async () => {
    const real = await instanceServer((challenge) => ({ proof: instanceProof(token, challenge) }));
    try {
      const url = real.url;
      write({ pid: 1, token, database: "x", started: Date.now(), url });
      expect(await takeLock(folder, "x")).toEqual({
        kind: "running",
        lock: { pid: 1, token, database: "x", started: expect.any(Number) as number, url },
      });
    } finally {
      await real.close();
    }
  });

  it("never takes a live launcher that's slow to answer for a stale one", async () => {
    const slow = await instanceServer(
      (challenge) => ({ proof: instanceProof(token, challenge) }),
      1500,
    );
    try {
      write({ pid: 1, token, database: "x", started: Date.now(), url: slow.url });
      expect((await takeLock(folder, "x", Date.now, 200)).kind).toBe("busy");
      expect(readLock(folder)?.token).toBe(token);
    } finally {
      await slow.close();
    }
  });

  it("lets only one of two simultaneous starts take over a stale lock", async () => {
    const port = await anyFreePort();
    write({
      pid: 1,
      token,
      database: "x",
      started: Date.now(),
      url: `http://127.0.0.1:${String(port)}/`,
    });
    const outcomes = await Promise.all([
      takeLock(folder, "x"),
      takeLock(folder, "x"),
      takeLock(folder, "x"),
    ]);
    // Exactly one start ends up owning the lock; any other that briefly
    // took it finds it lost when it writes its address, and stops.
    const owners = outcomes.filter((o) => o.kind === "taken" && o.owned());
    expect(owners).toHaveLength(1);
    for (const o of outcomes) {
      if (o.kind === "taken" && o !== owners[0])
        expect(o.setUrl("http://127.0.0.1:2/")).toBe(false);
    }
    expect(outcomes.filter((o) => o.kind === "starting").length).toBeGreaterThanOrEqual(1);
  });

  it("ignores garbage and any address but 127.0.0.1", async () => {
    for (const text of [
      "{",
      "[]",
      JSON.stringify({ pid: 1, token, database: "x", started: 0, url: "http://evil.example/" }),
      JSON.stringify({ pid: 1, token: "short", database: "x", started: 0 }),
    ]) {
      writeFileSync(lockFile(), text);
      expect(readLock(folder), text).toBeUndefined();
    }
    expect((await takeLock(folder, "x")).kind).toBe("taken");
  });

  it("records the address, and releases only its own lock", async () => {
    const outcome = await takeLock(folder, "x");
    if (outcome.kind !== "taken") throw new Error(outcome.kind);
    expect(outcome.setUrl("http://127.0.0.1:4780/")).toBe(true);
    expect(readLock(folder)?.url).toBe("http://127.0.0.1:4780/");
    write({ pid: 1, token, database: "x", started: 0 });
    outcome.release();
    expect(existsSync(lockFile())).toBe(true);
    expect(outcome.setUrl("http://127.0.0.1:1/")).toBe(false);
    expect(readLock(folder)?.token).toBe(token);
  });
});

describe("databaseLabel", () => {
  it("names the database and host, never the password", () => {
    expect(databaseLabel("postgresql://o:Invented-pw-9@db.example:5433/oculus")).toBe(
      "oculus as o on db.example:5433",
    );
    expect(databaseLabel("postgresql://o@localhost/oculus?host=%2Ftmp%2Fs")).toBe(
      "oculus as o on /tmp/s",
    );
    expect(databaseLabel("postgresql://o@localhost/other?host=%2Ftmp%2Fs")).not.toBe(
      databaseLabel("postgresql://o@localhost/oculus?host=%2Ftmp%2Fs"),
    );
  });
});

describe("windowProfileFolder", () => {
  it("puts the window's profile in LOCALAPPDATA on Windows", () => {
    expect(windowProfileFolder("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\R\\Oculus")).toBe(
      join("C:\\L", "Oculus", "window"),
    );
    expect(windowProfileFolder("linux", {}, "/h/.config/oculus")).toBe("/h/.config/oculus/window");
  });
});

describe("loadOrCreateSecretKey after a crash left the key file empty", () => {
  it("makes it again while nothing is sealed, and refuses once something is", () => {
    writeFileSync(join(folder, "secret-key"), "", { mode: 0o600 });
    expect(codeOf(() => loadOrCreateSecretKey(folder, {}, "linux", false))).toBe(
      "secret_key_invalid",
    );
    expect(loadOrCreateSecretKey(folder, {}, "linux", true).created).toBe(true);
  });
});

describe("loadOrCreateSecretKey with two-step set-ups in the database", () => {
  it("refuses to make a new key, which would lock everyone out", () => {
    expect(codeOf(() => loadOrCreateSecretKey(folder, {}, "linux", false))).toBe(
      "secret_key_missing",
    );
    expect(existsSync(join(folder, "secret-key"))).toBe(false);
    loadOrCreateSecretKey(folder, {}, "linux", true);
    expect(loadOrCreateSecretKey(folder, {}, "linux", false).created).toBe(false);
  });
});
