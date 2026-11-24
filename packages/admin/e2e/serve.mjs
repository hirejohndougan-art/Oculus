// The end-to-end server: a throwaway PostgreSQL (scripts/test-database.mjs),
// migrated, with one invented organization, one site and one volunteer who
// has not set up two-step sign-in; then the admin's server (the built
// packages) on http://localhost:OCULUS_E2E_PORT serving the built admin.
// Writes the volunteer's invented address and password to OCULUS_E2E_SEED
// for the tests. Everything is stopped and deleted on SIGTERM or SIGINT.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newOrganizationId } from "@oculus/core";
import {
  acceptInvitation,
  createFirstSystemAdmin,
  createInvitation,
  insertOrganization,
  migrate,
  openDatabase,
} from "@oculus/db";
import { buildAdminServer } from "@oculus/api";
import { createService } from "@oculus/service";
import { findPostgresBin, startTestDatabase } from "../../../scripts/test-database.mjs";

const PASSWORD = "Invented river bend lantern 2026";
const port = Number(process.env.OCULUS_E2E_PORT ?? "4173");
const seedFile = process.env.OCULUS_E2E_SEED;
if (seedFile === undefined) throw new Error("OCULUS_E2E_SEED is not set");

const database = startTestDatabase({ bin: findPostgresBin() });
let app;
let db;
const stop = async () => {
  try {
    await app?.close();
    await db?.close();
  } finally {
    database.stop();
    rmSync(seedFile, { force: true });
    process.exit(0);
  }
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

try {
  await migrate({ connectionString: database.url });
  db = openDatabase(database.url, { max: 4 });
  const must = (result) => {
    if (!result.ok) throw new Error(JSON.stringify(result.issues ?? result));
    return result.value;
  };
  const root = must(
    await createFirstSystemAdmin(db, {
      email: "root@example.org",
      displayName: "Invented Root",
      password: PASSWORD,
    }),
  ).userId;
  const organizationId = newOrganizationId();
  must(await insertOrganization(db, { id: organizationId, name: "Invented Historical Society" }));
  const service = createService(db);
  const actor = { organizationId, actor: `user:${root}` };
  const site = must(await service.createSite(actor, { organizationId, name: "Invented Archive" }));
  const email = "volunteer@example.org";
  const box = [];
  must(
    await createInvitation(db, { organizationId, email, invitedBy: root }, (message) => {
      box.push(message);
      return Promise.resolve();
    }),
  );
  const volunteer = must(
    await acceptInvitation(db, {
      token: box[0].token,
      organizationId,
      email,
      displayName: "Ada Invented",
      password: PASSWORD,
    }),
  ).userId;
  must(
    await service.grantRole(actor, {
      userId: volunteer,
      role: "cataloger",
      siteId: site.id,
      scope: null,
    }),
  );
  const origin = `http://localhost:${String(port)}`;
  app = await buildAdminServer({
    db,
    env: {
      NODE_ENV: "test",
      OCULUS_ORIGINS: origin,
      OCULUS_ADMIN_ORIGIN: origin,
      // A fresh random key for this throwaway run only; never stored.
      OCULUS_SECRET_KEY: randomBytes(32).toString("base64url"),
    },
    adminDir: join(import.meta.dirname, "..", "dist"),
    log: () => undefined,
  });
  await app.listen({ host: "127.0.0.1", port });
  writeFileSync(
    seedFile,
    JSON.stringify({ email, password: PASSWORD, siteName: "Invented Archive" }),
  );
} catch (error) {
  console.error(error);
  await stop();
}
