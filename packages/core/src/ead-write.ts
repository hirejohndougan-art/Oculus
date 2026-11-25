/**
 * Writing EAD finding aids (D-107, D-110).
 *
 * `writeEad` writes the finding-aid model as EAD 2002 (namespaced, with
 * XLink, following TARO's tagging guidelines) or as EAD3 1.x. The model is
 * checked first (`validateFindingAid`), so every value written is one line of
 * clean text and every link a web address; all text is escaped. Reading the
 * result with `readEad` gives back the same model.
 *
 * Components are written as unnumbered `c` elements: both versions allow
 * them, and numbered ones stop at 12 levels where Oculus allows 64.
 * `audience="internal"` marks staff-only units and notes; which of those go
 * into a file at all is the exporter's choice (T-059b), not this module's.
 */
import {
  EAD2002_NAMESPACE,
  EAD2002_NORMAL_DATE,
  EAD3_NAMESPACE,
  EAD_VERSIONS,
  XLINK_NAMESPACE,
  validateFindingAid,
  type EadAccessPoint,
  type EadName,
  type EadNote,
  type EadUnit,
  type EadVersion,
  type FindingAid,
} from "./ead-model.js";
import { issue, type Issue, type Validated } from "./issues.js";

export interface EadWriteOptions {
  readonly version: EadVersion;
  /**
   * When the file was made, as an ISO 8601 date-time (`2026-11-25T10:00:00Z`).
   * EAD3 requires it in the maintenance history; EAD 2002 leaves it out.
   */
  readonly generatedAt: string;
  /** The agent named in EAD3's maintenance history. */
  readonly agent?: string;
}

export interface EadWritten {
  readonly xml: string;
  /** Values the chosen version can't hold, left out of the file. */
  readonly warnings: readonly Issue[];
}

const XSI = "http://www.w3.org/2001/XMLSchema-instance";
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

type Attrs = readonly (readonly [string, string | undefined])[];

class Xml {
  readonly lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  private depth = 0;

