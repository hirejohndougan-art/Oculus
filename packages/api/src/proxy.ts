/**
 * `trustProxy` only when an environment variable names the proxy (D-051).
 *
 * Fastify reads `X-Forwarded-For`, `-Host` and `-Proto` only from a trusted
 * proxy. Trusting any sender lets a client choose its own address (defeating
 * sign-in throttling, D-052) and its own host and scheme (defeating the
 * Origin check). So `trustProxy` stays off unless `OCULUS_TRUSTED_PROXY`
 * lists the proxy's addresses: IPv4 or IPv6 addresses, CIDR ranges, or the
 * word `loopback` (a proxy on the same machine), separated by commas.
 * A range may be no wider than /16 (IPv4) or /32 (IPv6) unless it lies inside
 * a private or loopback block (10/8, 172.16/12, 192.168/16, 127/8, fc00::/7,
 * ::1), so a typo can't trust a large part of the internet. IPv6 blocks that
 * carry IPv4 addresses (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96,
 * NAT64 64:ff9b::/96 and 6to4 2002::/16) get the IPv4 rule for the IPv4
 * range inside them, and a range wider than such a block is refused, so
 * `::ffff:0:0/96` can't trust every IPv4 address. Zone ids (`fe80::1%eth0`)
 * are refused. Anything else, including `true`, `*` and hop counts, stops
 * the server from starting rather than trusting too much.
 */
import { BlockList, isIP } from "node:net";

const PRIVATE_BLOCKS: readonly (readonly [string, number, "ipv4" | "ipv6"])[] = [
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["fc00::", 7, "ipv6"],
  ["::1", 128, "ipv6"],
];

/** True when `address/bits` lies inside one private or loopback block. */
function insidePrivateBlock(address: string, bits: number, family: "ipv4" | "ipv6"): boolean {
  return PRIVATE_BLOCKS.some(([base, prefix, blockFamily]) => {
    if (blockFamily !== family || bits < prefix) return false;
    const block = new BlockList();
    block.addSubnet(base, prefix, family);
    return block.check(address, family);
  });
}

export const TRUSTED_PROXY_ENV = "OCULUS_TRUSTED_PROXY";

/**
 * IPv6 blocks with an IPv4 address inside: the block, its prefix length, and
 * the byte where the IPv4 address starts.
 */
const IPV4_CARRYING_BLOCKS: readonly (readonly [string, number, number])[] = [
  ["::ffff:0:0", 96, 12],
  ["::", 96, 12],
  ["64:ff9b::", 96, 12],
  ["2002::", 16, 2],
];

/** The 16 bytes of an IPv6 address Node's `isIP` accepts (no zone id). */
function ipv6Bytes(address: string): number[] {
  let text = address;
  const tail: number[] = [];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    tail.push(...dotted.slice(1, 5).map(Number));
    text = text.slice(0, dotted.index) + "0:0";
  }
  const [head = "", rest] = text.split("::");
  const groups = (part: string | undefined): string[] =>
    part === undefined || part === "" ? [] : part.split(":");
  const left = groups(head);
  const right = groups(rest);
  const middle = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  const bytes = [...left, ...middle, ...right].flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inBlock(address: string, base: string, bits: number): boolean {
  const block = new BlockList();
  block.addSubnet(base, bits, "ipv6");
  return block.check(address, "ipv6");
}

/** The IPv4 rule for an IPv4 range. */
function ipv4RangeAllowed(address: string, bits: number): boolean {
  return bits >= 16 || insidePrivateBlock(address, bits, "ipv4");
}

/**
 * For an IPv6 range touching a block that carries IPv4 addresses: whether
 * it is allowed (the IPv4 rule on the range inside, or refused when the range
 * is wider than the block). `undefined` when it touches no such block.
 */
function ipv4CarryingRangeAllowed(address: string, bits: number): boolean | undefined {
  for (const [base, blockBits, offset] of IPV4_CARRYING_BLOCKS) {
    if (bits < blockBits) {
      // Wider than the block: refused if it holds the block.
      if (inBlock(base, address, bits)) return false;
      continue;
    }
    if (!inBlock(address, base, blockBits)) continue;
    const v4 = ipv6Bytes(address)
      .slice(offset, offset + 4)
      .join(".");
    return ipv4RangeAllowed(v4, Math.min(32, bits - blockBits));
  }
  return undefined;
}

function isAddressOrRange(entry: string): boolean {
  if (entry === "loopback") return true;
  if (entry.includes("%")) return false; // zone ids
  const slash = entry.indexOf("/");
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const prefix = slash === -1 ? undefined : entry.slice(slash + 1);
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return false;
  const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
  if (bits > (family === 4 ? 32 : 128)) return false;
  if (family === 4) return ipv4RangeAllowed(address, bits);
  const carried = ipv4CarryingRangeAllowed(address, bits);
  if (carried !== undefined) return carried;
  return bits >= 32 || insidePrivateBlock(address, bits, "ipv6");
}

/**
 * The `trustProxy` setting from the environment: `false` when the variable is
 * unset or empty, otherwise the checked list of addresses and ranges.
 * Throws when any entry isn't an address, a range or `loopback`.
 */
export function trustedProxyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): false | string[] {
  const raw = env[TRUSTED_PROXY_ENV];
  if (raw === undefined || raw.trim() === "") return false;
  const entries = raw.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    if (!isAddressOrRange(entry)) {
      throw new Error(
        `${TRUSTED_PROXY_ENV} must list IP addresses without zone ids, CIDR ranges (no wider than /16 or /32 outside private blocks, IPv4 limits inside IPv4-carrying IPv6 blocks) or "loopback", separated by commas; ` +
          `refusing ${JSON.stringify(entry)}`,
      );
    }
  }
  return entries;
}
