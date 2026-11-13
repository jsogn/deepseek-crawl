import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type AddressLookup = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

function ipv6Groups(address: string): number[] | undefined {
  if (address.includes("%")) {
    return undefined;
  }

  let value = address.toLowerCase();
  const lastColon = value.lastIndexOf(":");
  if (value.includes(".") && lastColon >= 0) {
    const ipv4 = value.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) {
      return undefined;
    }
    const octets = ipv4.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    value = `${value.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return undefined;
  }
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : undefined;
}

function mappedIpv4Address(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (!groups || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) {
    return undefined;
  }
  return ipv4FromFinalGroups(groups);
}

function nat64Ipv4Address(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (groups?.[0] !== 0x0064) {
    return undefined;
  }
  if (groups[1] !== 0xff9b || groups.slice(2, 6).some((group) => group !== 0)) {
    return undefined;
  }
  return ipv4FromFinalGroups(groups);
}

function ipv4FromFinalGroups(groups: number[]): string {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function stripIpv6Brackets(hostname: string): string {
  const value = hostname.trim();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address);
  const version = isIP(normalized);
  if (version === 4) {
    return !blockedIpv4.check(normalized, "ipv4");
  }
  if (version !== 6) {
    return false;
  }

  const mapped = mappedIpv4Address(normalized);
  if (mapped) {
    return isPublicIpAddress(mapped);
  }
  const nat64 = nat64Ipv4Address(normalized);
  if (nat64) {
    return isPublicIpAddress(nat64);
  }
  return !blockedIpv6.check(normalized, "ipv6");
}

const defaultLookup: AddressLookup = async (hostname, signal) => {
  signal?.throwIfAborted();
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  signal?.throwIfAborted();
  return addresses;
};

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function resolvePublicAddress(
  hostname: string,
  lookupImpl: AddressLookup = defaultLookup,
  signal?: AbortSignal,
): Promise<ResolvedAddress> {
  signal?.throwIfAborted();
  const normalizedHostname = stripIpv6Brackets(hostname);
  const literalFamily = isIP(normalizedHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!isPublicIpAddress(normalizedHostname)) {
      throw new Error(`Refusing non-public Sitemap address for ${normalizedHostname}.`);
    }
    return { address: normalizedHostname, family: literalFamily };
  }

  let addresses: ReadonlyArray<{ address: string; family: number }>;
  try {
    addresses = await waitForAbort(
      Promise.resolve().then(() => lookupImpl(normalizedHostname, signal)),
      signal,
    );
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    throw new Error(`Could not resolve Sitemap host ${normalizedHostname}.`, { cause: error });
  }

  if (addresses.length === 0) {
    throw new Error(`Sitemap host ${normalizedHostname} did not resolve to an address.`);
  }

  for (const result of addresses) {
    if (!isPublicIpAddress(result.address)) {
      throw new Error(`Refusing non-public Sitemap address for ${normalizedHostname}.`);
    }
  }

  const first = addresses[0];
  if (!first) {
    throw new Error(`Sitemap host ${normalizedHostname} did not resolve to an address.`);
  }
  const family = isIP(first.address);
  if (family !== 4 && family !== 6) {
    throw new Error(`Sitemap host ${normalizedHostname} returned an invalid IP address.`);
  }
  return { address: first.address, family };
}
