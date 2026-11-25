// Sniffing an upload's media type from its bytes, and cleaning its name
// (M-002, D-086). Every sample is a handful of invented bytes.
import { describe, expect, it } from "vitest";
import {
  MAX_FILE_NAME_LENGTH,
  SNIFF_BYTES,
  cleanFileName,
  isClaimedMediaType,
  isSha256Hex,
  sniffMediaType,
} from "./files.js";

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === "string" ? Array.from(p, (c) => c.charCodeAt(0)) : p)),
  );

describe("sniffMediaType", () => {
  const cases: [string, Uint8Array, string][] = [
    ["JPEG", bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "JFIF"), "image/jpeg"],
    [
      "PNG",
      bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR"),
      "image/png",
    ],
    ["GIF87a", bytes("GIF87a", [1, 0]), "image/gif"],
    ["GIF89a", bytes("GIF89a", [1, 0]), "image/gif"],
    ["TIFF little-endian", bytes([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]), "image/tiff"],
    ["TIFF big-endian", bytes([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]), "image/tiff"],
    ["BigTIFF", bytes([0x49, 0x49, 0x2b, 0, 8, 0]), "image/tiff"],
    ["WebP", bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "), "image/webp"],
    ["WAV", bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "), "audio/wav"],
    ["AVI", bytes("RIFF", [0x24, 0, 0, 0], "AVI LIST"), "video/x-msvideo"],
    ["HEIC", bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0], "mif1heic"), "image/heic"],
    ["AVIF", bytes([0, 0, 0, 0x1c], "ftypavif", [0, 0, 0, 0]), "image/avif"],
    ["MP4", bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0]), "video/mp4"],
    ["QuickTime", bytes([0, 0, 0, 0x14], "ftypqt  ", [0, 0, 0, 0]), "video/quicktime"],
    ["M4A", bytes([0, 0, 0, 0x20], "ftypM4A ", [0, 0, 0, 0]), "audio/mp4"],
    [
      "JPEG 2000",
      bytes([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
      "image/jp2",
    ],
    ["PDF", bytes("%PDF-1.7\n%"), "application/pdf"],
    ["ZIP (and so DOCX)", bytes([0x50, 0x4b, 0x03, 0x04, 20, 0]), "application/zip"],
    ["gzip", bytes([0x1f, 0x8b, 8, 0]), "application/gzip"],
    [
      "OLE (old Office)",
      bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      "application/x-ole-storage",
    ],
    ["MP3 with ID3", bytes("ID3", [4, 0, 0]), "audio/mpeg"],
    ["MP3 frame", bytes([0xff, 0xfb, 0x90, 0x64]), "audio/mpeg"],
    ["FLAC", bytes("fLaC", [0, 0, 0, 0x22]), "audio/flac"],
    ["Ogg", bytes("OggS", [0, 2]), "application/ogg"],
    ["WebM", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), "video/webm"],
    ["Photoshop", bytes("8BPS", [0, 1]), "image/vnd.adobe.photoshop"],
    ["BMP", bytes("BM", [0x36, 0, 0, 0]), "image/bmp"],
    ["RTF", bytes("{\\rtf1\\ansi"), "application/rtf"],
    ["DjVu", bytes("AT&TFORM", [0, 0]), "image/vnd.djvu"],
    ["plain text", bytes("An invented ledger line.\r\n\tIndented.\n"), "text/plain"],
    ["UTF-8 text", new TextEncoder().encode("Café ledger — 1909\n"), "text/plain"],
    ["binary noise", bytes([0x00, 0x13, 0x77, 0x01, 0xfe]), "application/octet-stream"],
    ["empty", new Uint8Array(0), "application/octet-stream"],
  ];
  for (const [name, sample, type] of cases) {
    it(`names ${name}`, () => {
      expect(sniffMediaType(sample)).toBe(type);
    });
  }

  it("finds the active types the way a browser would, after white space and a BOM", () => {
    expect(sniffMediaType(bytes("<!DOCTYPE html><p>x"))).toBe("text/html");
    expect(sniffMediaType(bytes("  \n\t<HTML>"))).toBe("text/html");
    expect(sniffMediaType(bytes([0xef, 0xbb, 0xbf], "<script>alert(1)</script>"))).toBe(
      "text/html",
    );
    expect(sniffMediaType(bytes("<p>"))).toBe("text/html");
    expect(sniffMediaType(bytes("<b "))).toBe("text/html");
    expect(sniffMediaType(bytes("<!-- a comment --><x>"))).toBe("text/html");
    expect(sniffMediaType(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe("image/svg+xml");
    expect(sniffMediaType(bytes('<?xml version="1.0"?>\n<svg xmlns="x">'))).toBe("image/svg+xml");
    expect(sniffMediaType(bytes('<?xml version="1.0"?><html xmlns="x">'))).toBe("text/html");
    expect(sniffMediaType(bytes('<?xml version="1.0"?><ead/>'))).toBe("text/xml");
    // Not a tag: plain text.
    expect(sniffMediaType(bytes("<invented> is not HTML"))).toBe("text/plain");
    expect(sniffMediaType(bytes("<pre-amble"))).toBe("text/plain");
  });

  it("never trusts a lying extension in the content and looks at the head only", () => {
    // HTML claiming to be a JPEG by its first line is still HTML.
    expect(sniffMediaType(bytes("<html><!-- photo.jpg -->"))).toBe("text/html");
    // A JPEG signature past the sampled head doesn't count.
    const late = new Uint8Array(SNIFF_BYTES + 3).fill(0x41);
    late.set([0xff, 0xd8, 0xff], SNIFF_BYTES);
    expect(sniffMediaType(late)).toBe("text/plain");
    // A UTF-8 character cut at the end of the sample is still text.
    const cut = new TextEncoder().encode("a".repeat(SNIFF_BYTES - 1) + "é");
    expect(sniffMediaType(cut)).toBe("text/plain");
  });
});

