// Invented finding aids for the EAD tests. No real people or records.
import { MAX_ARRANGEMENT_DEPTH } from "./arrangement.js";
import {
  EAD_ACCESS_ELEMENTS,
  EAD_NAME_ELEMENTS,
  EAD_NOTE_KINDS,
  type EadUnit,
  type FindingAid,
} from "./ead-model.js";

/** EAD 2002 with its namespace, the way TARO-style tools write it. */
export const EAD2002_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ead xmlns="urn:isbn:1-931666-22-9" xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="urn:isbn:1-931666-22-9 http://www.loc.gov/ead/ead.xsd">
  <eadheader>
    <eadid countrycode="US" mainagencycode="US-XX">example-0001</eadid>
    <filedesc>
      <titlestmt>
        <titleproper>A Guide to the Example Family Papers</titleproper>
        <author>Processed by an invented archivist</author>
      </titlestmt>
      <publicationstmt><publisher>Example Historical Society</publisher></publicationstmt>
    </filedesc>
  </eadheader>
  <archdesc level="collection">
    <did>
      <unitid>MS-001</unitid>
      <unittitle>Example Family Papers, <unitdate normal="1890/1950" type="inclusive">1890-1950</unitdate></unittitle>
      <unitdate normal="1910/1920" type="bulk">bulk 1910-1920</unitdate>
      <physdesc><extent>2.5 linear feet</extent></physdesc>
      <physdesc><extent unit="boxes" type="carrier">3</extent></physdesc>
      <origination label="Creator">
        <famname source="local">Example family</famname>
      </origination>
      <langmaterial><language langcode="eng">English</language></langmaterial>
      <repository><corpname>Example Historical Society</corpname></repository>
      <abstract>Letters and photographs of an <emph render="italic">invented</emph> family.</abstract>
    </did>
    <bioghist>
      <head>Biographical Note</head>
      <p>The Example family farmed near an invented bayou.</p>
      <p>They kept   letters
         for sixty years.</p>
    </bioghist>
    <scopecontent><p>Correspondence, ledgers and photographs.</p></scopecontent>
    <accessrestrict><p>Open for research.</p></accessrestrict>
    <acqinfo audience="internal"><p>Gift of an invented donor, 1999.</p></acqinfo>
    <controlaccess>
      <subject source="lcsh" authfilenumber="http://id.loc.gov/authorities/subjects/sh00000000">Farm life</subject>
      <geogname source="lcnaf">Example County (Tex.)</geogname>
      <genreform source="aat">Photographs</genreform>
    </controlaccess>
    <dsc>
      <c01 level="series">
        <did><unittitle>Correspondence</unittitle><unitdate>1890-1950</unitdate></did>
        <c02 level="file">
          <did>
            <container type="Box">1</container>
            <container type="Folder">2</container>
            <unittitle>Letters to a cousin</unittitle>
            <unitdate normal="1901">1901</unitdate>
            <dao xlink:type="simple" xlink:href="https://example.org/objects/1" xlink:title="Scans"/>
          </did>
        </c02>
        <c02 level="item" audience="internal">
          <did><unittitle>Private letter</unittitle></did>
        </c02>
      </c01>
      <c01 level="subseries">
        <did><unittitle>Ledgers</unittitle><unitdate>circa 1900</unitdate></did>
      </c01>
    </dsc>
  </archdesc>
