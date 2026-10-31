import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { badRequest } from '../errors.js';

/** Address ranges a webhook may never reach (private, loopback, link-local, metadata, reserved). */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** `::ffff:a.b.c.d` -> `a.b.c.d` */
function unmapIpv4(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}

export function isBlockedAddress(ip: string, opts: { allowLoopback?: boolean } = {}): boolean {
  const addr = unmapIpv4(ip);
  const family = isIP(addr);
  if (family === 0) return true;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (opts.allowLoopback && loopback.check(addr, type)) return false;
  return blocked.check(addr, type);
}

export interface UrlPolicy {
  /** Development only: allow http:// and loopback targets (local receivers). */
  allowInsecure: boolean;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const invalid = (reason: string) => badRequest('INVALID_WEBHOOK_URL', 'Webhook URL is not allowed', { reason });

/** Syntactic checks (no network). */
export function parseWebhookUrl(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('not a URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowInsecure && url.protocol === 'http:')) {
    throw invalid('must use https');
  }
  if (url.username || url.password) throw invalid('credentials in URL are not allowed');
  if (!url.hostname) throw invalid('missing host');
  if (raw.length > 2048) throw invalid('URL too long');
  return url;
}

/**
 * Resolves the host and checks every resolved address. Returns the address to
 * connect to, so the connection is pinned to what was checked (no DNS
 * rebinding between check and connect).
 */
export async function resolveSafeTarget(
  url: URL,
  policy: UrlPolicy,
  resolver: Resolver = systemResolver,
): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const opts = { allowLoopback: policy.allowInsecure };
  let addrs: { address: string; family: number }[];
  if (isIP(host)) {
    addrs = [{ address: host, family: isIP(host) }];
  } else {
    if (host === 'localhost' && !policy.allowInsecure) throw invalid('host resolves to a private address');
    try {
      addrs = await resolver(host);
    } catch {
      throw invalid('host does not resolve');
    }
  }
  if (addrs.length === 0) throw invalid('host does not resolve');
  for (const a of addrs) {
    if (isBlockedAddress(a.address, opts)) throw invalid('host resolves to a private address');
  }
  const first = addrs[0] as { address: string; family: number };
  return { address: unmapIpv4(first.address), family: isIP(unmapIpv4(first.address)) === 6 ? 6 : 4 };
}

export async function assertSafeWebhookUrl(raw: string, policy: UrlPolicy, resolver?: Resolver): Promise<URL> {
  const url = parseWebhookUrl(raw, policy);
  await resolveSafeTarget(url, policy, resolver);
  return url;
}
