/**
 * Today's checks of a record about to be written (T-030, T-032, D-065,
 * D-067), shared by `restoreVersion` and the service layer's saves: the
 * record against the current version of its template and record type, with
 * the organization's checkers built from what is stored now, and its place
 * in the arrangement.
 *
 * **The checks stay true until COMMIT.** Before reading anything they check
 * against, they lock it for the rest of the transaction:
 * - the template's and the record type's versions, with the shared
 *   `definition_lock` (0008): a new version of either waits for the save to
 *   commit, or the save sees it;
 * - the organization's identifier types, `FOR SHARE`: an edit or deletion of
 *   a type waits;
 * - every record it links to, its parent and its represented record,
 *   `FOR KEY SHARE`, in ID order: none can be deleted before the save
 *   commits (a deletion takes `FOR UPDATE`), and a record's kind never
 *   changes (D-063), so the link checker's answer holds.
 * The arrangement (a parent's level, loops) is covered by the organization's
 * `arrangement_lock`, which the writer takes before calling these checks
 * whenever a unit gets a parent or its parent or level changes (D-065).
 *
 * Every problem is returned, not only the first. Staff-only.
 */
import {
  MAX_ARRANGEMENT_DEPTH,
  canFileUnder,
  checkRecordAgainstTemplate,
  checkRecordType,
  identifierFieldIssues,
  isRecordId,
  issue,
  makeIdentifierChecker,
  makeRecordLinkChecker,
  sameJson,
  type ArchivalLevel,
  type CatalogRecord,
  type FieldTemplate,
  type Issue,
  type RecordId,
} from "@oculus/core";
import { lockDefinition, readRecordType, readRecordsForChecks, readTemplate } from "./catalog.js";
import type { Queryable } from "./client.js";
import { readIdentifierTypes, readRecordIdentifiers } from "./identifiers.js";
import { sql } from "./sql.js";

/** How `recordCheckIssues` checks and reports. */
export interface RecordCheckOptions {
  /**
   * `fixed`: every message from core's checks is replaced by fixed text
   * (code and path kept), for a restore, whose refusal must not quote old
   * values (D-065). `own`: core's messages as they are, for a save of the
   * person's own input.
   */
  readonly messages: "fixed" | "own";
  /**
   * For a restore: the confirmed field keys of the `public_field_restored`
   * list (D-065). Absent: that rule isn't checked (a save of the person's own
   * input, who sees which fields are public in the editor).
   */
  readonly confirmedPublic?: ReadonlySet<string>;
  /**
   * Check identifier fields against the numbers the record holds now
   * (`identifierFieldIssues`). The service checks them itself after saving
   * the record's identifiers in the same transaction.
   */
  readonly identifierFields: boolean;
  /**
   * Records the person may not view (T-041, D-072): a link to one of them is
   * checked as a link to a record that doesn't exist (`unknown_record`), so
   * the answer never shows whether it exists or what kind it is.
   */
  readonly hiddenLinks?: ReadonlySet<RecordId>;
  /**
   * The unit's parent is one the person may not view (T-042 review): it is
   * checked as a parent that doesn't exist (`missing_parent`, fixed text),
   * so its level never shows in a `wrong_level` message.
   */
  readonly hiddenParent?: boolean;
}

/**
 * Issues from core's checks with their messages replaced by fixed text, code
 * and path kept (D-065, as S-007 did for publicOutput): core's messages may
 * quote values (`"X" is not a …`, an old number that doesn't fit a format),
 * and a restore's refusal must not become a way to read old versions.
 */
export function fixedMessages(
  list: readonly Issue[],
  prefix: readonly (string | number)[],
): Issue[] {
  return list.map((i) =>
    issue([...prefix, ...i.path], i.code, FIXED_MESSAGES[i.code] ?? GENERIC_MESSAGE),
  );
}

function ownMessages(list: readonly Issue[], prefix: readonly (string | number)[]): Issue[] {
  return list.map((i) => issue([...prefix, ...i.path], i.code, i.message));
}

const GENERIC_MESSAGE =
  "The old version's value here doesn't pass today's checks. Open the old version to see it, then fix it in the editor.";

