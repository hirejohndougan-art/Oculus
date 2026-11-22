/**
 * Standards presets: starting templates (PLATFORM_PLAN.md §1, decision D-012).
 *
 * Three field templates an organization can start from instead of a blank
 * one, built with the T-005 template model (`templates.ts`, D-010):
 * - `dacs-archival-unit`: archival units described with DACS.
 * - `spectrum-object`: museum objects described with Spectrum's units of
 *   information.
 * - `dublin-core-digital-asset`: digital assets (scans, recordings,
 *   born-digital files) described with Dublin Core terms.
 *
 * They are plain, frozen data with no organization: an organization's
 * template is made from one with `templateFromPreset`, which adds the
 * organization and validates the copy like any other template (D-030,
 * T-019a). The admin then edits that copy in the browser. Nothing here is
 * for one organization; a historical society that
 * keeps both archives and objects (such as the Dickinson Historical Society)
 * uses the DACS and Spectrum presets side by side, with the digital asset
 * preset for its scans.
 *
 * Fields cite the standard element they come from, in `standards`:
 * - DACS: SAA's "Describing Archives: A Content Standard", second edition,
 *   element numbers and names as published by SAA at
 *   https://saa-ts-dacs.github.io/dacs/ (version 2022.0.4, read 2026-11-20).
 *   DACS elements have no stable URIs there, so none are given.
 * - Spectrum: Collections Trust's Spectrum 5.1 unit of information names, as
 *   written in its Cataloguing and Acquisition and accessioning procedures
 *   (2022). Where only the information group could be confirmed (rights,
 *   valuation), the group is cited and its element text ends
 *   "(information group)".
 * - Dublin Core: DCMI Metadata Terms (2020-01-20), with their
 *   `http://purl.org/dc/terms/` URIs, on public fields only. The digital
 *   asset preset's staff fields cite nothing: a Dublin Core cite there would
 *   read as if the field were published.
 * The title is not a template field: every record has a `title` of its own,
 * which is DACS 2.3 Title, Spectrum "Title" and Dublin Core `title`.
 *
 * Visibility is chosen field by field, and fails closed: anything that can
 * name a private person or reveal what staff keep to themselves starts as
 * `staff`, and an organization that wants it published switches it. That
 * covers donors and acquisition, custodial and object history, provenance,
 * owners and rights holders, sources, where originals or copies are, storage
 * location, appraisal, valuation and insurance, credit lines, and notes. Two
 * fields that could match those words stay public on purpose: the conditions
 * governing access (researchers need them; the help text says not to give
 * personal or donor-confidential reasons) and the repository's own name and
 * location. Every preset has the `rights` field (`RIGHTS_FIELD_KEY`, D-011)
 * as a public field.
 *
 * What gets published, and as which Dublin Core term, is in
 * `dublin-core.ts`, not in `standards` here.
 */
import { RIGHTS_FIELD_KEY } from "./rights.js";
import { types } from "node:util";
import { issue, isPlainObject, type Validated } from "./issues.js";
import { isOrganizationId } from "./organizations.js";
import {
  validateTemplate,
  type FieldDefinition,
  type FieldTemplate,
  type StandardMapping,
} from "./templates.js";

/** A starting template with no organization yet (`templateFromPreset`). */
export type TemplatePreset = Omit<FieldTemplate, "organizationId">;

const DC = "http://purl.org/dc/terms/";

function dacs(element: string): StandardMapping {
  return { standard: "dacs", element };
}
function spectrum(element: string): StandardMapping {
  return { standard: "spectrum", element };
}
function dcterms(term: string): StandardMapping {
  return { standard: "dcterms", element: term, uri: `${DC}${term}` };
}

const RIGHTS_HELP =
  "A rightsstatements.org statement or Creative Commons license URI. A record can't be published without one.";

const ACCESS_POINT_HELP = "Access points for searching and browsing.";

// ---------------------------------------------------------------------------
// DACS archival units.

