// License check for the gate (D-002): every installed dependency must use a
// permissive license. Copyleft (GPL, AGPL, LGPL, MPL, EPL, ...) and missing
// licenses fail. SPDX "OR" expressions pass if any choice is allowed; "AND"
// expressions need every part allowed.
//
// Font files (D-073) are checked apart: Roboto and Open Sans are under the
// SIL Open Font License 1.1, which is allowed for font files only, never for
// code or npm dependencies. Every font file in the repository must be listed,
// with its SHA-256 and license, in a `FONTS.json` beside it, and that
// license's text must be there too (`checkFonts`).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Unlicense",
  "Python-2.0",
  "Zlib",
]);

/**
 * True if an SPDX license expression is allowed. Fails closed: anything it
 * can't parse (including `WITH` exceptions and unknown IDs) is not allowed.
 * Precedence follows the SPDX spec: AND binds tighter than OR.
 */
export function isAllowed(expression) {
  if (typeof expression !== "string") return false;
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  // or := and ("OR" and)* ; and := atom ("AND" atom)* ; atom := ID | "(" or ")"
  const parseOr = () => {
    let value = parseAnd();
    while (peek()?.toUpperCase() === "OR") {
      pos++;
      const rhs = parseAnd();
      value = value || rhs;
    }
    return value;
  };
  const parseAnd = () => {
    let value = parseAtom();
    while (peek()?.toUpperCase() === "AND") {
      pos++;
      const rhs = parseAtom();
      value = value && rhs;
    }
    return value;
  };
  const parseAtom = () => {
    const token = tokens[pos++];
    if (token === undefined) throw new Error("unexpected end");
    if (token === "(") {
      const value = parseOr();
      if (tokens[pos++] !== ")") throw new Error("missing )");
      return value;
    }
    if (token === ")" || /^(AND|OR|WITH)$/i.test(token)) throw new Error("unexpected " + token);
    return ALLOWED.has(token);
  };
  try {
    if (tokens.length === 0) return false;
    const value = parseOr();
    return pos === tokens.length && value;
  } catch {
    return false;
  }
}

/** Licenses allowed for font files only (D-073), beside everything in ALLOWED. */
export const FONT_ONLY_LICENSES = new Set(["OFL-1.1"]);
export const FONT_EXTENSIONS = /\.(woff2?|ttf|otf|eot)$/i;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".gate", "coverage"]);

/** Every font file under `root`, skipping dependencies, builds and git's own files. */
export function findFontFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(dir, entry.name));
      } else if (FONT_EXTENSIONS.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Problems with the font files under `root`, as lines of text (none when all
 * is well): each must be listed in `FONTS.json` beside it with the file's
 * SHA-256, an allowed license (OFL-1.1 or anything in ALLOWED) and a license
 * file that exists in the same folder.
 */
export function checkFonts(root) {
  const problems = [];
  const manifests = new Map();
  const manifestOf = (dir) => {
    if (!manifests.has(dir)) {
      const file = join(dir, "FONTS.json");
      let value = null;
      if (existsSync(file)) {
        try {
          value = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          value = "unreadable";
        }
      }
      manifests.set(dir, value);
    }
    return manifests.get(dir);
  };
  for (const file of findFontFiles(root)) {
    const name = relative(root, file);
    const manifest = manifestOf(dirname(file));
    if (manifest === "unreadable") {
      problems.push(`${name}: FONTS.json beside it can't be read`);
      continue;
    }
    const entry = manifest?.files?.[basename(file)];
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${name}: not listed in a FONTS.json beside it`);
      continue;
    }
    const license = entry.license;
    if (!(FONT_ONLY_LICENSES.has(license) || isAllowed(license))) {
      problems.push(`${name}: license ${String(license)} is not allowed for fonts`);
    }
    const licenseFile = entry.licenseFile;
    if (
      typeof licenseFile !== "string" ||
      licenseFile.includes("/") ||
      licenseFile.includes("\\") ||
      !existsSync(join(dirname(file), licenseFile))
    ) {
      problems.push(`${name}: its license text (licenseFile) is missing`);
    }
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (entry.sha256 !== sha256) problems.push(`${name}: SHA-256 differs from FONTS.json`);
  }
  return problems;
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).join(" OR ");
  }
  return "";
}

function main() {
  const out = execFileSync("npm", ["query", "*:not(.workspace)"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const packages = JSON.parse(out);
  const bad = [];
  for (const pkg of packages) {
    if (pkg.name === "oculus" && pkg.path === process.cwd()) continue;
    const license = licenseOf(pkg);
    if (!isAllowed(license)) bad.push(`${pkg.name}@${pkg.version}: ${license || "(none)"}`);
  }
  if (bad.length > 0) {
    console.error("License check failed. Not allowed by D-002:");
    for (const line of bad) console.error(`  ${line}`);
    process.exit(1);
  }
  const fonts = checkFonts(process.cwd());
  if (fonts.length > 0) {
    console.error("License check failed for font files (D-073):");
    for (const line of fonts) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`License check passed: ${packages.length} packages, all permissive.`);
  console.log(
    `Font files: ${findFontFiles(process.cwd()).length}, each listed with an allowed license.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
