// Custom roles (T-041a, D-036, D-120): system managers make, change and
// delete an organization's roles from the permission list; nobody else
// may. A custom role can't hold a system power or manage people; another
// organization's role can't be granted; sensitive permissions and people
// affected are confirmed first; a role people hold is deleted only by
// moving them, after which its access is gone; a change takes effect on the
// next write; every change is logged; and the database refuses a grant of
// an unknown role and the deletion of a role in use. Every person, site and
// record here is invented.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfTokenFor, type Issue } from "@oculus/core";
import { sql } from "@oculus/db";
import type { ServiceResult } from "@oculus/service";
import type { FastifyInstance } from "fastify";
import { OCULUS_COOKIES } from "./cookies.js";
import { buildServer } from "./server.js";
import { CSRF_HEADER, staffApiRoutes } from "./staff-api.js";
import {
  actorOf,
  fullSession,
  makeObject,
  makeWorld,
  objectDraft,
  type World,
} from "./staff-api.fixtures.js";
import { SAME_ORIGIN, TEST_ENV } from "./test-server.fixtures.js";

let w: World;
let app: FastifyInstance;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  w = await makeWorld();
  app = await buildServer({
    env: TEST_ENV,
    routes: staffApiRoutes({ db: w.db, service: w.service, log: () => undefined }),
  });
  tokens.root = (await fullSession(w.db, w.root, w.a)).token;
  tokens.manager = (await fullSession(w.db, w.manager, w.a)).token;
}, 120_000);

afterAll(async () => {
  await app.close();
  await w.db.close();
  await w.testDb.drop();
});

function ok<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
const codes = (result: { ok: boolean; issues?: readonly Issue[] }) =>
  result.ok ? [] : (result.issues ?? []).map((i) => i.code);

const rootIn = (org = w.a) => ({ organizationId: org, actor: actorOf(w.root) });
const asUser = (user: string, siteId?: string): never =>
  ({
    organizationId: w.a,
    actor: actorOf(user as never),
    ...(siteId === undefined ? {} : { siteId }),
  }) as never;

