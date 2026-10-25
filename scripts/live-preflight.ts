import { connect as tlsConnect } from 'node:tls';
import { isIP } from 'node:net';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { AttestationError } from '@wraps/attestation';
import { fetchAttestedIssuer, merchantPrivateKeyFromB64u, type AttestedIssuer, type Transport } from '@wraps/issuer';
import { createPinnedRelayTransport, type PinnedRelayTransport } from '@wraps/sdk';
import { createLiveVerifier, resolveLiveConfigForPreflight, vmAvailabilityHint, type LiveDemoConfig } from './live-config';

const execFile = promisify(execFileCallback);

export const XRPL_PUBLIC_NODES = ['https://s1.ripple.com:51234', 'https://xrplcluster.com'] as const;

export interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
}

export interface PreflightDependencies {
  probeIssuer(config: LiveDemoConfig): Promise<void>;
  verifyIssuer(config: LiveDemoConfig): Promise<AttestedIssuer>;
  probeRelay(config: LiveDemoConfig): Promise<void>;
  verifyRelay(config: LiveDemoConfig): Promise<PinnedRelayTransport>;
  verifyRelayTlsPin(config: LiveDemoConfig, relay: PinnedRelayTransport): Promise<void>;
  verifyIssuerThroughRelay(config: LiveDemoConfig, relay: PinnedRelayTransport): Promise<AttestedIssuer>;
  probeXrplNode(url: string): Promise<void>;
  vmHint(role: 'issuer' | 'relay'): Promise<string>;
  checkMerchantTunnel(): Promise<string>;
  checkDemoMerchantKey(): void;
}

const defaultDependencies: PreflightDependencies = {
  probeIssuer: (config) => probeTls(config.issuerUrl),
  verifyIssuer: (config) => fetchAttestedIssuer(config.issuerUrl, createLiveVerifier(config, 'issuer')),
  probeRelay: (config) => probeHttp(`${config.relayAttestationUrl}?probe=1`),
  verifyRelay: (config) => createPinnedRelayTransport({
    relayUrl: config.relayUrl,
    issuerUrl: config.issuerUrl,
    attestationUrl: config.relayAttestationUrl,
    verifier: createLiveVerifier(config, 'relay'),
  }),
  verifyRelayTlsPin: (config, relay) => verifyTlsPeerPin(config.relayUrl, relay.relay.tunnelKey),
  verifyIssuerThroughRelay: (config, relay) => fetchAttestedIssuer(config.issuerUrl, createLiveVerifier(config, 'issuer'), relayRoute(relay)),
  probeXrplNode: probeXrplNode,
  vmHint: vmAvailabilityHint,
  checkMerchantTunnel,
  checkDemoMerchantKey: () => {
    const encoded = process.env.MERCHANT_AUTH_PRIVATE_KEY;
    if (!encoded) throw new Error('MERCHANT_AUTH_PRIVATE_KEY is missing; configure the live merchant signing key locally');
    merchantPrivateKeyFromB64u(encoded);
  },
};