</ead>
`;

/** The same finding aid, as the model holds it. */
export const SAMPLE_MODEL: FindingAid = {
  header: {
    id: "example-0001",
    title: "A Guide to the Example Family Papers",
    author: "Processed by an invented archivist",
    publisher: "Example Historical Society",
    agencyCode: "US-XX",
    countryCode: "US",
    notes: [],
  },
  archdesc: {
    level: "collection",
    internal: false,
    identifiers: ["MS-001"],
    title: "Example Family Papers",
    dates: [
      { text: "1890-1950", normal: "1890/1950", type: "inclusive" },
      { text: "bulk 1910-1920", normal: "1910/1920", type: "bulk" },
    ],
    extents: [{ text: "2.5 linear feet" }, { quantity: "3", unit: "boxes", measure: "carrier" }],
    creators: [{ element: "famname", label: "Example family", source: "local" }],
    languages: [{ label: "English", code: "eng" }],
    repository: "Example Historical Society",
    containers: [],
    physicalLocations: [],
    abstracts: ["Letters and photographs of an invented family."],
    notes: [
      {
        kind: "bioghist",
        head: "Biographical Note",
        paragraphs: [
          "The Example family farmed near an invented bayou.",
          "They kept letters for sixty years.",
        ],
        internal: false,
      },
      {
        kind: "scopecontent",
        paragraphs: ["Correspondence, ledgers and photographs."],
        internal: false,
      },
      { kind: "accessrestrict", paragraphs: ["Open for research."], internal: false },
      { kind: "acqinfo", paragraphs: ["Gift of an invented donor, 1999."], internal: true },
    ],
    accessPoints: [
      {
        element: "subject",
        label: "Farm life",
        source: "lcsh",
        identifier: "http://id.loc.gov/authorities/subjects/sh00000000",
      },
      { element: "geogname", label: "Example County (Tex.)", source: "lcnaf" },
      { element: "genreform", label: "Photographs", source: "aat" },
    ],
    links: [],
    children: [
      {
        level: "series",
        internal: false,
        identifiers: [],
        title: "Correspondence",
        dates: [{ text: "1890-1950" }],
        extents: [],
        creators: [],
        languages: [],
        containers: [],
        physicalLocations: [],
        abstracts: [],
        notes: [],
        accessPoints: [],
        links: [],
        children: [
          {
            level: "file",
            internal: false,
            identifiers: [],
            title: "Letters to a cousin",
            dates: [{ text: "1901", normal: "1901" }],
            extents: [],
            creators: [],
            languages: [],
            containers: [
              { type: "Box", value: "1" },
              { type: "Folder", value: "2" },
            ],
            physicalLocations: [],
            abstracts: [],
            notes: [],
            accessPoints: [],
            links: [{ url: "https://example.org/objects/1", label: "Scans" }],
            children: [],
          },
          {
            level: "item",
            internal: true,
            identifiers: [],
            title: "Private letter",
            dates: [],
            extents: [],
            creators: [],
            languages: [],
            containers: [],
            physicalLocations: [],
            abstracts: [],
            notes: [],
            accessPoints: [],
            links: [],
            children: [],
          },
        ],
      },
      {
        level: "series",
        internal: false,
        identifiers: [],
        title: "Ledgers",
        dates: [{ text: "circa 1900" }],
        extents: [],
        creators: [],
        languages: [],
        containers: [],
        physicalLocations: [],
        abstracts: [],
        notes: [],
        accessPoints: [],
        links: [],
        children: [],
      },
    ],
  },
};

/** EAD 2002 from the DTD era: no namespace, a DOCTYPE naming the DTD, plain href. */
export const EAD2002_DTD_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ead PUBLIC "+//ISBN 1-931666-00-8//DTD ead.dtd (Encoded Archival Description (EAD) Version 2002)//EN" "ead.dtd">
<ead>
  <eadheader>
    <eadid>dtd-0002</eadid>
    <filedesc><titlestmt><titleproper>Invented Church Records</titleproper></titlestmt></filedesc>
  </eadheader>
  <archdesc level="recordgrp">
    <did>
      <unittitle>Invented Church Records</unittitle>
      <unitdate normal="19200101/19301231">1920-1930</unitdate>
      <physdesc>4 boxes</physdesc>
      <dao href="http://example.org/church" title="Church scans"/>
    </did>
    <dsc type="combined">
      <c level="otherlevel" otherlevel="Item">
        <did><unittitle>Minutes</unittitle></did>
      </c>
      <c level="otherlevel" otherlevel="Binder">
        <did><unittitle>Bulletins</unittitle></did>
      </c>
    </dsc>
  </archdesc>
</ead>
`;

/** EAD3 1.1 with parts, structured extents, structured dates and a daoset. */
export const EAD3_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ead xmlns="http://ead3.archivists.org/schema/">
  <control>
    <recordid>ead3-0003</recordid>
    <filedesc>
      <titlestmt><titleproper>Invented Lumber Company Records</titleproper></titlestmt>
      <publicationstmt><publisher>Example Archive</publisher></publicationstmt>
    </filedesc>
    <maintenancestatus value="new"/>
    <maintenanceagency countrycode="US"><agencycode>US-YY</agencycode><agencyname>Example Archive</agencyname></maintenanceagency>
    <maintenancehistory>
      <maintenanceevent>
        <eventtype value="created"/>
        <eventdatetime>2020-01-01</eventdatetime>
        <agenttype value="human"/>
        <agent>Invented cataloger</agent>
      </maintenanceevent>
    </maintenancehistory>
  </control>
  <archdesc level="fonds">
    <did>
      <unitid>LC-01</unitid>
      <unittitle>Invented Lumber Company Records</unittitle>
      <unitdatestructured unitdatetype="inclusive">
        <daterange><fromdate standarddate="1905">1905</fromdate><todate standarddate="1931">1931</todate></daterange>
      </unitdatestructured>
      <physdescstructured coverage="whole" physdescstructuredtype="spaceoccupied">
        <quantity>12</quantity><unittype>linear feet</unittype>
      </physdescstructured>
      <origination><corpname identifier="http://id.loc.gov/authorities/names/n00000000" source="lcnaf" relator="creator"><part>Invented Lumber Company</part></corpname></origination>
      <langmaterial><language langcode="eng">English</language></langmaterial>
    </did>
    <scopecontent>
      <p>Payroll and <ref target="x1">mill</ref> records.</p>
      <list><item>Payroll</item><item>Deeds</item></list>
    </scopecontent>
    <controlaccess><persname source="local"><part>Doe, Jane</part><part>1880-1950</part></persname></controlaccess>
    <dsc>
      <c level="subgrp">
        <did>
          <unittitle>Mill</unittitle>
          <daoset><dao daotype="derived" href="https://example.org/a" linktitle="A"/><dao daotype="derived" href="javascript:alert(1)"/></daoset>
        </did>
        <odd><p>Some <persname audience="internal"><part>Secret Name</part></persname> notes.</p></odd>
        <processinfo><p>Processed by staff.</p></processinfo>
        <c level="file"><did><unittitle>Ledger</unittitle><unitdate unitdatetype="bulk" normal="1910/1911">1910-1911</unitdate></did></c>
      </c>
    </dsc>
  </archdesc>
