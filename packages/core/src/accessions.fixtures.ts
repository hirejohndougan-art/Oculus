// Shared test fixtures for accession tests (not exported from the package).
// Every name, address and number here is invented.
import {
  effectiveRecord,
  indexAccessions,
  newAccessionId,
  newOrganizationId,
  type Accession,
  type AccessionRegister,
  type CatalogRecord,
  type DonorContact,
  type EffectiveRecord,
  type IdentifierType,
  type OrganizationId,
  type Validated,
} from "./index.js";
import { CHECKERS, ORG, TPL, identifiersFor, record } from "./public-output.fixtures.js";

export { ORG };
export const OTHER: OrganizationId = newOrganizationId();
export const CNE = "http://rightsstatements.org/vocab/CNE/1.0/";

export const ACCESSION_TYPE: IdentifierType = {
  key: "accession_number",
  label: "Accession number",
  organizationId: ORG,
  pattern: "####.###",
  uniqueness: "all_time",
  autoNumber: { style: "year", separator: ".", digits: 3 },
};
export const TYPES: readonly IdentifierType[] = [ACCESSION_TYPE];

/** Invented donor details that must never reach public output or a message. */
export const SECRET = {
  donor: "Zebulon Quarrington-Fakename",
  email: "zq.fakename@example.invalid",
  phone: "+1 555 0199 4242",
  address: "17 Invented Lane, Nowhere TX 00000",
  materials: "Quarrington family letters, sealed bundle",
  restrictions: "Keep the Quarrington letters closed until 2090",
  note: "Donor asked us not to mention the inheritance dispute",
  number: "2026.014",
};

const rights = { rights: { uri: CNE } };
export const donor = record("agent", SECRET.donor, {});
export const fonds = record("archival_unit", "Fonds", rights, { level: "fonds" });
export const series = record("archival_unit", "Series", rights, {
  level: "series",
  parentId: fonds.id,
});
export const item = record("archival_unit", "Item", rights, {
  level: "item",
  parentId: series.id,
});
export const scan = record("digital_asset", "Scan", rights, { represents: item.id });
export const vase = record("object", "Vase", rights);
export const loose = record("object", "Loose object", rights);
export const RECORDS: readonly CatalogRecord[] = [donor, fonds, series, item, scan, vase, loose];

export function accession(over: Partial<Record<keyof Accession, unknown>> = {}): Accession {
  return {
    id: newAccessionId(),
    organizationId: ORG,
    number: { type: "accession_number", value: SECRET.number },
    sourceAgent: { recordId: donor.id, label: SECRET.donor },
    receivedOn: "2026-03-14",
    method: "gift",
    materials: SECRET.materials,
    restrictions: SECRET.restrictions,
    deedStatus: "missing",
    records: [{ recordId: fonds.id, label: "Fonds" }],
    note: SECRET.note,
    ...over,
  } as Accession;
}

export function contact(over: Partial<Record<keyof DonorContact, unknown>> = {}): DonorContact {
  return {
    agentId: donor.id,
    organizationId: ORG,
    email: SECRET.email,
    phone: SECRET.phone,
    address: SECRET.address,
    note: SECRET.note,
    ...over,
  } as DonorContact;
}

export function ok<T>(r: Validated<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value;
}

export function codes(r: Validated<unknown> | readonly { code: string }[]): string[] {
  if (Array.isArray(r)) return (r as readonly { code: string }[]).map((i) => i.code);
  const v = r as Validated<unknown>;
  return v.ok ? [] : v.issues.map((i) => i.code);
}

export function registerOf(
  accessions: readonly unknown[],
  extra: { contacts?: readonly unknown[]; records?: unknown } = {},
): AccessionRegister {
  return ok(
    indexAccessions(ORG, {
      accessions: accessions as Accession[],
      records: extra.records ?? RECORDS,
      identifierTypes: TYPES,
      ...(extra.contacts === undefined ? {} : { contacts: extra.contacts as DonorContact[] }),
    }),
  );
}

/** The effective record of one fixture record, as publishing starts from. */
export function effectiveOf(
  target: CatalogRecord,
  records: readonly CatalogRecord[] = RECORDS,
): EffectiveRecord {
  return ok(
    effectiveRecord(target.id, records, () => TPL, {
      checkers: CHECKERS,
      identifiers: identifiersFor(records),
    }),
  );
}
