/**
 * Reading EAD finding aids (D-107, D-110).
 *
 * `readEad` reads EAD 2002 (with its namespace or without, as DTD-era tools
 * wrote it) and every EAD3 1.x release into the one model in `ead-model.ts`.
 * The version comes from the root element and its namespace, never from a
 * file name. A file in an EAD namespace Oculus doesn't know (an EAD4) is
 * refused, not guessed at.
 *
 * Nothing is dropped silently. Every element, attribute and piece of text
 * that isn't mapped is listed in the report with its path, markup that is
 * flattened into plain text (links, names inside a paragraph, lists) is
 * listed too, and every level that changed is listed. Text marked
 * `audience="internal"` is never folded into text that isn't: where the
 * model can't mark it staff-only it is left out and listed. The importer
 * keeps the original file, so what the report lists is not lost.
 *
 * Parsing is `parseXml`'s: no DOCTYPE internal subset, no entities beyond
 * XML's five, nothing fetched, and limits on size and nesting. Never throws.
 */
import { MAX_ARRANGEMENT_DEPTH, canFileUnder } from "./arrangement.js";
import {
  EAD2002_NAMESPACE,
  EAD3_NAMESPACE,
  EAD_ACCESS_ELEMENTS,
  EAD_NAME_ELEMENTS,
  EAD_NOTE_KINDS,
  MAX_EAD_TEXT_LENGTH,
  MAX_EAD_UNITS,
  XLINK_NAMESPACE,
  eadDateEdtf,
  levelFromEad,
  normalizeEadText,
  type EadAccessElement,
  type EadAccessPoint,
  type EadContainer,
  type EadDate,
  type EadExtent,
  type EadHeader,
  type EadLanguage,
  type EadLink,
  type EadName,
  type EadNameElement,
  type EadNote,
  type EadNoteKind,
  type EadUnit,
  type EadVersion,
  type FindingAid,
} from "./ead-model.js";
import { issue, type Validated } from "./issues.js";
import { shown, textProblem, withoutBadText } from "./plain-data.js";
import type { ArchivalLevel } from "./records.js";
import { webUrlProblem } from "./templates.js";
import { parseXml, type XmlElement } from "./xml-tree.js";

export interface EadNotice {
  /** Where in the file, such as `/ead/archdesc/dsc/c01[2]/did/unittitle`. */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface EadLevelChange {
  readonly path: string;
  /** The level as the file gave it (`@level`, or `otherlevel:<name>`), or "" if none. */
  readonly from: string;
  readonly to: ArchivalLevel;
}

export interface EadReadReport {
  readonly version: EadVersion;
  /** False for an EAD 2002 file with no namespace (DTD-era). */
  readonly namespaced: boolean;
  /** Elements, attributes and text that aren't in the model, and markup flattened into text. */
  readonly unmapped: readonly EadNotice[];
  /** Values that were changed or left out: bad links, cleaned text, dates that aren't EDTF. */
  readonly warnings: readonly EadNotice[];
  readonly levelChanges: readonly EadLevelChange[];
  /** Notices past the cap of `MAX_EAD_NOTICES` per list, counted but not listed. */
  readonly omitted: number;
}

export interface EadRead {
  readonly findingAid: FindingAid;
  readonly report: EadReadReport;
}

/** The most notices listed in each of `unmapped` and `warnings`. */
export const MAX_EAD_NOTICES = 2000;

const C_NAMES: ReadonlySet<string> = new Set([
  "c",
  ...Array.from({ length: 12 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`),
]);
const NOTE_KINDS: ReadonlySet<string> = new Set(EAD_NOTE_KINDS);
const NAME_ELEMENTS: ReadonlySet<string> = new Set(EAD_NAME_ELEMENTS);
const ACCESS_ELEMENTS: ReadonlySet<string> = new Set(EAD_ACCESS_ELEMENTS);
/** Formatting only: its text is kept and nothing else is lost. */
const RENDER_ONLY: ReadonlySet<string> = new Set([
  "emph",
  "lb",
  "abbr",
  "expan",
  "foreign",
  "quote",
  "part",
]);
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";

type Path = string;

class Reader {
  readonly unmapped: EadNotice[] = [];
  readonly warnings: EadNotice[] = [];
  readonly levelChanges: EadLevelChange[] = [];
  omitted = 0;
  units = 0;
  /** How many staff-only units the reader is inside; everything there is staff-only already. */
  staffOnly = 0;
  fatal: { code: string; message: string } | undefined;

  constructor(
    readonly version: EadVersion,
    /** The namespace EAD elements are in: "" for DTD-era EAD 2002. */
    readonly ns: string,
  ) {}

  private push(list: EadNotice[], path: Path, code: string, message: string): void {
    if (list.length >= MAX_EAD_NOTICES) this.omitted += 1;
    else list.push({ path, code, message });
  }
  skip(path: Path, code: string, message: string): void {
    this.push(this.unmapped, path, code, message);
  }
  warn(path: Path, code: string, message: string): void {
    this.push(this.warnings, path, code, message);
  }

  // -------------------------------------------------------------------------
  // Generic helpers.

  /** Attribute key: `name`, `xlink:name`, `xml:name`, or `{ns}name`. */
  private attrKey(name: string, ns: string): string {
    if (ns === "") return name;
    if (ns === XLINK_NAMESPACE) return `xlink:${name}`;
    if (ns === XML_NAMESPACE) return `xml:${name}`;
    if (ns === XSI_NAMESPACE) return `xsi:${name}`;
    return `{${ns}}${name}`;
  }

  /**
   * The attributes of `el` that `known` names, normalized. Every other
   * attribute is reported, except the ones in `ignored`, which are XML
   * plumbing that holds no description (an XLink's fixed `type="simple"`).
   */
  attrs(
    el: XmlElement,
    path: Path,
    known: readonly string[],
    ignored: readonly string[] = [],
  ): Map<string, string> {
    const found = new Map<string, string>();
    for (const a of el.attributes) {
      const key = this.attrKey(a.name, a.ns);
      if (known.includes(key)) {
        const value = normalizeEadText(a.value);
        if (value !== "") found.set(key, value);
      } else if (!ignored.includes(key)) {
        this.skip(
          `${path}/@${key}`,
          "unmapped_attribute",
          `The attribute ${shown(key)} isn't kept.`,
        );
      }
    }
    return found;
  }

