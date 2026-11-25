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
  readDesktopSettings,
  runningLauncher,
  settingsFolder,
  takeLock,
  urlHasPassword,
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
      expect((error as DesktopError).message).toContain("npm run setup");
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

describe("the launcher lock", () => {
  it("is found while another launcher's process lives, and ignored after", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      const pid = child.pid ?? 0;
      writeFileSync(
        join(folder, "desktop.lock"),
        JSON.stringify({ pid, url: "http://127.0.0.1:4780/" }),
      );
      expect(runningLauncher(folder)).toEqual({ pid, url: "http://127.0.0.1:4780/" });
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    expect(runningLauncher(folder)).toBeUndefined();
  });

  it("ignores its own lock, garbage, and any address but 127.0.0.1", () => {
    const release = takeLock(folder, "http://127.0.0.1:4780/");
    expect(runningLauncher(folder)).toBeUndefined();
    release();
    expect(existsSync(join(folder, "desktop.lock"))).toBe(false);
    for (const text of [
      "{",
      "[]",
      JSON.stringify({ pid: process.ppid, url: "http://evil.example/" }),
    ]) {
      writeFileSync(join(folder, "desktop.lock"), text);
      expect(runningLauncher(folder), text).toBeUndefined();
    }
  });

  it("removes only its own lock", () => {
    const release = takeLock(folder, "http://127.0.0.1:4780/");
    writeFileSync(
      join(folder, "desktop.lock"),
      JSON.stringify({ pid: process.ppid, url: "http://127.0.0.1:1/" }),
    );
    release();
    expect(existsSync(join(folder, "desktop.lock"))).toBe(true);
  });
});