</ead>
`;

function leaf(title: string, level: EadUnit["level"] = "item"): EadUnit {
  return {
    level,
    internal: false,
    identifiers: [],
    title,
    dates: [],
    extents: [],
    creators: [],
    languages: [],
    containers: [],
    physicalLocations: [],
    abstracts: [],
    notes: [],
    accessPoints: [],
    links: [],
    children: [],
  };
}

/** A collection with a date and no title. */
function untitled(): EadUnit {
  const unit: { -readonly [K in keyof EadUnit]?: EadUnit[K] } = { ...leaf("", "collection") };
  delete unit.title;
  return { ...(unit as EadUnit), dates: [{ text: "1901" }] };
}

/** A chain of `depth` units, each a file inside the one above. */
function chain(depth: number): EadUnit {
  let unit = leaf(`Level ${String(depth)}`, "file");
  for (let d = depth - 1; d >= 1; d -= 1)
    unit = { ...leaf(`Level ${String(d)}`, "file"), children: [unit] };
  return unit;
}

/** Every mapped element and attribute, with awkward text. */
export const FULL_MODEL: FindingAid = {
  header: {
    id: "full-0001",
    title: "Everything & more <tested>",
    subtitle: 'An "invented" guide',
    author: "Invented author",
    publisher: "Invented Society",
    agencyCode: "US-ZZ",
    countryCode: "US",
    notes: ["Includes staff-only fields.", "Second note."],
  },
  archdesc: {
    level: "fonds",
    internal: false,
    identifiers: ["F-1", "Legacy 77"],
    title: "Full fonds",
    dates: [
      { text: "1900-1950", normal: "1900/1950", type: "inclusive" },
      { text: "1920-1925", normal: "1920/1925", type: "bulk" },
      { text: "undated" },
    ],
    extents: [
      { text: "3 linear feet" },
      { quantity: "2.5", unit: "cubic feet" },
      { quantity: "4", unit: "boxes", measure: "carrier" },
      { quantity: "100", unit: "photographs", measure: "materialtype" },
    ],
    creators: EAD_NAME_ELEMENTS.map((element, i) => ({
      element,
      label: `Creator ${String(i)}`,
      identifier: `http://id.loc.gov/authorities/names/n0000000${String(i)}`,
      source: "lcnaf",
      role: "creator",
    })),
    languages: [{ label: "English", code: "eng" }, { label: "Czech" }],
    repository: "Invented Society",
    containers: [{ type: "Box", value: "1" }, { value: "loose" }],
    physicalLocations: ["Room 2"],
    abstracts: ["An abstract with a < and a >."],
    notes: EAD_NOTE_KINDS.map((kind, i) => ({
      kind,
      paragraphs: [`Paragraph of ${kind}.`, "Another & last."],
      internal: i % 3 === 0,
      ...(i % 2 === 0 ? { head: `Head of ${kind}` } : {}),
    })),
    accessPoints: EAD_ACCESS_ELEMENTS.map((element, i) => ({
      element,
      label: `Term ${String(i)}`,
      ...(i % 2 === 0
        ? { identifier: `http://example.org/terms/${String(i)}`, source: "local" }
        : {}),
    })),
    links: [
      { url: "https://example.org/a?x=1&y=2", label: "A & B" },
      { url: "http://example.org/b" },
    ],
    children: [
      { ...leaf("A series", "series"), internal: true, children: [leaf("Item in series")] },
      untitled(),
      chain(MAX_ARRANGEMENT_DEPTH - 1),
    ],
  },
};