  /** True if `el` is an EAD element (in the file's EAD namespace). */
  isEad(el: XmlElement): boolean {
    return el.ns === this.ns;
  }

  /** Child elements with their paths; stray text is reported unless `reportText` is false. */
  children(el: XmlElement, path: Path, reportText = true): { el: XmlElement; path: Path }[] {
    const counts = new Map<string, number>();
    const out: { el: XmlElement; path: Path }[] = [];
    for (const child of el.children) {
      if (typeof child === "string") {
        if (reportText && child.trim() !== "") {
          this.skip(
            path,
            "unmapped_text",
            `Text directly in ${shown(el.name)} isn't kept: ${shown(child.trim())}.`,
          );
        }
        continue;
      }
      const n = (counts.get(child.name) ?? 0) + 1;
      counts.set(child.name, n);
      const childPath = `${path}/${this.isEad(child) ? child.name : `{${child.ns}}${child.name}`}[${String(n)}]`;
      if (!this.isEad(child)) {
        this.skip(
          childPath,
          "foreign_element",
          `The element ${shown(child.name)} from another namespace (${shown(child.ns)}) isn't kept.`,
        );
        continue;
      }
      out.push({ el: child, path: childPath });
    }
    return out;
  }

  unknown(path: Path, el: XmlElement, where: string): void {
    this.skip(path, "unmapped_element", `The element ${shown(el.name)} in ${where} isn't kept.`);
  }

  /** True if `audience="internal"` (staff-only). Reads only the attribute. */
  internal(el: XmlElement): boolean {
    return el.attributes.some(
      (a) => a.ns === "" && a.name === "audience" && normalizeEadText(a.value) === "internal",
    );
  }

  /**
   * An element the model can't mark staff-only: false (and reported) if it
   * is `audience="internal"`, so its text is never treated as public.
   */
  publicOnly(el: XmlElement, path: Path): boolean {
    if (this.staffOnly > 0 || !this.internal(el)) return true;
    this.warn(
      path,
      "internal_left_out",
      `${shown(el.name)} is marked staff-only (audience="internal") and can't be kept as staff-only here, so it was left out.`,
    );
    return false;
  }

  /** Clean text for the model: no control characters, not too long. */
  clean(text: string, path: Path): string {
    let value = normalizeEadText(text);
    if (textProblem(value) !== undefined) {
      value = normalizeEadText(withoutBadText(value));
      this.warn(
        path,
        "text_cleaned",
        "Invisible control or direction-changing characters were removed.",
      );
    }
    if (value.length > MAX_EAD_TEXT_LENGTH) {
      value = normalizeEadText(value.slice(0, MAX_EAD_TEXT_LENGTH));
      this.warn(path, "text_cut", `The text was cut to ${String(MAX_EAD_TEXT_LENGTH)} characters.`);
    }
    return value;
  }

  /**
   * The text of mixed content, with markup flattened. Formatting (emph, lb)
   * goes quietly; other markup (links, names, dates) is listed as flattened;
   * staff-only markup is left out and listed. `except` elements are skipped
   * (the caller reads them).
   */
  inline(el: XmlElement, path: Path, except: ReadonlySet<string> = new Set()): string {
    const parts: string[] = [];
    const counts = new Map<string, number>();
    for (const child of el.children) {
      if (typeof child === "string") {
        parts.push(child);
        continue;
      }
      const n = (counts.get(child.name) ?? 0) + 1;
      counts.set(child.name, n);
      const childPath = `${path}/${child.name}[${String(n)}]`;
      if (this.isEad(child) && except.has(child.name)) continue;
      if (this.staffOnly === 0 && this.internal(child)) {
        this.warn(
          childPath,
          "internal_left_out",
          `Staff-only text (audience="internal") inside ${shown(el.name)} was left out of it.`,
        );
        continue;
      }
      if (child.name === "lb") {
        parts.push(" ");
        continue;
      }
      if (!this.isEad(child)) {
        this.skip(
          childPath,
          "foreign_element",
          `The element ${shown(child.name)} from another namespace isn't kept; its text is.`,
        );
      } else if (!RENDER_ONLY.has(child.name)) {
        this.skip(childPath, "markup_flattened", `${shown(child.name)} was kept as plain text.`);
      }
      parts.push(" ", this.inline(child, childPath), " ");
    }
    return parts.join("");
  }

  /** Inline text, cleaned; undefined if empty. */
  textOf(el: XmlElement, path: Path, except?: ReadonlySet<string>): string | undefined {
    const value = this.clean(this.inline(el, path, except), path);
    return value === "" ? undefined : value;
  }

  /** EAD3 names and terms hold their text in `part`s; EAD 2002's are mixed text. */
  termText(el: XmlElement, path: Path): string | undefined {
    if (this.version === "ead2002") return this.textOf(el, path);
    const parts: string[] = [];
    for (const { el: child, path: p } of this.children(el, path)) {
      if (child.name !== "part") {
        this.unknown(p, child, shown(el.name));
        continue;
      }
      if (!this.publicOnly(child, p)) continue;
      this.attrs(child, p, []);
      const text = this.textOf(child, p);
      if (text !== undefined) parts.push(text);
    }
    if (parts.length > 1) {
      this.skip(
        path,
        "parts_joined",
        `The ${String(parts.length)} parts of ${shown(el.name)} were joined into one name.`,
      );
    }
    const joined = parts.join(", ");
    return joined === "" ? undefined : joined;
  }

