// The release command (T-060, D-092) on an invented repository: a package
// holds the built workspace packages (also as real copies where Node looks
// for them), the migrations, the built admin and the production
// dependencies only, never development ones or links; keygen, pack, verify
// and a first install work end to end, written into the change log as made
// on the command line (T-060a); and usage mistakes exit 2.
import { mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectRelease, productionDependencies, runReleaseCli } from "./release-cli.js";
import { verifyPackage, parseTrustedKeys } from "./update-package.js";
import { tempDir } from "./update.fixtures.js";
import { migrate, openDatabase, sql } from "@oculus/db";
import { freshDatabase } from "../../db/src/test-database.fixtures.js";

let repo: string;
let work: string;

async function put(path: string, text: string) {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), text);
}

const pkg = (deps: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "x", version: "0.0.0", dependencies: deps, ...extra });

beforeEach(async () => {
  repo = await tempDir("repo");
  work = await tempDir("work");
  await put(
    "package.json",
    JSON.stringify({ name: "oculus", version: "0.0.0", type: "module", license: "MIT" }),
  );
  await put("LICENSE", "MIT");
  await put("README.md", "# Invented");
  await put("packages/core/package.json", pkg());
  await put("packages/db/package.json", pkg({ "@oculus/core": "0.0.0", pg: "1" }));
  await put("packages/service/package.json", pkg({ "@oculus/db": "0.0.0" }));
  await put("packages/api/package.json", pkg({ fastify: "1" }));
  await put("packages/admin/package.json", pkg({ react: "1" }));
  for (const p of ["core", "db", "service", "api"])
    await put(`packages/${p}/dist/index.js`, `// ${p}`);
  await put("packages/db/dist/migrate-cli.js", "process.exitCode = 0;");
  await put("packages/api/src/secret-notes.ts", "// source isn't shipped");
  await put("packages/admin/dist/index.html", "<!doctype html>");
  await put("packages/db/migrations/0001_start.sql", "-- start");
  await put(
    "node_modules/pg/package.json",
    pkg({ "pg-types": "1" }, { optionalDependencies: { "pg-native": "1" } }),
  );
  await put("node_modules/pg/lib/index.js", "// pg");
  await put("node_modules/pg-types/package.json", pkg());
  await put("node_modules/pg-types/index.js", "// pg-types");
  await put("node_modules/fastify/package.json", pkg({ ajv: "2" }));
  await put("node_modules/fastify/fastify.js", "// fastify");
  // A nested copy wins for fastify; the top-level ajv is someone else's.
  await put("node_modules/fastify/node_modules/ajv/package.json", pkg());
  await put("node_modules/fastify/node_modules/ajv/index.js", "// ajv 2");
  await put("node_modules/ajv/package.json", pkg());
  await put("node_modules/react/package.json", pkg());
  await put("node_modules/vitest/package.json", pkg());
  await mkdir(join(repo, "node_modules/@oculus"), { recursive: true });
  await symlink(join(repo, "packages/core"), join(repo, "node_modules/@oculus/core"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe("what goes in a package", () => {
  it("lists the server's production dependencies, nested ones where Node finds them", async () => {
    expect(await productionDependencies(repo)).toEqual([
      "node_modules/fastify",
      "node_modules/fastify/node_modules/ajv",
      "node_modules/pg",
      "node_modules/pg-types",
    ]);
  });

  it("holds the built packages, copies for node_modules, migrations and the admin, nothing else", async () => {
    const names = (await collectRelease(repo, "1.0.0", "2026-11-24T00:00:00Z")).map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "oculus-release.json",
        "package.json",
        "packages/api/dist/index.js",
        "packages/db/migrations/0001_start.sql",
        "node_modules/@oculus/db/migrations/0001_start.sql",
        "node_modules/@oculus/core/dist/index.js",
        "packages/admin/dist/index.html",
        "node_modules/fastify/fastify.js",
        "node_modules/fastify/node_modules/ajv/index.js",
        "node_modules/pg-types/index.js",
      ]),
    );
    expect(names.some((n) => n.includes("/src/"))).toBe(false);
    expect(
      names.some((n) => n.startsWith("node_modules/react") || n.startsWith("node_modules/vitest")),
    ).toBe(false);
    expect(names).not.toContain("node_modules/ajv/index.js");
  });

  it("writes the version into the release file and package.json", async () => {
    const files = await collectRelease(repo, "1.2.3", "2026-11-24T00:00:00Z");
    const read = (n: string) =>
      JSON.parse(Buffer.from(files.find((f) => f.name === n)?.data ?? []).toString()) as Record<
        string,
        unknown
      >;
    expect(read("oculus-release.json")).toEqual({
      version: "1.2.3",
      builtAt: "2026-11-24T00:00:00Z",
    });
    expect(read("package.json")).toMatchObject({
      version: "1.2.3",
      scripts: { start: "node packages/api/dist/admin-cli.js" },
    });
  });

  it("refuses a link inside a dependency, and a missing build or dependency", async () => {
    await symlink("/etc/passwd", join(repo, "node_modules/pg/lib/passwd"));
    await expect(collectRelease(repo, "1.0.0", "x")).rejects.toThrow(/link/);
    await rm(join(repo, "node_modules/pg/lib/passwd"));
    await rm(join(repo, "node_modules/pg-types"), { recursive: true });
    await expect(collectRelease(repo, "1.0.0", "x")).rejects.toThrow(/pg-types isn't installed/);
    await rm(join(repo, "packages/admin/dist"), { recursive: true });
    await expect(collectRelease(repo, "1.0.0", "x")).rejects.toThrow(/npm run build/);
  });
});

describe("the commands", () => {
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  const run = (args: string[], env: Record<string, string> = {}) =>
    runReleaseCli(args, { INIT_CWD: work, ...env }, out, out, repo);

  it("keygen, pack, verify and a first install", async () => {
    lines.length = 0;
    expect(await run(["keygen", "--out", "main.pem"])).toBe(0);
    expect((await stat(join(work, "main.pem"))).mode & 0o777).toBe(0o600);
    const publicKey = /ed25519:[A-Za-z0-9_-]{43}/.exec(lines.join("\n"))?.[0] ?? "";
    expect(await run(["keygen", "--out", "main.pem"])).toBe(1);

    expect(
      await run(["pack", "--key", "main.pem", "--version", "1.0.0", "--notes", "Invented."]),
    ).toBe(0);
    const verified = await verifyPackage(
      join(work, "oculus-1.0.0.zip"),
      parseTrustedKeys(publicKey),
    );
    expect(verified.manifest.notes).toBe("Invented.");
    expect(await run(["pack", "--key", "main.pem", "--version", "1.0.0"])).toBe(1);

    expect(await run(["verify", "oculus-1.0.0.zip"], { OCULUS_UPDATE_KEYS: publicKey })).toBe(0);

    // The invented migrate script really runs, as a child process.
    expect(
      await run(["install", "oculus-1.0.0.zip", "--dir", "updates"], {
        OCULUS_UPDATE_KEYS: publicKey,
        OCULUS_DATABASE_URL: "postgresql://owner@db.example.org/invented",
      }),
    ).toBe(0);
    expect(await readlink(join(work, "updates", "current"))).toBe(join("releases", "1.0.0"));
    expect(
      await readFile(join(work, "updates", "current", "packages/api/dist/index.js"), "utf8"),
    ).toBe("// api");
    // That database can't be reached, so the change log has no row: it says so.
    expect(lines.join("\n")).toMatch(/couldn't be written into the change log/);
  }, 60_000);

  it("writes a first install into the change log, as made on the command line", async () => {
    const testDb = await freshDatabase();
    try {
      await migrate({ connectionString: testDb.url });
      lines.length = 0;
      await run(["keygen", "--out", "main.pem"]);
      const publicKey = /ed25519:[A-Za-z0-9_-]{43}/.exec(lines.join("\n"))?.[0] ?? "";
      await run(["pack", "--key", "main.pem", "--version", "1.0.0"]);
      lines.length = 0;
      expect(
        await run(["install", "oculus-1.0.0.zip", "--dir", "updates"], {
          OCULUS_UPDATE_KEYS: publicKey,
          OCULUS_DATABASE_URL: testDb.url,
        }),
      ).toBe(0);
      expect(lines.join("\n")).not.toMatch(/change log/);
      const db = openDatabase(testDb.url, { max: 1 });
      try {
        expect(
          await db.rows(
            sql`SELECT actor_id, kind, version, from_version FROM public.system_events`,
          ),
        ).toEqual([
          { actor_id: null, kind: "update_installed", version: "1.0.0", from_version: null },
        ]);
      } finally {
        await db.close();
      }
    } finally {
      await testDb.drop();
    }
  }, 60_000);

  it("refuses to verify against other keys", async () => {
    await run(["keygen", "--out", "a.pem"]);
    lines.length = 0;
    await run(["keygen", "--out", "b.pem"]);
    const other = /ed25519:[A-Za-z0-9_-]{43}/.exec(lines.join("\n"))?.[0] ?? "";
    await run(["pack", "--key", "a.pem", "--version", "1.0.0"]);
    lines.length = 0;
    expect(await run(["verify", "oculus-1.0.0.zip"], { OCULUS_UPDATE_KEYS: other })).toBe(1);
    expect(lines.join("\n")).toMatch(/unknown_key/);
  });

  it.each([
    [[]],
    [["pack", "--key"]],
    [["pack", "--key", "k.pem"]],
    [["pack", "--key", "k.pem", "--version", "1.0"]],
    [["dance"]],
  ])("exits 2 for %j", async (args) => {
    expect(await run(args)).toBe(2);
  });
});
