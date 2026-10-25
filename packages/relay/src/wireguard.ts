import { createHash } from 'node:crypto';
import { mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';

const TMPFS_MAGIC = 0x01021994;
const DEFAULT_RUNTIME_DIRECTORY = '/dev/shm';

export interface WireGuardPeer {
  /** Standard base64 WireGuard public key. The corresponding private key stays with the peer. */
  publicKey: string;
  /** One unique IPv4 tunnel address, for example 10.77.0.2/32. */
  allowedAddress: string;
}

export interface WireGuardGatewayOptions {
  /** Public DNS name or IPv4 endpoint that clients use. */
  endpoint: string;
  /** UDP port opened on the relay VM. */
  listenPort: number;
  /** Server interface address and subnet, for example 10.77.0.1/24. */
  interfaceAddress: string;
  /** Host interface used for Internet egress/NAT, for example ens4. */
  egressInterface: string;
  /** Pre-authorized peer public keys and tunnel addresses. Must be non-empty. */
  peers: WireGuardPeer[];
  /** Defaults to /dev/shm, which must be tmpfs. A private subdirectory is created there. */
  runtimeDirectory?: string;
  /** Test seam. Production uses the system `wg` and `wg-quick` commands. */
  runCommand?: (command: string, args: string[], input?: string) => Promise<string>;
  /** Test seam for checking the runtime directory filesystem. */
  requireTmpfs?: boolean;
}

export interface WireGuardGatewayIdentity {
  publicKey: string;
  /** Hash of the public peer policy and network settings; bind this into attestation. */
  policyHash: string;
  endpoint: string;
  listenPort: number;
  interfaceAddress: string;
  /** Allowed IPs advertised to the client for a full IPv4 tunnel. */
  clientAllowedIPs: '0.0.0.0/0';
}

export interface RunningWireGuardGateway {
  readonly identity: WireGuardGatewayIdentity;
  stop(): Promise<void>;
}

/**
 * Start a kernel WireGuard gateway with pre-authorized peers.
 *
 * The workload needs kernel WireGuard support, `wg`/`wg-quick`, and CAP_NET_ADMIN.
 * These privileges must be supplied by the Confidential Space runtime, not by an
 * unrestricted/privileged container. If they are unavailable, startup fails closed.
 * IPv4 Internet egress is NATed; private, local, link-local, and reserved IPv4
 * destinations are rejected. IPv6 is deliberately not forwarded by this gateway.
 */
export async function startWireGuardGateway(options: WireGuardGatewayOptions): Promise<RunningWireGuardGateway> {
  validateOptions(options);
  const run = options.runCommand ?? runSystemCommand;
  const runtimeDirectory = options.runtimeDirectory ?? DEFAULT_RUNTIME_DIRECTORY;
  if (options.requireTmpfs !== false) await assertTmpfs(runtimeDirectory);
  const privateKey = (await run('wg', ['genkey'])).trim();
  validateWireGuardKey(privateKey, 'generated private key');
  const publicKey = (await run('wg', ['pubkey'], `${privateKey}\n`)).trim();
  validateWireGuardKey(publicKey, 'generated public key');

  const interfaceName = 'wg0';
  const privateDirectory = await mkdtemp(join(runtimeDirectory, 'wraps-wireguard-'));
  const configPath = join(privateDirectory, `${interfaceName}.conf`);
  const interfaceAddress = parseIpv4Cidr(options.interfaceAddress);
  const policyHash = createHash('sha256').update(JSON.stringify({
    endpoint: options.endpoint,
    listenPort: options.listenPort,
    interfaceAddress: options.interfaceAddress,
    egressInterface: options.egressInterface,
    peers: [...options.peers].map(({ publicKey: key, allowedAddress }) => ({ publicKey: key, allowedAddress })).sort((a, b) => a.publicKey.localeCompare(b.publicKey)),
    clientAllowedIPs: '0.0.0.0/0',
    ipv6Forwarding: false,
  })).digest('hex');

  const policy = buildFirewallPolicy(interfaceName, options.egressInterface, interfaceAddress.network);
  const config = [
    '[Interface]',
    `Address = ${options.interfaceAddress}`,
    `ListenPort = ${options.listenPort}`,
    `PrivateKey = ${privateKey}`,
    'Table = off',
    `PostUp = ${policy.up.join(' && ')}`,
    `PostDown = ${policy.down.join('; ')}`,
    ...options.peers.flatMap((peer) => [
      '',
      '[Peer]',
      `PublicKey = ${peer.publicKey}`,
      `AllowedIPs = ${peer.allowedAddress}`,
    ]),
    '',
  ].join('\n');

  await writeFile(configPath, config, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const forwarding = (await run('sysctl', ['-n', 'net.ipv4.ip_forward'])).trim();
  if (forwarding !== '1') {
    await rm(privateDirectory, { recursive: true, force: true });
    throw new Error('WireGuard IPv4 forwarding must be enabled by the VM deployment');
  }
  let active = false;
  try {
    await run('wg-quick', ['up', configPath]);
    active = true;
  } catch {
    try { await run('wg-quick', ['down', configPath]); } catch { /* clean partial setup best-effort */ }
    await rm(privateDirectory, { recursive: true, force: true });
    throw new Error('Could not start WireGuard; verify kernel WireGuard support, CAP_NET_ADMIN, and the host firewall tools');
  }

  const identity: WireGuardGatewayIdentity = {
    publicKey,
    policyHash,
    endpoint: options.endpoint,
    listenPort: options.listenPort,
    interfaceAddress: options.interfaceAddress,
    clientAllowedIPs: '0.0.0.0/0',
  };

  return {
    identity,
    async stop() {
      if (!active) return;
      active = false;
      try {
        await run('wg-quick', ['down', configPath]);
      } finally {
        // The private key exists on disk only in the workload's tmpfs while the
        // interface is up. The VM/workload must still be treated as secret memory.
        await rm(privateDirectory, { recursive: true, force: true });
      }
    },
  };
}

function validateOptions(options: WireGuardGatewayOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('WireGuard options are required');
  if (!isEndpoint(options.endpoint)) throw new TypeError('WireGuard endpoint must be an IPv4 address or DNS name');
  if (!Number.isSafeInteger(options.listenPort) || options.listenPort < 1 || options.listenPort > 65535) {
    throw new RangeError('WireGuard listenPort must be a UDP port');
  }
  if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(options.egressInterface)) throw new TypeError('egressInterface is invalid');
  if (!Array.isArray(options.peers) || options.peers.length === 0 || options.peers.length > 1024) {
    throw new RangeError('WireGuard needs between 1 and 1024 configured peers');
  }
  const iface = parseIpv4Cidr(options.interfaceAddress);
  if (iface.prefix > 30) throw new TypeError('WireGuard server subnet must leave room for peer addresses');
  if (!isPrivateIPv4(iface.numeric)) throw new TypeError('WireGuard tunnel subnet must use RFC1918 private IPv4 space');
  if (isNetworkOrBroadcast(iface, iface.numeric)) throw new TypeError('WireGuard server address cannot be the subnet network or broadcast address');
  const keys = new Set<string>();
  const addresses = new Set<string>();
  for (const peer of options.peers) {
    validateWireGuardKey(peer.publicKey, 'peer public key');
    if (keys.has(peer.publicKey)) throw new TypeError('duplicate WireGuard peer public key');
    keys.add(peer.publicKey);
    const address = parseIpv4Cidr(peer.allowedAddress);
    if (address.prefix !== 32 || !contains(iface, address.numeric) || address.address === iface.address || isNetworkOrBroadcast(iface, address.numeric)) {
      throw new TypeError('each peer address must be a distinct IPv4 /32 inside the server subnet');
    }
    if (addresses.has(address.address)) throw new TypeError('duplicate WireGuard peer address');
    addresses.add(address.address);
  }
}

function buildFirewallPolicy(iface: string, egress: string, cidr: string): { up: string[]; down: string[] } {
  const chain = 'WRAPS_WG0_FORWARD';
  const reject = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
  const up = [`iptables -N ${chain}`];
  for (const destination of reject) up.push(`iptables -A ${chain} -i ${iface} -d ${destination} -j REJECT`);
  up.push(
    `iptables -A ${chain} -i ${iface} ! -s ${cidr} -j DROP`,
    `iptables -A ${chain} -i ${iface} -o ${egress} -s ${cidr} -j ACCEPT`,
    `iptables -A ${chain} -i ${egress} -o ${iface} -d ${cidr} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
    `iptables -A ${chain} -i ${iface} -j DROP`,
    `iptables -I FORWARD 1 -o ${iface} -j ${chain}`,
    `iptables -I FORWARD 1 -i ${iface} -j ${chain}`,
    `iptables -t nat -A POSTROUTING -s ${cidr} -o ${egress} -j MASQUERADE`,
    `ip6tables -I FORWARD 1 -o ${iface} -j REJECT`,
    `ip6tables -I FORWARD 1 -i ${iface} -j REJECT`,
  );
  const down = [
    `ip6tables -D FORWARD -i ${iface} -j REJECT`,
    `ip6tables -D FORWARD -o ${iface} -j REJECT`,
    `iptables -t nat -D POSTROUTING -s ${cidr} -o ${egress} -j MASQUERADE`,
    `iptables -D FORWARD -i ${iface} -j ${chain}`,
    `iptables -D FORWARD -o ${iface} -j ${chain}`,
    `iptables -F ${chain}`,
    `iptables -X ${chain}`,
  ];
  return { up, down };
}

function parseIpv4Cidr(value: string): { address: string; prefix: number; network: string; numeric: number } {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
  if (!match) throw new TypeError(`invalid IPv4 CIDR: ${value}`);
  const parts = match[1].split('.').map(Number);
  if (parts.some((part) => part < 0 || part > 255)) throw new TypeError(`invalid IPv4 CIDR: ${value}`);
  const prefix = Number(match[2]);
  if (prefix < 8 || prefix > 32) throw new TypeError('WireGuard IPv4 subnet prefix must be between /8 and /32');
  const numeric = parts.reduce((sum, part) => ((sum << 8) | part) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = numberToIpv4((numeric & mask) >>> 0);
  return { address: match[1], prefix, network: `${network}/${prefix}`, numeric };
}

function contains(cidr: { numeric: number; prefix: number }, address: number): boolean {
  const mask = (0xffffffff << (32 - cidr.prefix)) >>> 0;
  return ((address & mask) >>> 0) === ((cidr.numeric & mask) >>> 0);
}

function isNetworkOrBroadcast(cidr: { numeric: number; prefix: number }, address: number): boolean {
  const mask = (0xffffffff << (32 - cidr.prefix)) >>> 0;
  const network = (cidr.numeric & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return address === network || address === broadcast;
}

function isPrivateIPv4(address: number): boolean {
  const first = address >>> 24;
  const second = (address >>> 16) & 255;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function isEndpoint(value: string): boolean {
  if (!value || value.length > 253 || /[\s/\\]/.test(value)) return false;
  if (/^\d+(?:\.\d+){3}$/.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  return value.split('.').every((label) => label.length > 0 && label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
}

function validateWireGuardKey(value: string, description: string): void {
  if (!/^[A-Za-z0-9+/]{42}=$/.test(value)) throw new TypeError(`${description} must be a 32-byte WireGuard key`);
  if (Buffer.from(value, 'base64').byteLength !== 32 || Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new TypeError(`${description} must be canonical base64`);
  }
}

async function assertTmpfs(path: string): Promise<void> {
  const stats = await statfs(path);
  if (stats.type !== TMPFS_MAGIC) throw new Error(`${path} must be a tmpfs mount for WireGuard private-key material`);
}

async function runSystemCommand(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', () => reject(new Error(`${basename(command)} is unavailable`)));
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`${basename(command)} failed with exit code ${code ?? 'unknown'}`));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.end(input);
  });
}