  // -------------------------------------------------------------------------
  // The header.

  header(el: XmlElement | undefined, path: Path): EadHeader {
    const h: { -readonly [K in keyof EadHeader]?: EadHeader[K] } = {};
    const notes: string[] = [];
    if (el === undefined) {
      this.warn(path, "no_header", "The file has no header (eadheader or control).");
      return { notes };
    }
    this.attrs(el, path, [], ["audience"]);
    let agencyName: string | undefined;
    for (const { el: child, path: p } of this.children(el, path)) {
      if (child.name === "eadid" || child.name === "recordid") {
        const a = this.attrs(
          child,
          p,
          child.name === "eadid" ? ["countrycode", "mainagencycode"] : [],
        );
        const id = this.textOf(child, p);
        if (id !== undefined) h.id = id;
        const country = a.get("countrycode");
        if (country !== undefined) h.countryCode = country;
        const agency = a.get("mainagencycode");
        if (agency !== undefined) h.agencyCode = agency;
      } else if (child.name === "filedesc") {
        this.filedesc(child, p, h, notes);
      } else if (child.name === "maintenanceagency" && this.version === "ead3") {
        const a = this.attrs(child, p, ["countrycode"]);
        const country = a.get("countrycode");
        if (country !== undefined) h.countryCode = country;
        for (const { el: m, path: mp } of this.children(child, p)) {
          if (m.name === "agencycode") {
            this.attrs(m, mp, []);
            const code = this.textOf(m, mp);
            if (code !== undefined) h.agencyCode = code;
          } else if (m.name === "agencyname" && agencyName === undefined) {
            this.attrs(m, mp, []);
            agencyName = this.textOf(m, mp);
          } else this.unknown(mp, m, "maintenanceagency");
        }
      } else {
        this.unknown(p, child, shown(el.name));
      }
    }
    // EAD3 needs an agency name; Oculus writes the publisher (or the code) there.
    if (agencyName !== undefined && agencyName !== h.publisher && agencyName !== h.agencyCode) {
      this.skip(
        `${path}/maintenanceagency[1]/agencyname[1]`,
        "unmapped_element",
        `The agency name ${shown(agencyName)} isn't kept (the publisher is).`,
      );
    }
    return { ...h, notes };
  }

