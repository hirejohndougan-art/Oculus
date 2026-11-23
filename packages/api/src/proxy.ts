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
 * ::1), so a typo can't trust a large part of the internet. Anything else,
 * including `true`, `*` and hop counts, stops the server from starting rather
 * than trusting too much.
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

function isAddressOrRange(entry: string): boolean {
  if (entry === "loopback") return true;
  const slash = entry.indexOf("/");
  if (slash === -1) return isIP(entry) !== 0;
  const address = entry.slice(0, slash);
  const prefix = entry.slice(slash + 1);
  const family = isIP(address);
  if (family === 0 || !/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  if (bits > (family === 4 ? 32 : 128)) return false;
  if (bits >= (family === 4 ? 16 : 32)) return true;
  return insidePrivateBlock(address, bits, family === 4 ? "ipv4" : "ipv6");
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
        `${TRUSTED_PROXY_ENV} must list IP addresses, CIDR ranges (no wider than /16 or /32 outside private blocks) or "loopback", separated by commas; ` +
          `refusing ${JSON.stringify(entry)}`,
      );
    }
  }
  return entries;
}