/** Executes a fully injectable checklist so tests never depend on live services. */
export async function runLivePreflight(
  config: LiveDemoConfig,
  deps: PreflightDependencies = defaultDependencies,
  write: (line: string) => void = console.log,
  unavailable: Partial<Record<'issuer' | 'relay', string>> = {},
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  let issuer: AttestedIssuer | undefined;
  let relay: PinnedRelayTransport | undefined;

  if (unavailable.issuer) {
    add('Issuer reachable', false, unavailable.issuer);
    add('Issuer attestation verifies', false, 'issuer address or VM is unavailable');
    add('Issuer merchant authentication mode', false, 'issuer mode was unavailable');
    add('Issuer image digest matches expected.json', false, 'no issuer attestation was received');
    add('Issuer TLS key pinned', false, 'no issuer TLS peer was received');
  } else {
    try {
      await deps.probeIssuer(config);
      add('Issuer reachable', true, config.issuerUrl);
    } catch (error) {
      add('Issuer reachable', false, `${errorMessage(error)}. ${await deps.vmHint('issuer')}`);
    }

    try {
      issuer = await deps.verifyIssuer(config);
      add('Issuer attestation verifies', true, `${issuer.attestation.format}; nonce and public key hash verified`);
      add('Issuer merchant authentication mode', issuer.merchantAuth === 'enforced',
        `${issuer.merchantAuth}; runtime-reported and not covered by the key attestation`);
      const digestMatches = issuer.attestation.measurement === config.expected.issuerDigest;
      add('Issuer image digest matches expected.json', digestMatches,
        `expected ${config.expected.issuerDigest}; got ${issuer.attestation.measurement}`);
      add('Issuer TLS key pinned', Boolean(issuer.tlsKey), issuer.tlsKey ? 'attested key observed and pinned' : 'attested issuer did not expose a TLS key');
    } catch (error) {
      const reachableFromResponse = error instanceof AttestationError;
      add('Issuer attestation verifies', false, errorMessage(error));
      add('Issuer merchant authentication mode', false, 'issuer mode was not verified');
      if (!checks.some((check) => check.name === 'Issuer reachable' && check.passed) && reachableFromResponse) {
        checks[checks.findIndex((check) => check.name === 'Issuer reachable')] = { name: 'Issuer reachable', passed: true, detail: 'issuer answered; attestation was refused' };
      }
      add('Issuer image digest matches expected.json', false, errorMessage(error));
      add('Issuer TLS key pinned', false, 'issuer attestation did not complete');
    }
  }

  if (unavailable.relay) {
    add('Relay attestation port reachable', false, unavailable.relay);
    add('Relay attestation verifies', false, 'relay address or VM is unavailable');
    add('Relay image digest matches expected.json', false, 'no relay attestation was received');
    add('Relay TLS key pinned', false, 'no relay tunnel key was received');
    add('Relay TLS service uses the attested key', false, 'no relay attestation was received');
  } else {
    try {
      await deps.probeRelay(config);
      add('Relay attestation port reachable', true, config.relayAttestationUrl);
    } catch (error) {
      add('Relay attestation port reachable', false, `${errorMessage(error)}. ${await deps.vmHint('relay')}`);
    }

    try {
      relay = await deps.verifyRelay(config);
      add('Relay attestation verifies', true, `${relay.relay.attestation.format}; nonce and tunnel key hash verified`);
      const digestMatches = relay.relay.attestation.measurement === config.expected.relayDigest;
      add('Relay image digest matches expected.json', digestMatches,
        `expected ${config.expected.relayDigest}; got ${relay.relay.attestation.measurement}`);
      add('Relay TLS key pinned', relay.relay.tunnelKey.byteLength > 0,
        relay.relay.tunnelKey.byteLength > 0 ? 'receipt TLS SPKI matches the attested tunnel key' : 'relay tunnel key missing');
    } catch (error) {
      add('Relay attestation verifies', false, errorMessage(error));
      add('Relay image digest matches expected.json', false, errorMessage(error));
      add('Relay TLS key pinned', false, 'relay attestation did not complete');
    }
    if (relay) {
      try {
        await deps.verifyRelayTlsPin(config, relay);
        add('Relay TLS service uses the attested key', true, 'live TLS peer SPKI matches the attested tunnel key');
      } catch (error) {
        add('Relay TLS service uses the attested key', false, errorMessage(error));
      }
    } else {
      add('Relay TLS service uses the attested key', false, 'relay attestation did not complete');
    }
  }

  if (unavailable.issuer || unavailable.relay) {
    add('Issuer reachable through the attested relay', false, unavailable.issuer ?? unavailable.relay!);
  } else if (relay) {
    try {
      const throughRelay = await deps.verifyIssuerThroughRelay(config, relay);
      add('Issuer reachable through the attested relay', true, `issuer TLS key pinned (${throughRelay.tlsKey ? 'yes' : 'no'})`);
    } catch (error) {
      add('Issuer reachable through the attested relay', false, errorMessage(error));
    }
  } else {
    add('Issuer reachable through the attested relay', false, 'relay attestation was not verified');
  }

  const xrplResults = await Promise.all(XRPL_PUBLIC_NODES.map(async (url) => {
    try {
      await deps.probeXrplNode(url);
      return { url, ok: true as const, detail: 'server_info responded' };
    } catch (error) {
      return { url, ok: false as const, detail: errorMessage(error) };
    }
  }));
  const reachableNodes = xrplResults.filter((result) => result.ok);
  add('XRPL mainnet public nodes reachable', reachableNodes.length > 0,
    reachableNodes.length
      ? `${reachableNodes.length}/${xrplResults.length} reachable: ${reachableNodes.map((node) => node.url).join(', ')}`
      : xrplResults.map((node) => `${node.url} (${node.detail})`).join('; '));

  try {
    add('Local merchant HTTPS tunnel available', true, await deps.checkMerchantTunnel());
  } catch (error) {
    add('Local merchant HTTPS tunnel available', false, errorMessage(error));
  }

  try {
    deps.checkDemoMerchantKey();
    add('Live merchant signing key configured', true,
      'valid Ed25519 key; confirm its public key is in the issuer image map');
  } catch (error) {
    add('Live merchant signing key configured', false, errorMessage(error));
  }

  await relay?.close().catch(() => {});
  const passed = checks.every((check) => check.passed);
  write('Live demo preflight');
  for (const check of checks) write(`${check.passed ? '✓ PASS' : '✗ FAIL'}  ${check.name}: ${check.detail}`);
  write(passed ? 'All live demo checks passed.' : 'Preflight failed. Fix the red checks before the demo.');
  return { passed, checks };
}

