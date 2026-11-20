// License check for the gate (D-002): every installed dependency must use a
// permissive license. Copyleft (GPL, AGPL, LGPL, MPL, EPL, ...) and missing
// licenses fail. SPDX "OR" expressions pass if any choice is allowed; "AND"
// expressions need every part allowed.
import { execFileSync } from "node:child_process";
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
  console.log(`License check passed: ${packages.length} packages, all permissive.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