const DACS_FIELDS: readonly FieldDefinition[] = [
  {
    key: "reference_code",
    label: "Reference code",
    help: "The unit's identifier, unique within the repository.",
    kind: "identifier",
    required: true,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dacs("2.1 Reference Code")],
  },
  {
    key: "repository",
    label: "Name and location of repository",
    kind: "text",
    required: true,
    repeatable: false,
    visibility: "public",
    inherited: true,
    standards: [dacs("2.2 Name and Location of Repository")],
  },
  {
    key: "date",
    label: "Date",
    help: "The date or inclusive dates of the material, as EDTF (1909, 1920/1935, 195X).",
    kind: "date",
    required: true,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dacs("2.4 Date")],
  },
  {
    key: "bulk_date",
    label: "Bulk dates",
    help: "The dates most of the material falls within, if different.",
    kind: "date",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dacs("2.4 Date")],
  },
  {
    key: "extent",
    label: "Extent",
    help: "Quantity and kind, such as 2.5 linear feet or 34 photographs.",
    kind: "text",
    required: true,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [dacs("2.5 Extent")],
  },
  {
    key: "creators",
    label: "Creators",
    help: "Required if known.",
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: true,
    standards: [dacs("2.6 Name of Creator(s)")],
  },
  {
    key: "admin_bio_history",
    label: "Administrative or biographical history",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: true,
    standards: [dacs("2.7 Administrative/Biographical History")],
  },
  {
    key: "scope_and_content",
    label: "Scope and content",
    kind: "long_text",
    required: true,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dacs("3.1 Scope and Content")],
  },
  {
    key: "arrangement",
    label: "System of arrangement",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dacs("3.2 System of Arrangement")],
  },
  {
    key: "access_conditions",
    label: "Conditions governing access",
    help: "Published. Who may see the material and when, such as open to researchers. Don't give personal or donor-confidential reasons here.",
    kind: "long_text",
    required: true,
    repeatable: false,
    visibility: "public",
    inherited: true,
    standards: [dacs("4.1 Conditions Governing Access")],
  },
  {
    key: "physical_access",
    label: "Physical access",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: true,
    standards: [dacs("4.2 Physical Access")],
  },
  {
    key: "technical_access",
    label: "Technical access",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: true,
    standards: [dacs("4.3 Technical Access")],
  },
  {
    key: "reproduction_and_use",
    label: "Conditions governing reproduction and use",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: true,
    standards: [dacs("4.4 Conditions Governing Reproduction and Use")],
  },
  {
    key: RIGHTS_FIELD_KEY,
    label: "Rights statement",
    help: RIGHTS_HELP,
    kind: "rights",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: true,
    standards: [dacs("4.4 Conditions Governing Reproduction and Use")],
  },
  {
    key: "languages",
    label: "Languages and scripts of the material",
    kind: "controlled_term",
    required: true,
    repeatable: true,
    visibility: "public",
    inherited: true,
    standards: [dacs("4.5 Languages and Scripts of the Material")],
  },
  {
    key: "finding_aids",
    label: "Finding aids",
    kind: "link",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [dacs("4.6 Finding Aids")],
  },
  {
    key: "custodial_history",
    label: "Custodial history",
    help: "Staff only until the organization chooses to publish it: the chain of ownership and custody can name private owners and donors.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: true,
    standards: [dacs("5.1 Custodial History")],
  },
  {
    key: "acquisition_source",
    label: "Immediate source of acquisition",
    help: "Staff only. The donor or seller, the date and the terms.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [dacs("5.2 Immediate Source of Acquisition")],
  },
  {
    key: "appraisal",
    label: "Appraisal, destruction and scheduling",
    help: "Staff only.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [dacs("5.3 Appraisal, Destruction, and Scheduling Information")],
  },
  {
    key: "accruals",
    label: "Accruals",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dacs("5.4 Accruals")],
  },
  {
    key: "originals_location",
    label: "Existence and location of originals",
    help: "Staff only until the organization chooses to publish it: it can name a private owner or where they live.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [dacs("6.1 Existence and Location of Originals")],
  },
  {
    key: "copies_location",
    label: "Existence and location of copies",
    help: "Staff only until the organization chooses to publish it: it can name a private owner or where they live.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [dacs("6.2 Existence and Location of Copies")],
  },
  {
    key: "related_materials",
    label: "Related archival materials",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dacs("6.3 Related Archival Materials")],
  },
  {
    key: "publication_note",
    label: "Publication note",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dacs("6.4 Publication Note")],
  },
  {
    key: "notes",
    label: "Notes",
    help: "Staff only until the organization chooses to publish it: general notes often hold private details.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [dacs("7.1 Notes")],
  },
  {
    key: "subjects",
    label: "Subjects",
    help: ACCESS_POINT_HELP,
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [dacs("Access points")],
  },
  {
    key: "places",
    label: "Places",
    help: ACCESS_POINT_HELP,
    kind: "place",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [dacs("Access points")],
  },
  {
    key: "description_control",
    label: "Description control and processing notes",
    help: "Staff only. Who described the unit, when, from what sources, and processing notes.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [dacs("8.1 Description Control")],
  },
  {
    key: "storage_location",
    label: "Storage location",
    help: "Staff only. Building, room, shelf and box.",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: true,
    // DACS 2.2 names the repository, not where in it the material is kept.
    standards: [spectrum("Current location")],
  },
];