export function relayRoute(relay: PinnedRelayTransport): Transport {
  const route = ((url: string, init?: RequestInit) => relay.fetchIssuer(url, init)) as Transport;
  route.fetchWithPeer = (url, init) => relay.fetchIssuerWithPeer(url, init);
  route.fetchPinned = (url, expectedSpki, init) => relay.fetchIssuer(url, init, expectedSpki);
  return route;
}

async function probeTls(origin: string): Promise<void> {
  const url = new URL(origin);
  const ipLiteral = isIP(url.hostname) !== 0;
  await new Promise<void>((resolve, reject) => {
    const socket = tlsConnect({
      host: url.hostname,
      port: Number(url.port || 443),
      ...(ipLiteral ? {} : { servername: url.hostname }),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => socket.destroy(new Error('TLS probe timed out after 5 seconds')), 5_000);
    timer.unref();
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function verifyTlsPeerPin(origin: string, expectedSpki: Uint8Array): Promise<void> {
  const url = new URL(origin);
  const ipLiteral = isIP(url.hostname) !== 0;
  await new Promise<void>((resolve, reject) => {
    const socket = tlsConnect({
      host: url.hostname,
      port: Number(url.port || 443),
      ...(ipLiteral ? {} : { servername: url.hostname }),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => socket.destroy(new Error('relay TLS pin probe timed out after 5 seconds')), 5_000);
    timer.unref();
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      try {
        const peer = socket.getPeerX509Certificate();
        const actual = peer?.publicKey.export({ type: 'spki', format: 'der' });
        if (!actual || !Buffer.from(actual).equals(Buffer.from(expectedSpki))) {
          throw new Error('live relay TLS SPKI does not match the attested tunnel key');
        }
        socket.end();
        resolve();
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function probeHttp(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
  await response.body?.cancel().catch(() => {});
  if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
}

async function probeXrplNode(origin: string): Promise<void> {
  const response = await fetch(origin, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'server_info', params: [{}] }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { result?: { info?: unknown } };
  if (!body.result?.info) throw new Error('JSON-RPC response did not include result.info');
}

async function checkMerchantTunnel(): Promise<string> {
  const configuredUrl = process.env.DEMO_MERCHANT_URL;
  if (configuredUrl) {
    const url = new URL(configuredUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('DEMO_MERCHANT_URL must be a public HTTPS origin without credentials, path, query, or fragment');
    }
    return `DEMO_MERCHANT_URL configured: ${url.origin}`;
  }
  try {
    const { stdout, stderr } = await execFile('cloudflared', ['--version'], { timeout: 5_000, maxBuffer: 16 * 1024 });
    return `cloudflared available: ${(stdout || stderr).trim()}`;
  } catch {
    throw new Error('cloudflared is missing. Install it with `brew install cloudflared`, or set DEMO_MERCHANT_URL to a public HTTPS route for the local merchant.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  let config: LiveDemoConfig;
  let unavailable: Partial<Record<'issuer' | 'relay', string>>;
  try {
    ({ config, unavailable } = await resolveLiveConfigForPreflight());
  } catch (error) {
    const message = errorMessage(error);
    console.error(`✗ FAIL  Live demo configuration: ${message}`);
    process.exitCode = 1;
    return;
  }
  const result = await runLivePreflight(config, defaultDependencies, console.log, unavailable);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
