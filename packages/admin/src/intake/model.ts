/**
 * Intake (T-073): the shapes of accessions and donor contacts as the staff
 * API gives them (T-018c's service views), the words the screens show for
 * their codes, and the form an accession is edited in. STAFF ONLY: nothing
 * here is shown on a public site.
 */

export interface AccessionLink {
  readonly recordId: string;
  readonly label: string;
}

export type AccessRestriction =
  | { readonly kind: "closed_until"; readonly until: string }
  | { readonly kind: "staff_and_researchers" };

export interface Accession {
  readonly id: string;
  readonly organizationId: string;
  readonly number: { readonly type: string; readonly value: string };
  readonly sourceAgent: AccessionLink;
  readonly receivedOn: string;
  readonly method: string;
  readonly materials: string;
  readonly restrictions?: string;
  readonly accessRestriction?: AccessRestriction;
  readonly deedStatus: DeedStatus;
  readonly deedSignedOn?: string;
  readonly records: readonly AccessionLink[];
  readonly note?: string;
}

export interface AccessionView {
  readonly accession: Accession;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavedAccession extends AccessionView {
  /** The published records the accession now holds back from the public (D-114). */
  readonly nowHeld: readonly string[];
}

export interface AccessionPage {
  readonly accessions: readonly AccessionView[];
  readonly next: string | null;
}

export interface DonorContact {
  readonly agentId: string;
  readonly email?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly note?: string;
}

export interface DonorContactView {
  readonly contact: DonorContact;
  readonly version: number;
  readonly updatedAt: string;
}

export const DEED_STATUSES = ["missing", "sent", "signed", "not_needed"] as const;
export type DeedStatus = (typeof DEED_STATUSES)[number];

export const DEED_LABELS: Readonly<Record<DeedStatus, string>> = {
  missing: "Missing",
  sent: "Sent for signature",
  signed: "Signed",
  not_needed: "Not needed",
};

/** Core's acquisition methods (Spectrum), in plain words. */
export const METHODS: readonly (readonly [string, string, string])[] = [
  ["gift", "Gift", "Ownership passes to the Society."],
  ["transfer", "Transfer", "From another organization, like a school or city."],
  ["purchase", "Purchase", ""],
  ["bequest", "Bequest", "Left to the Society in a will."],
  ["field_collection", "Field collection", "Gathered by the Society's own staff."],
  ["found_in_collection", "Found in the collection", "Already here, with no record of arrival."],
  ["other", "Other", ""],
];

export function methodLabel(method: string): string {
  return METHODS.find(([key]) => key === method)?.[1] ?? method;
}

/** Whether the accession's deed holds its records back (D-114: missing or sent). */
export function deedHolds(status: DeedStatus): boolean {
  return status === "missing" || status === "sent";
}

/** "2026.014" (the number as typed). */
export function numberText(a: Accession): string {
  return a.number.value;
}

/** "Nov 2, 2026" for a `YYYY-MM-DD` day, in UTC (a day has no time zone). */
export function dayText(day: string | undefined): string {
  if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return day ?? "";
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

/** The restriction in plain words. */
export function restrictionText(r: AccessRestriction | undefined): string {
  if (r === undefined) return "No restriction";
  return r.kind === "closed_until"
    ? `Closed until ${dayText(r.until)}`
    : "Staff and researchers only";
}

/** The accession form: every field as the screen holds it (text, never undefined). */
export interface AccessionForm {
  readonly numberType: string;
  readonly numberValue: string;
  readonly source: AccessionLink | null;
  readonly receivedOn: string;
  readonly method: string;
  readonly materials: string;
  readonly records: readonly AccessionLink[];
  readonly deedStatus: DeedStatus;
  readonly deedSignedOn: string;
  readonly restriction: "none" | "closed_until" | "staff_and_researchers";
  readonly closedUntil: string;
  readonly restrictions: string;
  readonly note: string;
}

export const EMPTY_FORM: AccessionForm = {
  numberType: "accession_number",
  numberValue: "",
  source: null,
  receivedOn: "",
  method: "gift",
  materials: "",
  records: [],
  deedStatus: "missing",
  deedSignedOn: "",
  restriction: "none",
  closedUntil: "",
  restrictions: "",
  note: "",
};

export function formOf(a: Accession): AccessionForm {
  return {
    numberType: a.number.type,
    numberValue: a.number.value,
    source: a.sourceAgent,
    receivedOn: a.receivedOn,
    method: a.method,
    materials: a.materials,
    records: a.records,
    deedStatus: a.deedStatus,
    deedSignedOn: a.deedSignedOn ?? "",
    restriction: a.accessRestriction?.kind ?? "none",
    closedUntil: a.accessRestriction?.kind === "closed_until" ? a.accessRestriction.until : "",
    restrictions: a.restrictions ?? "",
    note: a.note ?? "",
  };
}

/**
 * The accession input the API takes (no `id`, no `organizationId`: the
 * service sets both). Empty optional text is left out; the service and
 * core check everything else.
 */
export function inputOf(form: AccessionForm): Record<string, unknown> {
  const text = (value: string) => value.trim();
  const out: Record<string, unknown> = {
    number: { type: form.numberType.trim(), value: text(form.numberValue) },
    sourceAgent: form.source ?? { recordId: "", label: "" },
    receivedOn: form.receivedOn,
    method: form.method,
    materials: text(form.materials),
    deedStatus: form.deedStatus,
    records: form.records,
  };
  if (form.deedStatus === "signed" && form.deedSignedOn !== "") {
    out.deedSignedOn = form.deedSignedOn;
  }
  if (form.restriction === "closed_until") {
    out.accessRestriction = { kind: "closed_until", until: form.closedUntil };
  } else if (form.restriction === "staff_and_researchers") {
    out.accessRestriction = { kind: "staff_and_researchers" };
  }
  if (text(form.restrictions) !== "") out.restrictions = text(form.restrictions);
  if (text(form.note) !== "") out.note = text(form.note);
  return out;
}

/** The accession as stored, as input again (for one-field changes such as the deed status). */
export function inputFrom(a: Accession): Record<string, unknown> {
  // Everything but the two keys the service sets.
  const out: Record<string, unknown> = { ...a };
  delete out.id;
  delete out.organizationId;
  return out;
}

/** One donor (a source agent) and the accessions from them. */
export interface Donor {
  readonly agentId: string;
  readonly label: string;
  readonly accessions: number;
  /** The latest `receivedOn`. */
  readonly lastGift: string;
}

/** The donors named by `views`, most recent gift first. */
export function donorsOf(views: readonly AccessionView[]): Donor[] {
  const byAgent = new Map<string, { label: string; count: number; last: string }>();
  for (const { accession: a } of views) {
    const seen = byAgent.get(a.sourceAgent.recordId);
    if (seen === undefined) {
      byAgent.set(a.sourceAgent.recordId, {
        label: a.sourceAgent.label,
        count: 1,
        last: a.receivedOn,
      });
    } else {
      seen.count += 1;
      if (a.receivedOn > seen.last) {
        seen.last = a.receivedOn;
        seen.label = a.sourceAgent.label;
      }
    }
  }
  return [...byAgent.entries()]
    .map(([agentId, d]) => ({
      agentId,
      label: d.label,
      accessions: d.count,
      lastGift: d.last,
    }))
    .sort((x, y) => (x.lastGift === y.lastGift ? 0 : x.lastGift > y.lastGift ? -1 : 1));
}