// ---------------------------------------------------------------------------
// Spectrum museum objects.

const SPECTRUM_FIELDS: readonly FieldDefinition[] = [
  {
    key: "object_number",
    label: "Object number",
    help: "The number that identifies the object, such as an accession number.",
    kind: "identifier",
    required: true,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Object number")],
  },
  {
    key: "other_numbers",
    label: "Other numbers",
    help: "Staff only. Earlier, temporary or field numbers.",
    kind: "identifier",
    required: false,
    repeatable: true,
    visibility: "staff",
    inherited: false,
    standards: [spectrum("Other number"), spectrum("Other number type")],
  },
  {
    key: "object_name",
    label: "Object name",
    help: "What the object is, such as chair or postcard, ideally from Nomenclature.",
    kind: "controlled_term",
    required: true,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Object name")],
  },
  {
    key: "number_of_objects",
    label: "Number of objects",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    maxLength: 50,
    standards: [spectrum("Number of objects")],
  },
  {
    key: "brief_description",
    label: "Brief description",
    kind: "long_text",
    required: true,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Brief description")],
  },
  {
    key: "physical_description",
    label: "Physical description",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Physical description")],
  },
  {
    key: "materials",
    label: "Materials",
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Material")],
  },
  {
    key: "dimensions",
    label: "Dimensions",
    help: "One measurement each, such as height 45 cm.",
    kind: "text",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [
      spectrum("Dimension"),
      spectrum("Dimension value"),
      spectrum("Dimension measurement unit"),
    ],
  },
  {
    key: "inscriptions",
    label: "Inscriptions",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Inscription content"), spectrum("Inscription description")],
  },
  {
    key: "production_date",
    label: "Date made",
    kind: "date",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Object production date")],
  },
  {
    key: "makers",
    label: "Makers",
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Object production person"), spectrum("Object production organisation")],
  },
  {
    key: "production_place",
    label: "Place made",
    kind: "place",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Object production place")],
  },
  {
    key: "techniques",
    label: "Techniques",
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Technique")],
  },
  {
    key: "subjects",
    label: "Subjects",
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Content - concept")],
  },
  {
    key: "associated_places",
    label: "Associated places",
    kind: "place",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Associated place")],
  },
  {
    key: "object_history",
    label: "History",
    help: "Staff only until the organization chooses to publish it: earlier owners and donors can be private people.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [spectrum("Object history note")],
  },
  {
    key: RIGHTS_FIELD_KEY,
    label: "Rights statement",
    help: RIGHTS_HELP,
    kind: "rights",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [spectrum("Rights information (information group)")],
  },
  {
    key: "acquisition_method",
    label: "Acquisition method",
    help: "Staff only.",
    kind: "list",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    options: [
      { value: "gift", label: "Gift" },
      { value: "bequest", label: "Bequest" },
      { value: "purchase", label: "Purchase" },
      { value: "transfer", label: "Transfer" },
      { value: "field_collection", label: "Field collection" },
      { value: "found_in_collection", label: "Found in collection" },
      { value: "unknown", label: "Unknown" },
    ],
    standards: [spectrum("Acquisition method")],
  },
  {
    key: "acquisition_source",
    label: "Acquisition source",
    help: "Staff only. The donor, seller or lender the object came from.",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [spectrum("Acquisition source")],
  },
  {
    key: "acquisition_date",
    label: "Acquisition date",
    help: "Staff only.",
    kind: "date",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [spectrum("Acquisition date")],
  },
  {
    key: "acquisition_note",
    label: "Acquisition note",
    help: "Staff only. Terms, provisos and the reason for acquiring.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [
      spectrum("Acquisition note"),
      spectrum("Acquisition provisos"),
      spectrum("Acquisition reason"),
    ],
  },
  {
    key: "credit_line",
    label: "Credit line",
    help: "Staff only until the organization decides to publish credit lines: it names the donor.",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [spectrum("Credit line")],
  },
  {
    key: "current_location",
    label: "Current location",
    help: "Staff only.",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [spectrum("Current location")],
  },
  {
    key: "valuation",
    label: "Valuation and insurance",
    help: "Staff only. Values, who set them and when, and insurance details.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [spectrum("Object valuation information (information group)")],
  },
  {
    key: "comments",
    label: "Internal comments",
    help: "Staff only.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    standards: [spectrum("Comments")],
  },
];

