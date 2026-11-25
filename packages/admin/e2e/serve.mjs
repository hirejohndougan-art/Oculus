// The end-to-end server: a throwaway PostgreSQL (scripts/test-database.mjs),
// migrated, with one invented organization, one site, an object template,
// one invented record, a volunteer (cataloger) and an editor (reviewer: may
// publish and read history), neither of whom has set up two-step sign-in;
// then the admin's server (the built packages) on
// http://localhost:OCULUS_E2E_PORT serving the built admin. Writes the
// invented addresses, password and record title to OCULUS_E2E_SEED for the
// tests. Everything is stopped and deleted on SIGTERM or SIGINT.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newOrganizationId } from "@oculus/core";
import {
  acceptInvitation,
  createFirstSystemAdmin,
  createInvitation,
  insertOrganization,
  insertTemplateVersion,
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
// Uploaded files go here (M-002, D-086): OCULUS_FILES_DIR if given, else a
// fresh folder under the temporary directory, deleted on stop.
const ownFilesDir = process.env.OCULUS_FILES_DIR === undefined;
const filesDir = process.env.OCULUS_FILES_DIR ?? mkdtempSync(join(tmpdir(), "oculus-e2e-files-"));
let app;
let db;
const stop = async () => {
  try {
    await app?.close();
    await db?.close();
  } finally {
    database.stop();
    rmSync(seedFile, { force: true });
    if (ownFilesDir) rmSync(filesDir, { recursive: true, force: true });
    rmSync(`${seedFile}.root-recovery.json`, { force: true });
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
  // The editor: a reviewer on the site (edits, publishes, reads history).
  const editorEmail = "editor@example.org";
  must(
    await createInvitation(db, { organizationId, email: editorEmail, invitedBy: root }, (m) => {
      box.push(m);
      return Promise.resolve();
    }),
  );
  const editor = must(
    await acceptInvitation(db, {
      token: box[1].token,
      organizationId,
      email: editorEmail,
      displayName: "Grace Invented",
      password: PASSWORD,
    }),
  ).userId;
  must(
    await service.grantRole(actor, {
      userId: editor,
      role: "reviewer",
      siteId: site.id,
      scope: null,
    }),
  );
  // A third invented member for T-048's people test (people.spec.ts), so
  // resetting their two-step sign-in leaves the others' tests alone.
  const helperEmail = "helper@example.org";
  must(
    await createInvitation(db, { organizationId, email: helperEmail, invitedBy: root }, (m) => {
      box.push(m);
      return Promise.resolve();
    }),
  );
  const helper = must(
    await acceptInvitation(db, {
      token: box[2].token,
      organizationId,
      email: helperEmail,
      displayName: "Ben Invented",
      password: PASSWORD,
    }),
  ).userId;
  must(
    await service.grantRole(actor, {
      userId: helper,
      role: "cataloger",
      siteId: site.id,
      scope: null,
    }),
  );
  // A scanner on the site (attaches files to digital assets, M-002).
  const scannerEmail = "scanner@example.org";
  must(
    await createInvitation(db, { organizationId, email: scannerEmail, invitedBy: root }, (m) => {
      box.push(m);
      return Promise.resolve();
    }),
  );
  const scanner = must(
    await acceptInvitation(db, {
      token: box[3].token,
      organizationId,
      email: scannerEmail,
      displayName: "Lin Invented",
      password: PASSWORD,
    }),
  ).userId;
  must(
    await service.grantRole(actor, {
      userId: scanner,
      role: "scanner",
      siteId: site.id,
      scope: null,
    }),
  );
  // An object template and one invented record on the site.
  const field = (key, label, kind, extra = {}) => ({
    key,
    label,
    kind,
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...extra,
  });
  must(
    await insertTemplateVersion(db, {
      key: "object",
      organizationId,
      label: "Object",
      appliesTo: ["object"],
      fields: [
        field("rights", "Rights statement", "rights", {
          help: "A rightsstatements.org or Creative Commons address.",
        }),
        field("description", "Description", "long_text"),
        field("date", "Date", "date"),
        field("shelf", "Shelf location", "text", { visibility: "staff" }),
      ],
    }),
  );
  const recordTitle = "Invented depot lantern";
  must(
    await service.createRecord(
      { ...actor, siteId: site.id },
      {
        kind: "object",
        title: recordTitle,
        templateKey: "object",
        fields: {
          rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" },
          description: "A tin lantern from an invented depot.",
          date: "1909~",
        },
      },
    ),
  );
  // A digital asset template and one invented asset (no files yet).
  must(
    await insertTemplateVersion(db, {
      key: "photo",
      organizationId,
      label: "Photograph",
      appliesTo: ["digital_asset"],
      fields: [field("rights", "Rights statement", "rights"), field("caption", "Caption", "text")],
    }),
  );
  const assetTitle = "Invented depot photograph";
  must(
    await service.createRecord(
      { ...actor, siteId: site.id },
      {
        kind: "digital_asset",
        mediaType: "image/png",
        title: assetTitle,
        templateKey: "photo",
        fields: { rights: { uri: "http://rightsstatements.org/vocab/InC/1.0/" } },
      },
    ),
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
      OCULUS_FILES_DIR: filesDir,
    },
    adminDir: join(import.meta.dirname, "..", "dist"),
    log: () => undefined,
  });
  await app.listen({ host: "127.0.0.1", port });
  writeFileSync(
    seedFile,
    JSON.stringify({
      email,
      editorEmail,
      scannerEmail,
      password: PASSWORD,
      siteName: "Invented Archive",
      recordTitle,
      assetTitle,
      // T-048's people screens: the system manager signs in too.
      rootEmail: "root@example.org",
      organizationName: "Invented Historical Society",
      helperName: "Ben Invented",
    }),
  );
} catch (error) {
  console.error(error);
  await stop();
}