  private filedesc(
    el: XmlElement,
    path: Path,
    h: { -readonly [K in keyof EadHeader]?: EadHeader[K] },
    notes: string[],
  ): void {
    this.attrs(el, path, []);
    for (const { el: child, path: p } of this.children(el, path)) {
      if (child.name === "titlestmt") {
        this.attrs(child, p, []);
        for (const { el: t, path: tp } of this.children(child, p)) {
          const key =
            t.name === "titleproper"
              ? "title"
              : t.name === "subtitle"
                ? "subtitle"
                : t.name === "author"
                  ? "author"
                  : undefined;
          if (key === undefined || h[key] !== undefined || !this.publicOnly(t, tp)) {
            if (key === undefined || h[key] !== undefined) this.unknown(tp, t, "titlestmt");
            continue;
          }
          this.attrs(t, tp, []);
          const text = this.textOf(t, tp);
          if (text !== undefined) h[key] = text;
        }
      } else if (child.name === "publicationstmt") {
        this.attrs(child, p, []);
        for (const { el: t, path: tp } of this.children(child, p)) {
          if (t.name === "publisher" && h.publisher === undefined && this.publicOnly(t, tp)) {
            this.attrs(t, tp, []);
            const text = this.textOf(t, tp);
            if (text !== undefined) h.publisher = text;
          } else this.unknown(tp, t, "publicationstmt");
        }
      } else if (child.name === "notestmt") {
        this.attrs(child, p, []);
        const noteName = this.version === "ead3" ? "controlnote" : "note";
        for (const { el: n, path: np } of this.children(child, p)) {
          if (n.name !== noteName || !this.publicOnly(n, np)) {
            if (n.name !== noteName) this.unknown(np, n, "notestmt");
            continue;
          }
          this.attrs(n, np, []);
          for (const { el: para, path: pp } of this.children(n, np)) {
            if (para.name !== "p") {
              this.unknown(pp, para, shown(noteName));
              continue;
            }
            if (!this.publicOnly(para, pp)) continue;
            this.attrs(para, pp, []);
            const text = this.textOf(para, pp);
            if (text !== undefined) notes.push(text);
          }
        }
      } else {
        this.unknown(p, child, "filedesc");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Units.

  unit(
    el: XmlElement,
    path: Path,
    depth: number,
    parent: ArchivalLevel | undefined,
  ): EadUnit | undefined {
    this.units += 1;
    if (this.units > MAX_EAD_UNITS) {
      this.fatal ??= {
        code: "too_many_units",
        message: `The finding aid has more than ${String(MAX_EAD_UNITS)} components.`,
      };
      return undefined;
    }
    if (depth > MAX_ARRANGEMENT_DEPTH) {
      this.fatal ??= {
        code: "too_deep",
        message: `Components are nested more than ${String(MAX_ARRANGEMENT_DEPTH)} levels deep.`,
      };
      return undefined;
    }
    const a = this.attrs(el, path, ["level", "otherlevel", "audience"]);
    const given = a.get("level");
    const fallback: ArchivalLevel = depth === 1 ? "collection" : "file";
    const mapped = levelFromEad(given, a.get("otherlevel"), fallback);
    if (mapped.changed) {
      const from =
        given === "otherlevel" ? `otherlevel:${a.get("otherlevel") ?? ""}` : (given ?? "");
      this.levelChanges.push({ path, from, to: mapped.level });
    }
    if (parent !== undefined && !canFileUnder(mapped.level, parent)) {
      this.warn(
        path,
        "level_order",
        `A ${mapped.level} can't be filed under a ${parent} in Oculus; it will need moving after import.`,
      );
    }

    const u = {
      level: mapped.level,
      internal: a.get("audience") === "internal",
      identifiers: [] as string[],
      dates: [] as EadDate[],
      extents: [] as EadExtent[],
      creators: [] as EadName[],
      languages: [] as EadLanguage[],
      containers: [] as EadContainer[],
      physicalLocations: [] as string[],
      abstracts: [] as string[],
      notes: [] as EadNote[],
      accessPoints: [] as EadAccessPoint[],
      links: [] as EadLink[],
      children: [] as EadUnit[],
    };
    const optional: { title?: string; repository?: string } = {};
    let sawDid = false;
    if (u.internal) this.staffOnly += 1;
    try {
      for (const { el: child, path: p } of this.children(el, path)) {
        if (this.fatal !== undefined) return undefined;
        const name = child.name;
        if (name === "did" && !sawDid) {
          sawDid = true;
          this.did(child, p, u, optional);
        } else if (NOTE_KINDS.has(name)) {
          const note = this.note(child, p, name as EadNoteKind);
          if (note !== undefined) u.notes.push(note);
        } else if (name === "controlaccess") {
          this.controlaccess(child, p, u.accessPoints);
        } else if (name === "dsc" && depth === 1) {
          this.attrs(child, p, [], []);
          for (const { el: c, path: cp } of this.children(child, p)) {
            if (C_NAMES.has(c.name)) {
              const unit = this.unit(c, cp, depth + 1, mapped.level);
              if (unit !== undefined) u.children.push(unit);
            } else this.unknown(cp, c, "dsc");
          }
        } else if (C_NAMES.has(name) && depth > 1) {
          const unit = this.unit(child, p, depth + 1, mapped.level);
          if (unit !== undefined) u.children.push(unit);
        } else if ((name === "dao" || name === "daogrp") && this.version === "ead2002") {
          this.dao(child, p, u.links);
        } else {
          this.unknown(p, child, depth === 1 ? "archdesc" : "a component");
        }
      }
    } finally {
      if (u.internal) this.staffOnly -= 1;
    }
    if (!sawDid) this.warn(path, "no_did", "The component has no did, so no title or date.");
    if (optional.title === undefined && u.dates.length === 0) {
      this.warn(path, "no_title", "The component has no title and no date.");
    }
    return { ...u, ...optional };
  }

  private did(
    el: XmlElement,
    path: Path,
    u: {
      identifiers: string[];
      dates: EadDate[];
      extents: EadExtent[];
      creators: EadName[];
      languages: EadLanguage[];
      containers: EadContainer[];
      physicalLocations: string[];
      abstracts: string[];
      links: EadLink[];
    },
    optional: { title?: string; repository?: string },
  ): void {
    this.attrs(el, path, []);
    for (const { el: child, path: p } of this.children(el, path)) {
      const name = child.name;
      if (!this.publicOnly(child, p)) continue;
      switch (name) {
        case "unitid": {
          this.attrs(child, p, [], ["audience"]);
          const id = this.textOf(child, p);
          if (id !== undefined) u.identifiers.push(id);
          break;
        }
        case "unittitle": {
          this.attrs(child, p, [], ["audience"]);
          if (optional.title !== undefined) {
            this.unknown(p, child, "did (a second title)");
            break;
          }
          // EAD 2002 lets a date sit inside the title.
          const inner = this.version === "ead2002" ? new Set(["unitdate"]) : new Set<string>();
          const title = this.textOf(child, p, inner);
          const innerDates =
            this.version === "ead2002"
              ? this.children(child, p, false).filter((c) => c.el.name === "unitdate")
              : [];
          // "Smith papers, <unitdate>1900</unitdate>": the comma belonged to the date.
          if (title !== undefined) {
            optional.title =
              innerDates.length > 0 ? title.replace(/[\s,;:]+$/, "") || title : title;
          }
          {
            for (const { el: d, path: dp } of innerDates) {
              const date = this.unitdate(d, dp);
              if (date !== undefined) u.dates.push(date);
            }
          }
          break;
        }
        case "unitdate": {
          const date = this.unitdate(child, p);
          if (date !== undefined) u.dates.push(date);
          break;
        }
        case "unitdatestructured":
          if (this.version === "ead3") this.unitdatestructured(child, p, u.dates);
          else this.unknown(p, child, "did");
          break;
        case "physdesc":
          this.physdesc(child, p, u.extents);
          break;
        case "physdescstructured":
        case "physdescset":
          if (this.version !== "ead3") this.unknown(p, child, "did");
          else if (name === "physdescset") {
            this.attrs(child, p, [], ["audience"]);
            this.skip(p, "structure_flattened", "The physdescset was read as separate extents.");
            for (const { el: s, path: sp } of this.children(child, p)) {
              if (s.name === "physdescstructured" && this.publicOnly(s, sp))
                this.physdescstructured(s, sp, u.extents);
              else if (s.name !== "physdescstructured") this.unknown(sp, s, "physdescset");
            }
          } else this.physdescstructured(child, p, u.extents);
          break;
        case "origination":
          this.attrs(child, p, [], ["audience", "label"]);
          for (const { el: n, path: np } of this.children(child, p)) {
            if (!NAME_ELEMENTS.has(n.name)) {
              this.unknown(np, n, "origination");
              continue;
            }
            if (!this.publicOnly(n, np)) continue;
            const name = this.name(n, np);
            if (name !== undefined) u.creators.push(name);
          }
          break;
        case "langmaterial":
          this.langmaterial(child, p, u.languages);
          break;
        case "repository": {
          this.attrs(child, p, [], ["audience", "label"]);
          if (optional.repository !== undefined) {
            this.unknown(p, child, "did (a second repository)");
            break;
          }
          const names = this.children(child, p);
          const first = names.find((n) => NAME_ELEMENTS.has(n.el.name));
          if (first !== undefined) {
            if (this.publicOnly(first.el, first.path)) {
              this.attrs(first.el, first.path, [], ["audience"]);
              const text = this.termText(first.el, first.path);
              if (text !== undefined) optional.repository = text;
            }
            for (const n of names) if (n !== first) this.unknown(n.path, n.el, "repository");
            // Mixed text beside the name in EAD 2002.
            const loose = child.children
              .filter((c) => typeof c === "string")
              .join("")
              .trim();
            if (loose !== "")
              this.skip(
                p,
                "unmapped_text",
                `Text beside the repository name isn't kept: ${shown(loose)}.`,
              );
          } else if (this.version === "ead2002") {
            const text = this.textOf(child, p);
            if (text !== undefined) optional.repository = text;
          } else {
            for (const n of names) this.unknown(n.path, n.el, "repository");
          }
          break;
        }
        case "container": {
          const a = this.attrs(
            child,
            p,
            [this.version === "ead3" ? "localtype" : "type"],
            ["audience"],
          );
          const value = this.textOf(child, p);
          if (value === undefined) break;
          const type = a.get(this.version === "ead3" ? "localtype" : "type");
          u.containers.push(type === undefined ? { value } : { type, value });
          break;
        }
        case "physloc":
        case "abstract": {
          this.attrs(child, p, [], ["audience"]);
          const text = this.textOf(child, p);
          if (text !== undefined)
            (name === "physloc" ? u.physicalLocations : u.abstracts).push(text);
          break;
        }
        case "dao":
        case "daogrp":
        case "daoset":
          if (
            (name === "daogrp" && this.version !== "ead2002") ||
            (name === "daoset" && this.version !== "ead3")
          ) {
            this.unknown(p, child, "did");
          } else this.dao(child, p, u.links);
          break;
        default:
          this.unknown(p, child, "did");
      }
    }
  }

  private unitdate(el: XmlElement, path: Path): EadDate | undefined {
    if (!this.publicOnly(el, path)) return undefined;
    const typeAttr = this.version === "ead3" ? "unitdatetype" : "type";
    const a = this.attrs(el, path, ["normal", typeAttr, "era", "calendar"], ["audience"]);
    for (const [attr, usual] of [
      ["era", "ce"],
      ["calendar", "gregorian"],
    ] as const) {
      const value = a.get(attr);
      if (value !== undefined && value !== usual) {
        this.skip(
          `${path}/@${attr}`,
          "unmapped_attribute",
          `The ${attr} ${shown(value)} isn't kept.`,
        );
      }
    }
    const text = this.textOf(el, path);
    const normal = a.get("normal");
    if (text === undefined) {
      if (normal === undefined) return undefined;
      this.warn(
        path,
        "date_text_from_normal",
        "The date had no text, so its normal form was used.",
      );
    }
    const date: { text: string; normal?: string; type?: "inclusive" | "bulk" } = {
      text: text ?? normal ?? "",
    };
    if (normal !== undefined) date.normal = normal;
    const type = a.get(typeAttr);
    if (type === "inclusive" || type === "bulk") date.type = type;
    else if (type !== undefined)
      this.skip(
        `${path}/@${typeAttr}`,
        "unmapped_attribute",
        `The date type ${shown(type)} isn't kept.`,
      );
    this.checkDate(date, path);
    return date;
  }

  private checkDate(date: EadDate, path: Path): void {
    const edtf = eadDateEdtf(date);
    if (!edtf.ok) {
      this.warn(
        path,
        "date_not_edtf",
        `The date ${shown(date.text)} can't safely be read as EDTF, so it stays as text: ${edtf.issues[0]?.message ?? ""}`,
      );
    }
  }

  private unitdatestructured(el: XmlElement, path: Path, dates: EadDate[]): void {
    const a = this.attrs(el, path, ["unitdatetype", "era", "calendar"], ["audience"]);
    const type = a.get("unitdatetype");
    const read = (d: XmlElement, p: Path): void => {
      if (!this.publicOnly(d, p)) return;
      if (d.name === "datesingle") {
        const da = this.attrs(d, p, ["standarddate"]);
        const text = this.textOf(d, p);
        const std = da.get("standarddate");
        const t = text ?? std;
        if (t === undefined) return;
        const date: { text: string; normal?: string; type?: "inclusive" | "bulk" } = { text: t };
        if (std !== undefined) date.normal = std;
        if (type === "inclusive" || type === "bulk") date.type = type;
        this.checkDate(date, p);
        dates.push(date);
      } else if (d.name === "daterange") {
        this.attrs(d, p, []);
        let from: { text?: string; std?: string } = {};
        let to: { text?: string; std?: string } = {};
        for (const { el: end, path: ep } of this.children(d, p)) {
          if (end.name !== "fromdate" && end.name !== "todate") {
            this.unknown(ep, end, "daterange");
            continue;
          }
          const ea = this.attrs(end, ep, ["standarddate"]);
          const v: { text?: string; std?: string } = {};
          const text = this.textOf(end, ep);
          if (text !== undefined) v.text = text;
          const std = ea.get("standarddate");
          if (std !== undefined) v.std = std;
          if (end.name === "fromdate") from = v;
          else to = v;
        }
        const f = from.text ?? from.std ?? "";
        const t = to.text ?? to.std ?? "";
        if (f === "" && t === "") return;
        const date: { text: string; normal?: string; type?: "inclusive" | "bulk" } = {
          text: f !== "" && t !== "" ? `${f}-${t}` : f !== "" ? `${f}-` : `-${t}`,
        };
        if (from.std !== undefined || to.std !== undefined) {
          date.normal = `${from.std ?? ".."}/${to.std ?? ".."}`;
        }
        if (type === "inclusive" || type === "bulk") date.type = type;
        this.skip(p, "structure_flattened", "The date range was kept as one date.");
        this.checkDate(date, p);
        dates.push(date);
      } else this.unknown(p, d, "unitdatestructured");
    };
    for (const { el: d, path: p } of this.children(el, path)) {
      if (d.name === "dateset") {
        this.attrs(d, p, []);
        this.skip(
          p,
          "structure_flattened",
          "The dates in the dateset were kept as separate dates.",
        );
        for (const { el: dd, path: dp } of this.children(d, p)) read(dd, dp);
      } else read(d, p);
    }
  }

  private physdesc(el: XmlElement, path: Path, extents: EadExtent[]): void {
    this.attrs(el, path, [], ["audience", "label"]);
    if (this.version === "ead3") {
      const text = this.textOf(el, path);
      if (text !== undefined) extents.push({ text });
      return;
    }
    const kids = this.children(el, path);
    if (kids.length === 0) {
      const text = this.textOf(el, path);
      if (text !== undefined) extents.push({ text });
      return;
    }
    for (const { el: k, path: p } of kids) {
      if (k.name !== "extent") {
        this.unknown(p, k, "physdesc");
        continue;
      }
      if (!this.publicOnly(k, p)) continue;
      const a = this.attrs(k, p, ["unit", "type"], ["audience"]);
      const text = this.textOf(k, p);
      if (text === undefined) continue;
      const unit = a.get("unit");
      const type = a.get("type");
      if (unit !== undefined && /^\d+(?:\.\d+)?$/.test(text)) {
        const e: { quantity: string; unit: string; measure?: "carrier" | "materialtype" } = {
          quantity: text,
          unit,
        };
        if (type === "carrier" || type === "materialtype") e.measure = type;
        else if (type !== undefined && type !== "spaceoccupied") {
          this.skip(
            `${p}/@type`,
            "unmapped_attribute",
            `The extent type ${shown(type)} isn't kept.`,
          );
        }
        extents.push(e);
      } else {
        if (unit !== undefined) {
          this.warn(
            p,
            "extent_as_text",
            "The extent isn't a plain number, so it was kept as text with its unit.",
          );
        }
        if (type !== undefined)
          this.skip(
            `${p}/@type`,
            "unmapped_attribute",
            `The extent type ${shown(type)} isn't kept.`,
          );
        extents.push({ text: unit === undefined ? text : `${text} ${unit}` });
      }
    }
  }

  private physdescstructured(el: XmlElement, path: Path, extents: EadExtent[]): void {
    const a = this.attrs(el, path, ["coverage", "physdescstructuredtype"], ["audience"]);
    let quantity: string | undefined;
    let unit: string | undefined;
    for (const { el: k, path: p } of this.children(el, path)) {
      if ((k.name === "quantity" || k.name === "unittype") && this.publicOnly(k, p)) {
        this.attrs(k, p, []);
        const text = this.textOf(k, p);
        if (k.name === "quantity") quantity = text;
        else unit = text;
      } else if (k.name !== "quantity" && k.name !== "unittype")
        this.unknown(p, k, "physdescstructured");
    }
    if (quantity === undefined || unit === undefined) {
      if (quantity !== undefined || unit !== undefined) {
        extents.push({ text: [quantity, unit].filter((x) => x !== undefined).join(" ") });
        this.warn(
          path,
          "extent_as_text",
          "The extent has no quantity or no unit, so it was kept as text.",
        );
      }
      return;
    }
    const coverage = a.get("coverage");
    if (coverage !== undefined && coverage !== "whole") {
      this.skip(
        `${path}/@coverage`,
        "unmapped_attribute",
        `The coverage ${shown(coverage)} isn't kept.`,
      );
    }
    if (!/^\d+(?:\.\d+)?$/.test(quantity)) {
      this.warn(
        path,
        "extent_as_text",
        "The quantity isn't a plain number, so the extent was kept as text.",
      );
      extents.push({ text: `${quantity} ${unit}` });
      return;
    }
    const e: { quantity: string; unit: string; measure?: "carrier" | "materialtype" } = {
      quantity,
      unit,
    };
    const type = a.get("physdescstructuredtype");
    if (type === "carrier" || type === "materialtype") e.measure = type;
    else if (type !== undefined && type !== "spaceoccupied") {
      this.skip(
        `${path}/@physdescstructuredtype`,
        "unmapped_attribute",
        `The extent type ${shown(type)} isn't kept.`,
      );
    }
    extents.push(e);
  }

  private name(el: XmlElement, path: Path): EadName | undefined {
    const v3 = this.version === "ead3";
    const a = this.attrs(
      el,
      path,
      [v3 ? "identifier" : "authfilenumber", "source", v3 ? "relator" : "role"],
      ["audience"],
    );
    const label = this.termText(el, path);
    if (label === undefined) return undefined;
    const n: {
      element: EadNameElement;
      label: string;
      identifier?: string;
      source?: string;
      role?: string;
    } = {
      element: el.name as EadNameElement,
      label,
    };
    const identifier = a.get(v3 ? "identifier" : "authfilenumber");
    if (identifier !== undefined) n.identifier = identifier;
    const source = a.get("source");
    if (source !== undefined) n.source = source;
    const role = a.get(v3 ? "relator" : "role");
    if (role !== undefined) n.role = role;
    return n;
  }

  private langmaterial(el: XmlElement, path: Path, languages: EadLanguage[]): void {
    this.attrs(el, path, [], ["audience", "label"]);
    const read = (l: XmlElement, p: Path): void => {
      if (!this.publicOnly(l, p)) return;
      const a = this.attrs(l, p, ["langcode"]);
      const label = this.textOf(l, p) ?? a.get("langcode");
      if (label === undefined) return;
      const code = a.get("langcode");
      languages.push(code === undefined ? { label } : { label, code });
    };
    const loose = el.children
      .filter((c) => typeof c === "string")
      .join("")
      .trim();
    if (loose !== "" && this.version === "ead2002") {
      const kids = el.children.filter((c) => typeof c !== "string");
      if (kids.length === 0) {
        const label = this.clean(loose, path);
        if (label !== "") languages.push({ label });
        return;
      }
      this.skip(path, "unmapped_text", `Text around the languages isn't kept: ${shown(loose)}.`);
    }
    for (const { el: l, path: p } of this.children(el, path, false)) {
      if (l.name === "language") read(l, p);
      else if (l.name === "languageset" && this.version === "ead3") {
        this.attrs(l, p, []);
        for (const { el: ll, path: lp } of this.children(l, p)) {
          if (ll.name === "language") read(ll, lp);
          else this.unknown(lp, ll, "languageset");
        }
      } else this.unknown(p, l, "langmaterial");
    }
  }

  private dao(el: XmlElement, path: Path, links: EadLink[]): void {
    if (!this.publicOnly(el, path)) return;
    const one = (d: XmlElement, p: Path): void => {
      if (!this.publicOnly(d, p)) return;
      let url: string | undefined;
      let label: string | undefined;
      if (this.version === "ead3") {
        const a = this.attrs(d, p, ["href", "linktitle"], ["daotype", "audience"]);
        url = a.get("href");
        label = a.get("linktitle");
      } else {
        const a = this.attrs(
          d,
          p,
          ["href", "xlink:href", "title", "xlink:title"],
          ["xlink:type", "linktype", "audience"],
        );
        url = a.get("xlink:href") ?? a.get("href");
        label = a.get("xlink:title") ?? a.get("title");
      }
      for (const { el: k, path: kp } of this.children(d, p)) this.unknown(kp, k, shown(d.name));
      if (url === undefined) {
        this.warn(
          p,
          "link_without_address",
          "The digital object has no address, so it was left out.",
        );
        return;
      }
      const problem = webUrlProblem(url);
      if (problem !== undefined || textProblem(url) !== undefined) {
        this.warn(
          p,
          "bad_url",
          `The digital object's address ${shown(url)} ${problem ?? "has bad characters"}, so it was left out.`,
        );
        return;
      }
      const link: { url: string; label?: string } = { url };
      if (label !== undefined) link.label = this.clean(label, p);
      links.push(link);
    };
    if (el.name === "dao") {
      one(el, path);
      return;
    }
    // daogrp (EAD 2002) or daoset (EAD3): read each link in it.
    this.attrs(el, path, [], ["xlink:type", "audience"]);
    this.skip(
      path,
      "structure_flattened",
      `The links in ${shown(el.name)} were kept as separate links.`,
    );
    for (const { el: d, path: p } of this.children(el, path)) {
      if (
        (el.name === "daogrp" && d.name === "daoloc") ||
        (el.name === "daoset" && d.name === "dao")
      )
        one(d, p);
      else this.unknown(p, d, shown(el.name));
    }
  }

  private note(el: XmlElement, path: Path, kind: EadNoteKind): EadNote | undefined {
    const internal = this.internal(el);
    const inside = internal || this.staffOnly > 0;
    this.attrs(el, path, [], ["audience"]);
    let head: string | undefined;
    const paragraphs: string[] = [];
    const walk = (node: XmlElement, p0: Path, nested: boolean): void => {
      for (const { el: k, path: p } of this.children(node, p0)) {
        // Staff-only parts of a public note can't be marked, so they're left out.
        if (!inside && !this.publicOnly(k, p)) continue;
        if (k.name === "head") {
          this.attrs(k, p, [], ["audience"]);
          const text = this.textOf(k, p);
          if (text === undefined) continue;
          if (!nested && head === undefined && paragraphs.length === 0) head = text;
          else {
            paragraphs.push(text);
            this.skip(
              p,
              "structure_flattened",
              "A heading inside the note was kept as a paragraph.",
            );
          }
        } else if (k.name === "p") {
          this.attrs(k, p, [], ["audience"]);
          const text = this.textOf(k, p);
          if (text !== undefined) paragraphs.push(text);
        } else if (
          k.name === "list" ||
          k.name === "chronlist" ||
          k.name === "blockquote" ||
          k.name === kind
        ) {
          this.attrs(k, p, [], ["audience", "type", "listtype", "numeration", "mark"]);
          this.skip(p, "structure_flattened", `The ${shown(k.name)} was kept as paragraphs.`);
          if (k.name === "list") this.listItems(k, p, paragraphs);
          else if (k.name === "chronlist") this.chronItems(k, p, paragraphs);
          else walk(k, p, true);
        } else this.unknown(p, k, shown(kind));
      }
    };
    walk(el, path, false);
    if (paragraphs.length === 0) {
      if (head !== undefined)
        this.skip(
          path,
          "unmapped_element",
          `The ${shown(kind)} has only a heading, so it isn't kept.`,
        );
      return undefined;
    }
    return head === undefined
      ? { kind, paragraphs, internal }
      : { kind, head, paragraphs, internal };
  }

  private listItems(list: XmlElement, path: Path, out: string[]): void {
    for (const { el: k, path: p } of this.children(list, path)) {
      if (k.name === "head" || k.name === "item" || k.name === "listhead") {
        const text = this.textOf(k, p);
        if (text !== undefined) out.push(text);
      } else if (k.name === "defitem") {
        const parts: string[] = [];
        for (const { el: d, path: dp } of this.children(k, p)) {
          const text = this.textOf(d, dp);
          if (text !== undefined) parts.push(text);
        }
        if (parts.length > 0) out.push(parts.join(": "));
      } else this.unknown(p, k, "list");
    }
  }

  private chronItems(list: XmlElement, path: Path, out: string[]): void {
    for (const { el: k, path: p } of this.children(list, path)) {
      if (k.name === "head") {
        const text = this.textOf(k, p);
        if (text !== undefined) out.push(text);
      } else if (k.name === "chronitem" || k.name === "listhead") {
        const parts: string[] = [];
        for (const { el: d, path: dp } of this.children(k, p)) {
          if (d.name === "eventgrp" || d.name === "chronitemset") {
            for (const { el: e, path: ep } of this.children(d, dp)) {
              const text = this.textOf(e, ep);
              if (text !== undefined) parts.push(text);
            }
          } else {
            const text = this.textOf(d, dp);
            if (text !== undefined) parts.push(text);
          }
        }
        if (parts.length > 0)
          out.push(
            parts.length > 1 ? `${parts[0] ?? ""}: ${parts.slice(1).join("; ")}` : (parts[0] ?? ""),
          );
      } else this.unknown(p, k, "chronlist");
    }
  }

  private controlaccess(el: XmlElement, path: Path, out: EadAccessPoint[]): void {
    if (!this.publicOnly(el, path)) return;
    this.attrs(el, path, [], ["audience"]);
    const v3 = this.version === "ead3";
    for (const { el: k, path: p } of this.children(el, path)) {
      if (k.name === "controlaccess") {
        this.controlaccess(k, p, out);
      } else if (ACCESS_ELEMENTS.has(k.name)) {
        if (!this.publicOnly(k, p)) continue;
        const a = this.attrs(k, p, [v3 ? "identifier" : "authfilenumber", "source"], ["audience"]);
        const label = this.termText(k, p);
        if (label === undefined) continue;
        const term: {
          element: EadAccessElement;
          label: string;
          identifier?: string;
          source?: string;
        } = {
          element: k.name as EadAccessElement,
          label,
        };
        const identifier = a.get(v3 ? "identifier" : "authfilenumber");
        if (identifier !== undefined) term.identifier = identifier;
        const source = a.get("source");
        if (source !== undefined) term.source = source;
        out.push(term);
      } else this.unknown(p, k, "controlaccess");
    }
  }
}

function refuse(code: string, message: string): Validated<EadRead> {
  return { ok: false, issues: [issue([], code, message)] };
}

/** Which EAD a root element is, or why it can't be read. */
function versionOf(
  root: XmlElement,
): { version: EadVersion; ns: string } | { code: string; message: string } {
  if (root.name !== "ead") {
    return {
      code: "not_ead",
      message: `This isn't an EAD file: its root element is ${shown(root.name)}, not "ead".`,
    };
  }
  if (root.ns === EAD2002_NAMESPACE) return { version: "ead2002", ns: root.ns };
  if (root.ns === EAD3_NAMESPACE) return { version: "ead3", ns: root.ns };
  if (root.ns === "") {
    const hasControl = root.children.some((c) => typeof c !== "string" && c.name === "control");
    if (hasControl) {
      return {
        code: "ead3_without_namespace",
        message: `This looks like EAD3 without its namespace. Add xmlns="${EAD3_NAMESPACE}" to the ead element and try again.`,
      };
    }
    return { version: "ead2002", ns: "" };
  }
  const later = /ead(\d+)|archivists\.org\/schema/i.exec(root.ns);
  if (later !== null) {
    return {
      code: "unsupported_version",
      message: `This file is in a version of EAD that Oculus can't read yet (namespace ${shown(root.ns, 100)}). Oculus reads EAD 2002 and EAD3 1.x.`,
    };
  }
  return {
    code: "not_ead",
    message: `This isn't an EAD file: its namespace is ${shown(root.ns, 100)}.`,
  };
}

/**
 * Read an EAD file (text or bytes) into the finding-aid model with a report
 * of everything not mapped. Refuses what isn't safe XML, isn't EAD, or is a
 * version Oculus doesn't know. Never throws.
 */
export function readEad(input: string | Uint8Array): Validated<EadRead> {
  const parsed = parseXml(input);
  if (!parsed.ok) return parsed;
  const root = parsed.value;
  const found = versionOf(root);
  if ("code" in found) return refuse(found.code, found.message);
  const r = new Reader(found.version, found.ns);

  try {
    r.attrs(root, "/ead", [], ["xsi:schemaLocation", "audience"]);
    let headerEl: XmlElement | undefined;
    let headerPath = "/ead/eadheader[1]";
    let archdesc: { el: XmlElement; path: Path } | undefined;
    const headerName = found.version === "ead3" ? "control" : "eadheader";
    for (const child of r.children(root, "/ead")) {
      if (child.el.name === headerName && headerEl === undefined) {
        headerEl = child.el;
        headerPath = child.path;
      } else if (child.el.name === "archdesc" && archdesc === undefined) {
        archdesc = child;
      } else r.unknown(child.path, child.el, "ead");
    }
    if (archdesc === undefined)
      return refuse("no_archdesc", "The file has no archdesc, so there is nothing to read.");
    const header = r.header(headerEl, headerPath);
    const unit = r.unit(archdesc.el, archdesc.path, 1, undefined);
    if (r.fatal !== undefined) return refuse(r.fatal.code, r.fatal.message);
    if (unit === undefined) return refuse("no_archdesc", "The archdesc couldn't be read.");
    return {
      ok: true,
      value: {
        findingAid: { header, archdesc: unit },
        report: {
          version: found.version,
          namespaced: found.ns !== "",
          unmapped: r.unmapped,
          warnings: r.warnings,
          levelChanges: r.levelChanges,
          omitted: r.omitted,
        },
      },
    };
  } catch (err) {
    // Deep recursion is bounded by MAX_XML_DEPTH; this is a last resort.
    return refuse(
      "unreadable",
      `The file couldn't be read: ${err instanceof Error ? err.message : "unknown error"}.`,
    );
  }
}
