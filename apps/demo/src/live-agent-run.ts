import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { AttestationError, type ConfidentialSpaceDetails, type VerifiedAttestation } from '@wraps/attestation';
import { ResearchAgent, DEMO_TASKS } from '@wraps/agent';
import { merchantPrivateKeyFromB64u } from '@wraps/issuer';
import { Merchant } from '@wraps/merchant';
import { MockTopUpWallet, PrivatePayClient, createPinnedRelayTransport, type PinnedRelayTransport } from '@wraps/sdk';
import { createLiveVerifier, mismatchedDigest, resolveLiveConfig, vmAvailabilityHint, LiveConfigError, type LiveDemoConfig } from '../../../scripts/live-config';

export type LivePublish = (type: string, data?: unknown) => void;

export interface LiveAgentOutcome {
  fallbackAvailable: boolean;
}

export interface LiveAgentDependencies {
  resolveConfig(): Promise<LiveDemoConfig>;
  createRelay(config: LiveDemoConfig): Promise<PinnedRelayTransport>;
  createTunnel(localMerchantUrl: string): Promise<{ url: string; close(): Promise<void> }>;
}

const defaultDependencies: LiveAgentDependencies = {
  resolveConfig: () => resolveLiveConfig(),
  createRelay: (config) => createPinnedRelayTransport({
    relayUrl: config.relayUrl,
    issuerUrl: config.issuerUrl,
    attestationUrl: config.relayAttestationUrl,
    verifier: createLiveVerifier(config, 'relay'),
  }),
  createTunnel: startCloudflareTunnel,
};