async function call(method: string, url: string, as: string, body?: unknown, headers = {}) {
  const token = tokens[as] ?? "";
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: {
      ...SAME_ORIGIN,
      cookie: `${OCULUS_COOKIES.session}=${token}`,
      ...(method === "GET" ? {} : { [CSRF_HEADER]: csrfTokenFor(token) ?? "" }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return {
    status: res.statusCode,
    json: JSON.parse(res.body || "null") as Record<string, unknown>,
  };
}

describe("making and changing custom roles", () => {
  it("only a system manager may, and never with a system power or people management", async () => {
    const role = { key: "describer", label: "Describer", permissions: ["records.view"] };
    expect(
      codes(await w.service.saveCustomRole(asUser(w.manager), role, { expectedVersion: 0 })),
    ).toEqual(["not_permitted"]);
    expect(codes(await w.service.listCustomRoles(asUser(w.manager)))).toEqual(["not_permitted"]);
    for (const p of ["system.settings", "system.users", "catalog.definitions", "site.people"]) {
      expect(
        codes(
          await w.service.saveCustomRole(
            rootIn(),
            { ...role, permissions: ["records.view", p] },
            { expectedVersion: 0 },
          ),
        ),
      ).toEqual(["permission_not_allowed"]);
    }
    expect(
      codes(
        await w.service.saveCustomRole(
          rootIn(),
          { ...role, key: "cataloger" },
          { expectedVersion: 0 },
        ),
      ),
    ).toEqual(["invalid_key"]);
    // The database refuses one put there by hand too.
    await expect(
      w.db.execute(sql`
        INSERT INTO public.custom_roles (organization_id, key, label, permissions, updated_by)
        VALUES (${w.a}::uuid, 'sneaky', 'Sneaky', ARRAY['system.settings'], ${w.root}::uuid)`),
    ).rejects.toThrow();
    const made = ok(await w.service.saveCustomRole(rootIn(), role, { expectedVersion: 0 }));
    expect(made.role).toMatchObject({
      key: "describer",
      version: 1,
      permissions: ["records.view"],
    });
    expect(codes(await w.service.saveCustomRole(rootIn(), role, { expectedVersion: 0 }))).toEqual([
      "key_taken",
    ]);
  });

  it("asks before adding publishing or donor data, and then exactly those", async () => {
    const role = {
      key: "publisher",
      label: "Publisher",
      permissions: ["records.view", "records.publish", "donors.view"],
    };
    const asked = await w.service.saveCustomRole(rootIn(), role, { expectedVersion: 0 });
    expect(codes(asked)).toEqual(["needs_confirmation", "needs_confirmation"]);
    expect(
      codes(
        await w.service.saveCustomRole(rootIn(), role, {
          expectedVersion: 0,
          confirm: ["records.publish"],
        }),
      ),
    ).toEqual(["needs_confirmation", "needs_confirmation"]);
    const made = ok(
      await w.service.saveCustomRole(rootIn(), role, {
        expectedVersion: 0,
        confirm: ["records.publish", "donors.view"],
      }),
    );
    expect(made.role.permissions).toEqual(["records.view", "records.publish", "donors.view"]);
    // Kept, not added: nothing to confirm.
    ok(
      await w.service.saveCustomRole(
        rootIn(),
        { ...role, label: "Publisher and donor reader" },
        { expectedVersion: 1 },
      ),
    );
  });

  it("another organization's role can't be granted, seen or changed", async () => {
    ok(
      await w.service.saveCustomRole(
        rootIn(w.b),
        { key: "lender", label: "Lender", permissions: ["records.view"] },
        { expectedVersion: 0 },
      ),
    );
    const person = await w.member(w.a, "Borrower");
    expect(
      codes(
        await w.service.grantRole(rootIn(), {
          userId: person,
          role: "lender",
          siteId: w.a1,
          scope: null,
        }),
      ),
    ).toEqual(["unknown_role"]);
    expect(codes(await w.service.customRoleHolders(rootIn(), "lender"))).toEqual(["unknown_role"]);
    expect(
      codes(
        await w.service.saveCustomRole(
          rootIn(),
          { key: "lender", label: "Mine now", permissions: ["records.edit"] },
          { expectedVersion: 1 },
        ),
      ),
    ).toEqual(["unknown_role"]);
    expect(
      (await w.service.listCustomRoles(rootIn())).ok &&
        ok(await w.service.listCustomRoles(rootIn())).some((v) => v.role.key === "lender"),
    ).toBe(false);
    // And the database refuses a grant naming it, whoever writes it.
    await expect(
      w.db.execute(sql`
        INSERT INTO public.role_assignments (organization_id, id, user_id, role, site_id, granted_by)
        VALUES (${w.a}::uuid, gen_random_uuid(), ${person}::uuid, 'lender', ${w.a1}::uuid,
                ${w.root}::uuid)`),
    ).rejects.toThrow(/role_assignments_known_role|organization's own/);
  });
});

describe("holding a custom role", () => {
  it("grants exactly its permissions, a change takes effect at once, and deleting it moves its holders", async () => {
    ok(
      await w.service.saveCustomRole(
        rootIn(),
        { key: "editor", label: "Editor", permissions: ["records.view", "records.edit"] },
        { expectedVersion: 0 },
      ),
    );
    const person = await w.member(w.a, "Editor");
    // Seen by the site manager once they hold a role on A1 (Q-10)…
    const seen = ok(
      await w.service.grantRole(rootIn(), {
        userId: person,
        role: "read_only",
        siteId: w.a1,
        scope: null,
      }),
    );
    // …then a site manager may grant it: it holds nothing beyond theirs.
    ok(
      await w.service.grantRole(asUser(w.manager), {
        userId: person,
        role: "editor",
        siteId: w.a1,
        scope: null,
      }),
    );
    const object = await makeObject(w, w.a, w.a1, "An invented lamp");
    const me = asUser(person, w.a1);
    ok(
      await w.service.updateRecord(
        me as never,
        object.id as never,
        objectDraft("An invented oil lamp"),
        {
          expectedVersion: object.version,
        },
      ),
    );
    expect(codes(await w.service.createRecord(me as never, objectDraft("New")))).toEqual([
      "not_permitted",
    ]);
    expect(
      codes(await w.service.publish(me as never, object.id as never, { expectedVersion: 2 })),
    ).toEqual(["not_permitted"]);

    // Taking edit away needs the holders confirmed, then applies to the next write.
    const narrower = { key: "editor", label: "Editor", permissions: ["records.view"] };
    const asked = await w.service.saveCustomRole(rootIn(), narrower, { expectedVersion: 1 });
    expect(codes(asked)).toEqual(["affects_people", "holder"]);
    ok(
      await w.service.saveCustomRole(rootIn(), narrower, {
        expectedVersion: 1,
        confirmHolders: 1,
      }),
    );
    expect(
      codes(
        await w.service.updateRecord(me as never, object.id as never, objectDraft("Again"), {
          expectedVersion: 2,
        }),
      ),
    ).toEqual(["not_permitted"]);

    // Deleting it: refused while held, then moved, then gone.
    expect(
      codes(await w.service.deleteCustomRole(rootIn(), "editor", { expectedVersion: 2 })),
    ).toEqual(["role_in_use", "holder"]);
    await expect(
      w.db.execute(sql`DELETE FROM public.custom_roles WHERE organization_id = ${w.a}::uuid
                       AND key = 'editor'`),
    ).rejects.toThrow(/custom_roles_in_use|people hold/);
    expect(
      codes(
        await w.service.deleteCustomRole(rootIn(), "editor", {
          expectedVersion: 2,
          moveTo: "site_manager",
          confirmHolders: 1,
        }),
      ),
    ).toEqual(["not_allowed"]);
    expect(
      codes(
        await w.service.deleteCustomRole(rootIn(), "editor", {
          expectedVersion: 2,
          moveTo: "read_only",
        }),
      ),
    ).toEqual(["affects_people", "holder"]);
    const gone = ok(
      await w.service.deleteCustomRole(rootIn(), "editor", {
        expectedVersion: 2,
        moveTo: "read_only",
        confirmHolders: 1,
      }),
    );
    // Already read-only there: the moved grant is the one they had.
    expect(gone).toEqual({ key: "editor", moved: 1, movedTo: "read_only" });
    expect(seen.role).toBe("read_only");
    const left = await w.db.rows<{ role: string }>(sql`
      SELECT role FROM public.role_assignments WHERE user_id = ${person}::uuid`);
    expect(left.map((r) => r.role)).toEqual(["read_only"]);
    // A role of that name made again doesn't bring the old grant back.
    ok(
      await w.service.saveCustomRole(
        rootIn(),
        { key: "editor", label: "Editor", permissions: ["records.view", "records.edit"] },
        { expectedVersion: 0 },
      ),
    );
    expect(
      codes(
        await w.service.updateRecord(me as never, object.id as never, objectDraft("Again"), {
          expectedVersion: 2,
        }),
      ),
    ).toEqual(["not_permitted"]);

    // Every change is in the change log.
    const history = ok(await w.service.customRoleHistory(rootIn()));
    const editor = history.filter((e) => e.roleKey === "editor").map((e) => e.kind);
    expect(editor).toEqual(["role_created", "role_deleted", "role_changed", "role_created"]);
    expect(history.find((e) => e.kind === "role_deleted")).toMatchObject({
      grants: 1,
      movedTo: "read_only",
    });
    const moved = await w.db.rows<{ kind: string; role: string }>(sql`
      SELECT kind, role FROM public.people_events
      WHERE subject_id = ${person}::uuid AND (kind = 'role_revoked' OR role = 'read_only')
      ORDER BY occurred_at`);
    // Moved onto a grant they already held: only the revoke is logged.
    expect(moved.map((m) => `${m.kind}:${m.role}`)).toEqual(["role_revoked:editor"]);
  });

  it("the role list shows custom roles to those who grant roles", async () => {
    const catalog = ok(await w.service.roleCatalog(asUser(w.manager) as never));
    expect(catalog.find((r) => r.role === "describer")).toMatchObject({
      label: "Describer",
      permissions: ["records.view"],
      grantable: true,
      custom: true,
    });
    expect(catalog.some((r) => r.role === "lender")).toBe(false);
  });
});

describe("over HTTP", () => {
  it("system managers only, a fresh sign-in, If-None-Match to make and If-Match to change", async () => {
    const role = { label: "Cataloger plus", permissions: ["records.view", "records.create"] };
    expect((await call("GET", "/api/custom-roles", "manager")).status).toBe(403);
    expect(
      (
        await call(
          "PUT",
          "/api/custom-roles/cat_plus",
          "manager",
          { role },
          {
            "if-none-match": "*",
          },
        )
      ).status,
    ).toBe(403);
    const made = await call(
      "PUT",
      "/api/custom-roles/cat_plus",
      "root",
      { role },
      {
        "if-none-match": "*",
      },
    );
    expect(made.status).toBe(201);
    expect(made.json.role).toMatchObject({ key: "cat_plus", version: 1, grants: 0 });
    const stale = await call(
      "PUT",
      "/api/custom-roles/cat_plus",
      "root",
      { role: { ...role, label: "Renamed" } },
      { "if-match": '"v7"' },
    );
    expect(stale.status).toBe(412);
    const list = await call("GET", "/api/custom-roles", "root");
    expect((list.json.roles as { key: string }[]).map((r) => r.key)).toContain("cat_plus");
    const missing = await call("POST", "/api/custom-roles/nope/delete", "root", undefined, {
      "if-match": '"v1"',
    });
    expect(missing.status).toBe(404);
    const deleted = await call("POST", "/api/custom-roles/cat_plus/delete", "root", undefined, {
      "if-match": '"v1"',
    });
    expect([deleted.status, deleted.json]).toEqual([
      200,
      { key: "cat_plus", moved: 0, movedTo: null },
    ]);
  });
});