const FIXED_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  unknown_field: "This field is not in the template now.",
  required: "This field is required now, and the old version has no value for it.",
  identifier_not_held: "This field shows a number the record doesn't hold now.",
  unknown_record: "The record this links to doesn't exist now.",
  wrong_record_kind: "The record this links to is not of a kind this field allows now.",
  not_canonical: "This rights statement is not written in today's accepted form.",
  not_an_option: "This value is not one of the field's options now.",
  wrong_template: "Today's template is not for this kind of record.",
  unknown_record_type: "The record type this version used doesn't exist now.",
  wrong_kind: "The record type is for another kind of record now.",
});

/** The IDs a record's fields link to (`record_link` and place `recordId` values). */
export function linkedIds(record: CatalogRecord): RecordId[] {
  const ids = new Set<RecordId>();
  for (const value of Object.values(record.fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const id = (item as Readonly<Record<string, unknown>>).recordId;
      if (isRecordId(id)) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Every problem `candidate` has against today's rules, as it would be
 * written over `stored` (`undefined` for a new record); empty when it
 * passes. Takes the locks in the module header first. Run in a transaction.
 */
export async function recordCheckIssues(
  db: Queryable,
  candidate: CatalogRecord,
  stored: CatalogRecord | undefined,
  options: RecordCheckOptions,
): Promise<Issue[]> {
  const org = candidate.organizationId;
  const problems: Issue[] = [];
  const report = options.messages === "fixed" ? fixedMessages : ownMessages;

  // The records it points at, as they are now (and itself, for self-links),
  // locked so none is deleted before this transaction ends.
  const parentId = candidate.kind === "archival_unit" ? candidate.parentId : undefined;
  const represents = candidate.kind === "digital_asset" ? candidate.represents : undefined;
  const wanted = new Set<RecordId>([candidate.id, ...linkedIds(candidate)]);
  if (parentId !== undefined) wanted.add(parentId);
  if (represents !== undefined) wanted.add(represents);
  const ids = [...wanted].sort();
  await db.rows(sql`
    SELECT 1 FROM public.records
    WHERE organization_id = ${org}::uuid AND id = ANY(${ids}::uuid[])
    ORDER BY id
    FOR KEY SHARE`);
  const others = await readRecordsForChecks(db, org, ids);
  const found = new Map(others.map((r) => [r.id as string, r]));

  // The template as it is now, with the organization's checkers.
  const templateKey = candidate.templateKey ?? "";
  await lockDefinition(db, org, "template", templateKey);
  const template = await readTemplate(db, org, templateKey);
  if (template === undefined) {
    problems.push(
      issue(
        ["templateKey"],
        "unknown_template",
        stored === undefined || options.messages === "own"
          ? "The organization has no template with this key."
          : "The template this version used no longer exists.",
      ),
    );
  } else if (!template.ok) {
    problems.push(...fixedMessages(template.issues, ["templateKey"]));
  } else {
    await db.rows(sql`
      SELECT 1 FROM public.identifier_types WHERE organization_id = ${org}::uuid
      ORDER BY key COLLATE "C"
      FOR SHARE`);
    const types = await readIdentifierTypes(db, org);
    const identifier = types.ok ? makeIdentifierChecker(types.value, org) : types;
    const hidden = options.hiddenLinks;
    const links = makeRecordLinkChecker(
      hidden === undefined || hidden.size === 0
        ? others
        : others.filter((r) => !hidden.has(r.id as RecordId)),
      org,
    );
    if (!identifier.ok || !links.ok) {
      // Without the checkers the fields can't be checked; say why, and go on
      // with every other check.
      if (!identifier.ok) problems.push(...fixedMessages(identifier.issues, ["identifierTypes"]));
      if (!links.ok) problems.push(...fixedMessages(links.issues, []));
    } else {
      problems.push(
        ...report(
          checkRecordAgainstTemplate(candidate, template.value.template, {
            checkers: {
              identifier: identifier.value,
              record_link: links.value,
              place: links.value,
            },
            allowMissingInherited: candidate.kind === "archival_unit",
          }),
          [],
        ),
      );
    }
    if (options.confirmedPublic !== undefined && stored !== undefined) {
      const confirmed = options.confirmedPublic;
      const toConfirm = publicValueIssues(candidate, stored, template.value.template);
      const keys = new Set(toConfirm.map((i) => String(i.path[1])));
      const same = keys.size === confirmed.size && [...keys].every((key) => confirmed.has(key));
      if (!same) problems.push(...toConfirm);
    }
    if (options.identifierFields) {
      const held = await readRecordIdentifiers(db, org, candidate.id);
      if (held === undefined) {
        problems.push(issue(["id"], "unknown_record", "The organization has no such record."));
      } else if (!held.ok) {
        problems.push(...fixedMessages(held.issues, ["identifiers"]));
      } else {
        problems.push(
          ...report(identifierFieldIssues(candidate, template.value.template, held.value), []),
        );
      }
    }
  }

  // Its record type as it is now.
  if (candidate.recordTypeKey !== undefined) {
    await lockDefinition(db, org, "record_type", candidate.recordTypeKey);
    const type = await readRecordType(db, org, candidate.recordTypeKey);
    if (type === undefined) {
      problems.push(
        issue(
          ["recordTypeKey"],
          "unknown_record_type",
          options.messages === "own"
            ? "The organization has no record type with this key."
            : "The record type this version used no longer exists.",
        ),
      );
    } else if (!type.ok) {
      problems.push(...fixedMessages(type.issues, ["recordTypeKey"]));
    } else {
      problems.push(...report(checkRecordType(candidate, type.value.recordType), []));
    }
  }

  // A represented record that exists.
  if (represents !== undefined && !found.has(represents)) {
    problems.push(
      issue(
        ["represents"],
        "unknown_record",
        options.messages === "own"
          ? "The organization has no record with this ID."
          : "The record this version represents no longer exists.",
      ),
    );
  }

  // The arrangement, when the unit is new or its parent or level changes.
  if (candidate.kind === "archival_unit") {
    if (stored === undefined) {
      problems.push(
        ...(await arrangementIssues(db, candidate, undefined, found, options.hiddenParent)),
      );
    } else if (stored.kind === "archival_unit") {
      problems.push(
        ...(await arrangementIssues(db, candidate, stored, found, options.hiddenParent)),
      );
    }
  }
  return problems;
}

/**
 * Restored values that land in fields public today and differ from what the
 * record holds now (D-065). A field may have been staff-only when the old
 * value was stored and made public since, after the value was removed, so
 * the made-public confirmation (D-031, T-005a) never covered it: restoring
 * it must not publish it silently. The simplest safe rule: every such value
 * is listed, and the restore waits for `confirmMadePublic` naming exactly
 * those fields. The title isn't in the rule: it is always public (core's
 * public views always carry it), so an old title was never staff-only.
 */
function publicValueIssues(
  candidate: CatalogRecord,
  stored: CatalogRecord,
  template: FieldTemplate,
): Issue[] {
  const problems: Issue[] = [];
  const moved = candidate.templateKey !== stored.templateKey;
  for (const field of template.fields) {
    if (field.visibility !== "public" || !Object.hasOwn(candidate.fields, field.key)) continue;
    const value = candidate.fields[field.key];
    const now = Object.hasOwn(stored.fields, field.key) ? stored.fields[field.key] : undefined;
    // Restoring a version under another template is a move (T-012a): a value
    // unchanged from today's was stored under that template, where it may
    // have been staff, so it is listed too.
    if (value === undefined || (!moved && now !== undefined && sameJson(value, now))) continue;
    problems.push(
      issue(
        ["fields", field.key],
        "public_field_restored",
        `${field.label} is public now and restoring would change its value. Confirm that this value may be published (it may have been staff-only when it was stored).`,
      ),
    );
  }
  return problems;
}

/** At most this many descendants are walked to check the depth of a moved unit. */
export const MAX_DESCENDANTS_WALKED = 100_000;

function tooDeep(): Issue {
  return issue(
    ["parentId"],
    "too_deep",
    `Filed there, its tree would be more than ${String(MAX_ARRANGEMENT_DEPTH)} levels deep.`,
  );
}

/**
 * Problems filing the unit where `unit` has it, as the tree is now. `stored`
 * is the unit as stored (`undefined` for a new one, which has no children).
 */
async function arrangementIssues(
  db: Queryable,
  unit: CatalogRecord & { kind: "archival_unit" },
  stored: (CatalogRecord & { kind: "archival_unit" }) | undefined,
  found: ReadonlyMap<string, Record<string, unknown>>,
  hiddenParent = false,
): Promise<Issue[]> {
  const org = unit.organizationId;
  const problems: Issue[] = [];
  const parentChanged = stored === undefined || unit.parentId !== stored.parentId;
  const levelChanged = stored !== undefined && unit.level !== stored.level;
  if (levelChanged) {
    // Its children stay where they are: they must still fit under it.
    const children = await db.rows<{ level: ArchivalLevel }>(sql`
      SELECT DISTINCT level FROM public.records
      WHERE organization_id = ${org}::uuid AND parent_id = ${unit.id}::uuid`);
    for (const child of children) {
      if (!canFileUnder(child.level, unit.level)) {
        problems.push(
          issue(
            ["level"],
            "wrong_level",
            `This unit holds a ${child.level} now, which can't be filed under a ${unit.level}.`,
          ),
        );
      }
    }
  }
  if (unit.parentId === undefined || (!parentChanged && !levelChanged)) {
    return problems;
  }
  const parent = hiddenParent ? undefined : found.get(unit.parentId);
  if (parent?.kind !== "archival_unit") {
    problems.push(
      issue(
        ["parentId"],
        "missing_parent",
        stored === undefined
          ? "There is no archival unit with this ID in the organization."
          : "The unit it would be filed under doesn't exist, or is not an archival unit.",
      ),
    );
    return problems;
  }
  if (!canFileUnder(unit.level, parent.level as ArchivalLevel)) {
    problems.push(
      issue(
        ["parentId"],
        "wrong_level",
        `A ${unit.level} can't be filed under a ${String(parent.level)}.`,
      ),
    );
  }
  if (!parentChanged) return problems;
  // The new parent's ancestors, up to the top or the depth limit, stopping
  // at the unit itself (a loop).
  const up = await db.rows<{ id: string }>(sql`
    WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT id, parent_id, 1 FROM public.records
      WHERE organization_id = ${org}::uuid AND id = ${unit.parentId}::uuid
      UNION ALL
      SELECT r.id, r.parent_id, up.depth + 1
      FROM up JOIN public.records r ON r.organization_id = ${org}::uuid AND r.id = up.parent_id
      WHERE up.depth <= ${MAX_ARRANGEMENT_DEPTH}::integer AND up.id <> ${unit.id}::uuid
    )
    SELECT id::text AS id FROM up`);
  if (up.some((row) => row.id === unit.id)) {
    problems.push(
      issue(
        ["parentId"],
        "loop",
        "The unit it would be filed under is inside this unit, so it would be filed inside itself.",
      ),
    );
    return problems;
  }
  // Whether its own descendants would then sit too deep: walk down only as
  // far as the room left below it, and at most MAX_DESCENDANTS_WALKED rows
  // (the walk stops as soon as one unit past the room is found). A new unit
  // has no descendants.
  const room = MAX_ARRANGEMENT_DEPTH - (up.length + 1);
  if (room < 0) {
    problems.push(tooDeep());
    return problems;
  }
  if (stored === undefined) return problems;
  const [below] = await db.rows<{ deeper: boolean | null; walked: number }>(sql`
    WITH RECURSIVE down(id, depth) AS (
      SELECT id, 1 FROM public.records
      WHERE organization_id = ${org}::uuid AND parent_id = ${unit.id}::uuid
      UNION ALL
      SELECT r.id, down.depth + 1
      FROM down JOIN public.records r ON r.organization_id = ${org}::uuid AND r.parent_id = down.id
      WHERE down.depth <= ${room}::integer
    ), walked AS (
      SELECT depth FROM down LIMIT ${MAX_DESCENDANTS_WALKED + 1}::integer
    )
    SELECT bool_or(depth > ${room}::integer) AS deeper, count(*)::integer AS walked FROM walked`);
  if (below?.deeper === true) {
    problems.push(tooDeep());
  } else if ((below?.walked ?? 0) > MAX_DESCENDANTS_WALKED) {
    problems.push(
      issue(
        ["parentId"],
        "too_many_descendants",
        `This unit holds more than ${String(MAX_DESCENDANTS_WALKED)} units, too many to check here; move it in smaller steps.`,
      ),
    );
  }
  return problems;
}