/** Live right-pane flow: verify the relay and issuer, then use the relay for every merchant call. */
export async function runLivePrivateAgent(
  publish: LivePublish,
  opts: { tamper?: boolean; dependencies?: LiveAgentDependencies } = {},
): Promise<LiveAgentOutcome> {
  const tamper = opts.tamper ?? false;
  const deps = opts.dependencies ?? defaultDependencies;
  let relay: PinnedRelayTransport | undefined;
  let merchant: Merchant | undefined;
  let tunnel: { url: string; close(): Promise<void> } | undefined;
  let config: LiveDemoConfig | undefined;
  let currentRole: 'issuer' | 'relay' | 'merchant' | undefined;
  try {
    publish('step', { message: 'Reading live service addresses and expected image digests.' });
    const liveConfig = await deps.resolveConfig();
    config = liveConfig;

    publish('step', { message: 'Requesting and verifying the relay’s nonce-bound Confidential Space attestation.' });
    currentRole = 'relay';
    relay = await deps.createRelay(liveConfig);
    publish('attestation-verification', verificationSummary(
      'Relay', relay.relay.attestation, liveConfig.expected.relayDigest, relay.relay.tunnelKey.byteLength > 0,
    ));

    publish('step', { message: 'Connecting to the live issuer through the pinned relay.' });
    currentRole = 'issuer';
    const issuerDigest = tamper ? mismatchedDigest(liveConfig.expected.issuerDigest) : liveConfig.expected.issuerDigest;
    const verifier = createLiveVerifier(liveConfig, 'issuer', issuerDigest);
    const sdk = new PrivatePayClient({
      issuerUrl: liveConfig.issuerUrl,
      verifier,
      wallet: new MockTopUpWallet(),
      relayTransport: relay,
      caps: { perCallTokens: 5, dailyTokens: 24, maxTopUpTokens: 20 },
      onEvent: (event) => publish(`sdk:${event.type}`, event),
    });

    let attested;
    try {
      attested = await sdk.connect();
    } catch (error) {
      if (tamper && error instanceof AttestationError && error.code === 'IMAGE_MISMATCH') {
        publish('attestation-verification', {
          title: 'Relay TLS connection verified',
          passed: true,
          checks: [{ name: 'TLS key pinned', value: 'yes; live issuer response arrived over the attested relay certificate', expected: 'yes', passed: true }],
        });
        publish('tamper-refused', {
          code: error.code,
          expectedDigest: issuerDigest,
          message: `Live issuer refused the deliberately wrong expected digest (${issuerDigest}). ${error.message}`,
        });
        return { fallbackAvailable: false };
      }
      throw error;
    }

    publish('attestation-verification', {
      title: 'Relay TLS connection verified',
      passed: true,
      checks: [{ name: 'TLS key pinned', value: 'yes; issuer CONNECT succeeded over the attested relay certificate', expected: 'yes', passed: true }],
    });
    publish('attestation-verification', verificationSummary(
      'Issuer', attested.attestation, liveConfig.expected.issuerDigest, Boolean(attested.tlsKey),
    ));
    if (tamper) {
      publish('error', { message: 'The live issuer accepted the deliberately wrong expected digest. Tamper verification failed.' });
      return { fallbackAvailable: false };
    }

    publish('step', { message: 'Starting the local merchant against the live, attested issuer.' });
    currentRole = 'merchant';
    const merchantAuthPrivateKey = merchantPrivateKeyFromB64u(process.env.MERCHANT_AUTH_PRIVATE_KEY ?? '');
    merchant = new Merchant({
      issuerUrl: liveConfig.issuerUrl,
      verifier: createLiveVerifier(liveConfig, 'issuer'),
      authPrivateKey: merchantAuthPrivateKey,
      log: (message) => publish('merchant', { message }),
    });
    const localMerchantUrl = await merchant.start();
    let lastClientIp: string | undefined;
    merchant.server?.on('request', (request: IncomingMessage) => {
      const forwarded = forwardedClientIp(request);
      if (!forwarded || forwarded === lastClientIp) return;
      lastClientIp = forwarded;
      publish('merchant-ip', {
        address: forwarded,
        source: request.headers['cf-connecting-ip'] ? 'Cloudflare CF-Connecting-IP' : 'X-Forwarded-For',
        relayIp: liveConfig.relayIp,
        matchesRelayIp: isSameAddress(forwarded, liveConfig.relayIp),
        message: `Local merchant received forwarded client IP ${forwarded} from the attested relay path.`,
      });
    });

    publish('step', { message: 'Opening an HTTPS Cloudflare Tunnel so the GCP relay can reach the local merchant.' });
    tunnel = process.env.DEMO_MERCHANT_URL
      ? { url: publicMerchantUrl(process.env.DEMO_MERCHANT_URL), close: async () => {} }
      : await deps.createTunnel(localMerchantUrl);
    publish('step', {
      message: `Local merchant is reachable at ${tunnel.url}. The agent will send metered HTTPS requests through the attested relay.`,
    });

    publish('step', { message: 'Top-up: requesting 20 blind tokens from the verified issuer. The demo wallet uses the mock rail; AP4M is skipped.' });
    await sdk.topUp(20);

    const results = await new ResearchAgent({
      sdk,
      merchantUrl: tunnel.url,
      print: (message) => publish('reasoning', { message }),
    }).run([DEMO_TASKS[0]]);
    if (!results.some((result) => result.bought.length > 0)) {
      throw new Error('No merchant purchase completed. Check the HTTPS merchant tunnel or DEMO_MERCHANT_URL.');
    }
    publish('complete', { message: 'Live issuer and relay verified; the research purchase ran through the attested relay. AP4M top-up was skipped; mock rail used.' });
    return { fallbackAvailable: false };
  } catch (error) {
    let detail = errorMessage(error);
    if (config && (currentRole === 'issuer' || currentRole === 'relay') && isAvailabilityFailure(error)) {
      detail = `${detail}\n${await vmAvailabilityHint(currentRole)}`;
    }
    if (!isAvailabilityFailure(error)) {
      publish('live-refused', {
        message: `Live verification failed: ${detail}\nNo local fallback is offered for an attestation or key-pin refusal. No top-up or purchase was sent.`,
        detail,
      });
      return { fallbackAvailable: false };
    }
    publish('live-unavailable', {
      message: `Live demo unavailable: ${detail}\nNo local run is being presented as live. Select “Run local mock” to continue with mock attestation and local services.`,
      detail,
    });
    return { fallbackAvailable: true };
  } finally {
    await tunnel?.close().catch(() => {});
    await merchant?.close().catch(() => {});
    await relay?.close().catch(() => {});
  }
}