// ---------------------------------------------------------------------------
// Dublin Core digital assets.

const DIGITAL_ASSET_FIELDS: readonly FieldDefinition[] = [
  {
    key: "identifier",
    label: "Identifier",
    kind: "identifier",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dcterms("identifier")],
  },
  {
    key: "resource_type",
    label: "Type",
    kind: "list",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    // The DCMI Type Vocabulary (http://purl.org/dc/dcmitype/).
    options: [
      { value: "StillImage", label: "Still image" },
      { value: "Image", label: "Image" },
      { value: "MovingImage", label: "Moving image" },
      { value: "Sound", label: "Sound" },
      { value: "Text", label: "Text" },
      { value: "Dataset", label: "Dataset" },
      { value: "Software", label: "Software" },
      { value: "InteractiveResource", label: "Interactive resource" },
      { value: "PhysicalObject", label: "Physical object" },
      { value: "Collection", label: "Collection" },
      { value: "Event", label: "Event" },
      { value: "Service", label: "Service" },
    ],
    standards: [dcterms("type")],
  },
  {
    key: "date_created",
    label: "Date created",
    help: "When the original was made, as EDTF. When the file was made goes in Digitization notes.",
    kind: "date",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dcterms("created")],
  },
  {
    key: "creators",
    label: "Creators",
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [dcterms("creator")],
  },
  {
    key: "description",
    label: "Description",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dcterms("description")],
  },
  {
    key: "extent",
    label: "Extent",
    help: "Such as 12 pages or 3 minutes 20 seconds.",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dcterms("extent")],
  },
  {
    key: "source",
    label: "Source",
    help: "Staff only until the organization chooses to publish it: the original may be privately owned.",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
  },
  {
    key: "languages",
    label: "Languages",
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [dcterms("language")],
  },
  {
    key: "subjects",
    label: "Subjects",
    kind: "controlled_term",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [dcterms("subject")],
  },
  {
    key: "places",
    label: "Places",
    kind: "place",
    required: false,
    repeatable: true,
    visibility: "public",
    inherited: false,
    standards: [dcterms("spatial")],
  },
  {
    key: RIGHTS_FIELD_KEY,
    label: "Rights statement",
    help: RIGHTS_HELP,
    kind: "rights",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    standards: [dcterms("rights")],
  },
  {
    key: "rights_holder",
    label: "Rights holder",
    help: "Staff only until the organization chooses to publish it: the holder can be a private person.",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
  },
  {
    key: "digitization_notes",
    label: "Digitization notes",
    help: "Staff only. When and how the file was made: equipment, settings and who made it.",
    kind: "long_text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
  },
];

