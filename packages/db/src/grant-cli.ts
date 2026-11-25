/**
 * `node packages/db/dist/grant-cli.js <writer role>`: gives the writer role
 * its privileges (`grantWriterRole`, D-067) in the database named by
 * `OCULUS_DATABASE_URL`, connected as the owner of the tables (the
 * migrating role). Run after migrations, so tables a new migration made get
 * the writer's grants too (T-060, D-092). The URL is never printed.
 * Exit codes: 0 done, 1 failed, 2 usage.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./client.js";
import { DATABASE_URL_VARIABLE } from "./migrate-cli.js";
import { grantWriterRole } from "./roles.js";

export async function runGrantCli(
  args: readonly string[],
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const [role] = args;
  if (args.length !== 1 || role === undefined || !/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    err("Usage: node packages/db/dist/grant-cli.js <writer role (lower case, digits and _)>");
    return 2;
  }
  const url = env[DATABASE_URL_VARIABLE];
  if (url === undefined || url.trim() === "") {
    err(`${DATABASE_URL_VARIABLE} is not set.`);
    return 2;
  }
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(url, { applicationName: "oculus-grant" });
  } catch {
    err(`${DATABASE_URL_VARIABLE} is not a usable postgresql:// URL (its value is not shown).`);
    return 2;
  }
  try {
    await db.transaction((tx) => grantWriterRole(tx, role));
    out(`Done: the writer's privileges granted to ${role}.`);
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    err(`Grant failed${typeof code === "string" ? ` (${code})` : ""}.`);
    return 1;
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exitCode = await runGrantCli(
    process.argv.slice(2),
    process.env,
    (line) => {
      console.log(line);
    },
    (line) => {
      console.error(line);
    },
  );
}