describe("cleanFileName", () => {
  it("keeps the last segment, in NFC, trimmed", () => {
    expect(cleanFileName("Ledger page 1.tif")).toBe("Ledger page 1.tif");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\Users\\invented\\scan.tif")).toBe("scan.tif");
    expect(cleanFileName("  spaced.png  ")).toBe("spaced.png");
    expect(cleanFileName("Cafe\u0301.jpg")).toBe("Café.jpg");
    expect(cleanFileName("%2e%2e%2f.png")).toBe("%2e%2e%2f.png");
    expect(cleanFileName("x".repeat(MAX_FILE_NAME_LENGTH))).toHaveLength(MAX_FILE_NAME_LENGTH);
  });

  it("refuses what can't be shown safely as a name", () => {
    for (const bad of [
      "",
      "   ",
      ".",
      "..",
      "...",
      "dir/",
      "dir/..",
      "line\nbreak.png",
      "tab\tname.png",
      "nul\u0000.png",
      "del\u007f.png",
      "c1\u0085.png",
      "invoice\u202efdp.exe",
      "isolate\u2066x\u2069.png",
      "mark\u200e.png",
      "bom\ufeff.png",
      "x".repeat(MAX_FILE_NAME_LENGTH + 1),
      42,
      null,
    ]) {
      expect(cleanFileName(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("checks", () => {
  it("recognises a SHA-256 and a claimed media type", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
    expect(isClaimedMediaType("image/jpeg")).toBe(true);
    expect(isClaimedMediaType("application/vnd.oasis.opendocument.text")).toBe(true);
    expect(isClaimedMediaType("Image/JPEG")).toBe(false);
    expect(isClaimedMediaType("image/jpeg; q=1")).toBe(false);
    expect(isClaimedMediaType("jpeg")).toBe(false);
  });
});