  private tag(name: string, attrs: Attrs): string {
    let out = `<${name}`;
    for (const [key, value] of attrs) {
      if (value !== undefined) out += ` ${key}="${escapeAttr(value)}"`;
    }
    return out;
  }
  private pad(): string {
    return "  ".repeat(this.depth);
  }
  open(name: string, attrs: Attrs = []): void {
    this.lines.push(`${this.pad()}${this.tag(name, attrs)}>`);
    this.depth += 1;
  }
  close(name: string): void {
    this.depth -= 1;
    this.lines.push(`${this.pad()}</${name}>`);
  }
  leaf(name: string, text: string, attrs: Attrs = []): void {
    this.lines.push(`${this.pad()}${this.tag(name, attrs)}>${escapeText(text)}</${name}>`);
  }
  empty(name: string, attrs: Attrs = []): void {
    this.lines.push(`${this.pad()}${this.tag(name, attrs)}/>`);
  }
  toString(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

class Writer {
  readonly x = new Xml();
  readonly warnings: Issue[] = [];
  constructor(
    readonly version: EadVersion,
    readonly options: EadWriteOptions,
  ) {}

  get v3(): boolean {
    return this.version === "ead3";
  }

  /** A name or term: mixed text in EAD 2002, a `part` in EAD3. */
  term(name: string, label: string, attrs: Attrs): void {
    if (this.v3) {
      this.x.open(name, attrs);
      this.x.leaf("part", label);
      this.x.close(name);
    } else this.x.leaf(name, label, attrs);
  }

  nameAttrs(n: EadName | EadAccessPoint, role: string | undefined): Attrs {
    return [
      [this.v3 ? "identifier" : "authfilenumber", n.identifier],
      ["source", n.source],
      [this.v3 ? "relator" : "role", role],
    ];
  }

  findingAid(aid: FindingAid): void {
    const { x } = this;
    if (this.v3) {
      x.open("ead", [
        ["xmlns", EAD3_NAMESPACE],
        ["xmlns:xsi", XSI],
        ["xsi:schemaLocation", `${EAD3_NAMESPACE} https://www.loc.gov/ead/ead3.xsd`],
      ]);
    } else {
      x.open("ead", [
        ["xmlns", EAD2002_NAMESPACE],
        ["xmlns:xlink", XLINK_NAMESPACE],
        ["xmlns:xsi", XSI],
        ["xsi:schemaLocation", `${EAD2002_NAMESPACE} https://www.loc.gov/ead/ead.xsd`],
      ]);
    }
    this.header(aid);
    this.unit(aid.archdesc, true, ["archdesc"]);
    x.close("ead");
  }

  header(aid: FindingAid): void {
    const { x } = this;
    const h = aid.header;
    const id = h.id ?? "";
    const title = h.title ?? "";
    x.open(this.v3 ? "control" : "eadheader");
    if (this.v3) x.leaf("recordid", id);
    else
      x.leaf("eadid", id, [
        ["countrycode", h.countryCode],
        ["mainagencycode", h.agencyCode],
      ]);
    x.open("filedesc");
    x.open("titlestmt");
    x.leaf("titleproper", title);
    if (h.subtitle !== undefined) x.leaf("subtitle", h.subtitle);
    if (h.author !== undefined) x.leaf("author", h.author);
    x.close("titlestmt");
    if (h.publisher !== undefined) {
      x.open("publicationstmt");
      x.leaf("publisher", h.publisher);
      x.close("publicationstmt");
    }
    if (h.notes.length > 0) {
      x.open("notestmt");
      for (const note of h.notes) {
        x.open(this.v3 ? "controlnote" : "note");
        x.leaf("p", note);
        x.close(this.v3 ? "controlnote" : "note");
      }
      x.close("notestmt");
    }
    x.close("filedesc");
    if (this.v3) {
      x.empty("maintenancestatus", [["value", "new"]]);
      x.open("maintenanceagency", [["countrycode", h.countryCode]]);
      if (h.agencyCode !== undefined) x.leaf("agencycode", h.agencyCode);
      x.leaf("agencyname", h.publisher ?? h.agencyCode ?? "Unknown");
      x.close("maintenanceagency");
      x.open("maintenancehistory");
      x.open("maintenanceevent");
      x.empty("eventtype", [["value", "created"]]);
      x.leaf("eventdatetime", this.options.generatedAt, [
        ["standarddatetime", this.options.generatedAt],
      ]);
      x.empty("agenttype", [["value", "machine"]]);
      x.leaf("agent", this.options.agent ?? "Oculus");
      x.close("maintenanceevent");
      x.close("maintenancehistory");
    }
    x.close(this.v3 ? "control" : "eadheader");
  }

  unit(u: EadUnit, top: boolean, path: (string | number)[]): void {
    const { x } = this;
    const name = top ? "archdesc" : "c";
    x.open(name, [
      ["level", u.level],
      ["audience", u.internal ? "internal" : undefined],
    ]);
    this.did(u, path);
    for (const note of u.notes) this.note(note);
    if (u.accessPoints.length > 0) {
      x.open("controlaccess");
      for (const t of u.accessPoints) this.term(t.element, t.label, this.nameAttrs(t, undefined));
      x.close("controlaccess");
    }
    if (u.children.length > 0) {
      if (top) x.open("dsc");
      for (const [i, child] of u.children.entries())
        this.unit(child, false, [...path, "children", i]);
      if (top) x.close("dsc");
    }
    x.close(name);
  }

  did(u: EadUnit, path: (string | number)[]): void {
    const { x } = this;
    x.open("did");
    for (const id of u.identifiers) x.leaf("unitid", id);
    if (u.title !== undefined) x.leaf("unittitle", u.title);
    for (const [i, d] of u.dates.entries()) {
      let normal = d.normal;
      if (normal !== undefined && !this.v3 && !EAD2002_NORMAL_DATE.test(normal)) {
        this.warnings.push(
          issue(
            [...path, "dates", i, "normal"],
            "normal_left_out",
            `EAD 2002 can't hold the normal form ${JSON.stringify(normal)}, so only the date's text was written.`,
          ),
        );
        normal = undefined;
      }
      x.leaf("unitdate", d.text, [
        ["normal", normal],
        [this.v3 ? "unitdatetype" : "type", d.type],
      ]);
    }
    for (const e of u.extents) {
      if ("text" in e) {
        if (this.v3) x.leaf("physdesc", e.text);
        else {
          x.open("physdesc");
          x.leaf("extent", e.text);
          x.close("physdesc");
        }
      } else if (this.v3) {
        x.open("physdescstructured", [
          ["coverage", "whole"],
          ["physdescstructuredtype", e.measure ?? "spaceoccupied"],
        ]);
        x.leaf("quantity", e.quantity);
        x.leaf("unittype", e.unit);
        x.close("physdescstructured");
      } else {
        x.open("physdesc");
        x.leaf("extent", e.quantity, [
          ["unit", e.unit],
          ["type", e.measure],
        ]);
        x.close("physdesc");
      }
    }
    if (u.creators.length > 0) {
      x.open("origination");
      for (const n of u.creators) this.term(n.element, n.label, this.nameAttrs(n, n.role));
      x.close("origination");
    }
    if (u.languages.length > 0) {
      x.open("langmaterial");
      for (const l of u.languages) x.leaf("language", l.label, [["langcode", l.code]]);
      x.close("langmaterial");
    }
    if (u.repository !== undefined) {
      x.open("repository");
      this.term("corpname", u.repository, []);
      x.close("repository");
    }
    for (const c of u.containers)
      x.leaf("container", c.value, [[this.v3 ? "localtype" : "type", c.type]]);
    for (const p of u.physicalLocations) x.leaf("physloc", p);
    for (const a of u.abstracts) x.leaf("abstract", a);
    for (const l of u.links) {
      if (this.v3) {
        x.empty("dao", [
          ["daotype", "unknown"],
          ["href", l.url],
          ["linktitle", l.label],
        ]);
      } else {
        x.empty("dao", [
          ["xlink:type", "simple"],
          ["xlink:href", l.url],
          ["xlink:title", l.label],
        ]);
      }
    }
    x.close("did");
  }

  note(n: EadNote): void {
    const { x } = this;
    x.open(n.kind, [["audience", n.internal ? "internal" : undefined]]);
    if (n.head !== undefined) x.leaf("head", n.head);
    for (const p of n.paragraphs) x.leaf("p", p);
    x.close(n.kind);
  }
}

/**
 * Write a finding aid as EAD 2002 or EAD3. Refuses (with every problem) a
 * model that doesn't pass `validateFindingAid`. Never throws.
 */
export function writeEad(aid: unknown, options: EadWriteOptions): Validated<EadWritten> {
  if (!(EAD_VERSIONS as readonly unknown[]).includes(options.version)) {
    return {
      ok: false,
      issues: [issue(["version"], "not_allowed", "The version must be ead2002 or ead3.")],
    };
  }
  if (typeof options.generatedAt !== "string" || !DATE_TIME.test(options.generatedAt)) {
    return {
      ok: false,
      issues: [
        issue(["generatedAt"], "not_a_date", "generatedAt must be an ISO 8601 date or date-time."),
      ],
    };
  }
  if (
    options.agent !== undefined &&
    (typeof options.agent !== "string" || !/^[\p{L}\p{N} ._-]{1,100}$/u.test(options.agent))
  ) {
    return {
      ok: false,
      issues: [issue(["agent"], "not_allowed", "The agent must be a short name.")],
    };
  }
  const checked = validateFindingAid(aid);
  if (!checked.ok) return checked;
  const w = new Writer(options.version, options);
  w.findingAid(checked.value);
  return { ok: true, value: { xml: w.x.toString(), warnings: w.warnings } };
}
