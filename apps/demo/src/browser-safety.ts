import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2002::', 16], ['2001::', 23]] as const) blockedV6.addSubnet(address, prefix, 'ipv6');

export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blockedV4.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

// shortcut: DNS preflight is not connection pinning; use an enforcing egress proxy before browsing hostile sites in production.
export async function checkBrowserUrl(value: string, resolve = (host: string) => lookup(host, { all: true })) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Browser navigation requires a public HTTPS URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Private browser destinations are blocked');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Private browser destinations are blocked');
  return url.href;
}

export function browserEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name))) as Record<string, string>;
}
