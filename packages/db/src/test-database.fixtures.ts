/**
 * Test databases (D-049, D-053). `npm run gate` starts a throwaway server and
 * sets OCULUS_TEST_DATABASE_URL; CI points it at a service container. Each
 * test file makes its own fresh databases on that server and drops them
 * afterwards. With no server, database tests fail; they are never skipped.
 */
import { randomBytes } from "node:crypto";
import { createDatabase, dropDatabase, withDatabaseName } from "./client.js";

export const TEST_URL_VARIABLE = "OCULUS_TEST_DATABASE_URL";

export function testServerUrl(): string {
  const url = process.env[TEST_URL_VARIABLE];
  if (url === undefined || url.trim() === "") {
    throw new Error(
      `${TEST_URL_VARIABLE} is not set, so database tests can't run. Run \`npm run gate\`, which starts a throwaway PostgreSQL, or set ${TEST_URL_VARIABLE} to a server where you may create databases.`,
    );
  }
  return url;
}

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/** Creates a new, empty database on the test server. */
export async function freshDatabase(): Promise<TestDatabase> {
  const server = testServerUrl();
  const name = `oculus_test_${randomBytes(8).toString("hex")}`;
  await createDatabase(server, name);
  return {
    name,
    url: withDatabaseName(server, name),
    drop: () => dropDatabase(server, name),
  };
}