function verificationSummary(
  role: 'Issuer' | 'Relay',
  attestation: VerifiedAttestation,
  expectedDigest: string,
  tlsKeyPinned: boolean,
) {
  const details = (attestation as VerifiedAttestation & { details?: ConfidentialSpaceDetails }).details;
  return {
    title: `${role} Confidential Space attestation verified`,
    passed: attestation.measurement === expectedDigest && tlsKeyPinned,
    checks: [
      { name: 'hwmodel', value: details?.hwmodel ?? 'unavailable', expected: 'GCP_AMD_SEV', passed: details?.hwmodel === 'GCP_AMD_SEV' },
      { name: 'swname', value: details?.swname ?? 'unavailable', expected: 'CONFIDENTIAL_SPACE', passed: details?.swname === 'CONFIDENTIAL_SPACE' },
      { name: 'dbgstat', value: details?.dbgstat ?? 'unavailable', expected: 'disabled-since-boot', passed: details?.dbgstat === 'disabled-since-boot' },
      { name: 'image digest', value: attestation.measurement, expected: expectedDigest, passed: attestation.measurement === expectedDigest },
      { name: 'TLS key pinned', value: tlsKeyPinned ? 'yes' : 'no', expected: 'yes', passed: tlsKeyPinned },
    ],
  };
}

function forwardedClientIp(request: IncomingMessage): string | undefined {
  const cloudflare = request.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare.trim()) return cloudflare.trim();
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0]!.trim();
  return undefined;
}

function publicMerchantUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DEMO_MERCHANT_URL is not a valid URL. Set it to a public HTTPS route for the local merchant.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('DEMO_MERCHANT_URL must be a public HTTPS merchant origin without credentials, path, query, or fragment.');
  }
  return url.toString().replace(/\/$/, '');
}

function isSameAddress(a: string, b: string): boolean | null {
  const normalize = (value: string) => value.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (!isIP(normalize(a)) || !isIP(normalize(b))) return null;
  return normalize(a) === normalize(b);
}

function startCloudflareTunnel(localMerchantUrl: string): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', localMerchantUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    let timer: NodeJS.Timeout;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(error);
    };
    const checkOutput = (chunk: Buffer | string) => {
      output += chunk.toString();
      const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
      if (!url || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, close: () => stopChild(child) });
    };
    timer = setTimeout(() => finishError(new Error(
      'cloudflared did not return a Quick Tunnel URL within 20 seconds. Install it with `brew install cloudflared`, or set DEMO_MERCHANT_URL to an HTTPS URL reachable from the relay.',
    )), 20_000);
    timer.unref();
    child.stdout?.on('data', checkOutput);
    child.stderr?.on('data', checkOutput);
    child.once('error', (error) => finishError(new Error(
      `Could not start cloudflared: ${error.message}. Install it with ` +
      '`brew install cloudflared`, or set DEMO_MERCHANT_URL to an HTTPS URL reachable from the relay.',
    )));
    child.once('exit', (code, signal) => {
      if (!settled) finishError(new Error(`cloudflared exited before the merchant tunnel was ready (code ${code ?? signal ?? 'unknown'}).`));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAvailabilityFailure(error: unknown): boolean {
  if (error instanceof LiveConfigError) return true;
  const message = errorMessage(error);
  if (error instanceof AttestationError) {
    return error.code === 'MALFORMED' && /request failed|HTTP 5\d\d|timed out|fetch failed|ECONN|EHOSTUNREACH|ENETUNREACH|socket/i.test(message);
  }
  return /could not start cloudflared|cloudflared did not return|cloudflared exited|DEMO_MERCHANT_URL|no merchant purchase completed|fetch failed|ECONN|EHOSTUNREACH|ENETUNREACH|EADDRINUSE|ETIMEDOUT|timed out|not configured|not set|is missing|still starting/i.test(message);
}