// ---------------------------------------------------------------------------

export const DACS_ARCHIVAL_UNIT_PRESET: TemplatePreset = deepFreeze({
  key: "dacs-archival-unit",
  label: "Archival unit (DACS)",
  description:
    "Describing Archives: A Content Standard (SAA, second edition). Each field cites its DACS element number.",
  appliesTo: ["archival_unit"],
  fields: DACS_FIELDS,
});

export const SPECTRUM_OBJECT_PRESET: TemplatePreset = deepFreeze({
  key: "spectrum-object",
  label: "Museum object (Spectrum)",
  description:
    "Spectrum 5.1 (Collections Trust) cataloguing and acquisition. Each field cites its Spectrum unit of information.",
  appliesTo: ["object"],
  fields: SPECTRUM_FIELDS,
});

export const DIGITAL_ASSET_PRESET: TemplatePreset = deepFreeze({
  key: "dublin-core-digital-asset",
  label: "Digital asset (Dublin Core)",
  description:
    "DCMI Metadata Terms, for scans, recordings and born-digital files. Each field cites its Dublin Core term.",
  appliesTo: ["digital_asset"],
  fields: DIGITAL_ASSET_FIELDS,
});

/** Every built-in preset, in the order the admin screens offer them. */
export const STANDARD_PRESETS: readonly TemplatePreset[] = Object.freeze([
  DACS_ARCHIVAL_UNIT_PRESET,
  SPECTRUM_OBJECT_PRESET,
  DIGITAL_ASSET_PRESET,
]);

const BY_KEY: ReadonlyMap<string, TemplatePreset> = new Map(
  STANDARD_PRESETS.map((p) => [p.key, p]),
);

/** The built-in preset with this key, or undefined. Never throws. */
export function standardPreset(key: unknown): TemplatePreset | undefined {
  return typeof key === "string" ? BY_KEY.get(key) : undefined;
}

/**
 * An organization's own template made from a preset: a copy of `preset`
 * with `organizationId` added, validated with `validateTemplate`. `preset`
 * may be a built-in preset or any template-shaped value without an
 * organization. One that already names an organization is refused, as a
 * guard against mistakes: this is not a security boundary (a caller holding
 * another organization's template could remove its organizationId first).
 * The service layer (T-032) loads only the session's organization's data,
 * which is what keeps organizations apart. Never throws.
 */
export function templateFromPreset(
  preset: unknown,
  organizationId: unknown,
): Validated<FieldTemplate> {
  try {
    if (types.isProxy(preset) || !isPlainObject(preset)) {
      return {
        ok: false,
        issues: [issue([], "not_an_object", "A preset must be a plain object.")],
      };
    }
    if (!isOrganizationId(organizationId)) {
      return {
        ok: false,
        issues: [
          issue(
            ["organizationId"],
            "invalid_organization",
            "A template made from a preset belongs to one organization: organizationId must be an organization ID.",
          ),
        ],
      };
    }
    if (Object.hasOwn(preset, "organizationId")) {
      return {
        ok: false,
        issues: [
          issue(
            ["organizationId"],
            "has_organization",
            "This already belongs to an organization. Presets have none; copy the template within its own organization instead.",
          ),
        ],
      };
    }
    // Copy the top level by descriptor, so no getter runs; validateTemplate
    // then reads the copy as plain data, refusing getters and Proxies inside.
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(preset)) {
      const slot = Object.getOwnPropertyDescriptor(preset, key);
      if (typeof key === "symbol" || slot === undefined || !("value" in slot) || !slot.enumerable) {
        return {
          ok: false,
          issues: [issue([], "not_plain_data", "A preset must hold only plain data.")],
        };
      }
      Object.defineProperty(copy, key, {
        value: slot.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    copy.organizationId = organizationId;
    return validateTemplate(copy);
  } catch {
    return {
      ok: false,
      issues: [issue([], "unreadable", "This preset could not be read as plain data.")],
    };
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
