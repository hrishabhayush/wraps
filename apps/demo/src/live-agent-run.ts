import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { AttestationError } from '@wraps/attestation';
import { Merchant } from '@wraps/merchant';
import { createLiveVerifier, LiveConfigError, resolveLiveConfig, type LiveDemoConfig } from '../../../scripts/live-config';
import { runIsolatedAgentWorker, type AgentWorkerResult } from './worker-process';

export type LivePublish = (type: string, data?: unknown) => void;

export interface LiveAgentOutcome {
  fallbackAvailable: boolean;
}

export interface LiveAgentDependencies {
  resolveConfig(): Promise<LiveDemoConfig>;
  createMerchant(config: LiveDemoConfig, publish: LivePublish): Promise<{ url: string; close(): Promise<void> }>;
  createTunnel(localMerchantUrl: string): Promise<{ url: string; close(): Promise<void> }>;
  runWorker(input: {
    config: LiveDemoConfig;
    merchantUrl: string;
    tamper?: boolean;
    signal?: AbortSignal;
    publish(name: string, data: unknown): void;
  }): Promise<AgentWorkerResult>;
}

const defaultDependencies: LiveAgentDependencies = {
  resolveConfig: () => resolveLiveConfig(),
  createMerchant: createLocalMerchant,
  createTunnel: startCloudflareTunnel,
  runWorker: runIsolatedAgentWorker,
};

/**
 * The host owns only the UI, spy, merchant and Cloudflare tunnel. The private
 * agent runs in a separate container whose OUTPUT policy allows only the
 * numeric relay IP on TCP 443/8080.
 */
export async function runLivePrivateAgent(
  publish: LivePublish,
  opts: { tamper?: boolean; dependencies?: LiveAgentDependencies; signal?: AbortSignal } = {},
): Promise<LiveAgentOutcome> {
  const deps = opts.dependencies ?? defaultDependencies;
  let merchant: { url: string; close(): Promise<void> } | undefined;
  let tunnel: { url: string; close(): Promise<void> } | undefined;
  let config: LiveDemoConfig | undefined;
  try {
    publish('step', { message: 'Reading live service addresses and expected image digests.' });
    config = await deps.resolveConfig();
    if (isIP(config.relayIp) !== 4 || isIP(config.issuerIp) !== 4) {
      throw new LiveConfigError('The isolated agent requires numeric IPv4 issuer and relay addresses so it can run without DNS.', 'relay');
    }
    if (opts.signal?.aborted) return { fallbackAvailable: false };

    publish('step', { message: 'Starting the local merchant on the host, outside the agent container.' });
    merchant = await deps.createMerchant(config, publish);

    publish('step', { message: 'Opening the host HTTPS tunnel so the GCP relay can reach the local merchant.' });
    tunnel = process.env.DEMO_MERCHANT_URL
      ? { url: publicMerchantUrl(process.env.DEMO_MERCHANT_URL), close: async () => {} }
      : await deps.createTunnel(merchant.url);

    if (opts.signal?.aborted) return { fallbackAvailable: false };
    publish('step', { message: 'Starting the agent in a container with default-drop egress and a relay-only allowlist.' });
    return await deps.runWorker({
      config,
      merchantUrl: tunnel.url,
      tamper: opts.tamper,
      signal: opts.signal,
      publish,
    });
  } catch (error) {
    if (opts.signal?.aborted) return { fallbackAvailable: false };
    const detail = errorText(error);
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
  }
}

async function createLocalMerchant(config: LiveDemoConfig, publish: LivePublish): Promise<{ url: string; close(): Promise<void> }> {
  const merchant = new Merchant({
    issuerUrl: config.issuerUrl,
    verifier: createLiveVerifier(config, 'issuer'),
    log: (message) => publish('merchant', { message }),
  });
  const url = await merchant.start();
  let lastClientIp: string | undefined;
  merchant.server?.on('request', (request: IncomingMessage) => {
    const forwarded = forwardedClientIp(request);
    if (!forwarded || forwarded === lastClientIp) return;
    lastClientIp = forwarded;
    publish('merchant-ip', {
      address: forwarded,
      source: request.headers['cf-connecting-ip'] ? 'Cloudflare CF-Connecting-IP' : 'X-Forwarded-For',
      relayIp: config.relayIp,
      matchesRelayIp: isSameAddress(forwarded, config.relayIp),
      message: `Local merchant received forwarded client IP ${forwarded} from the attested relay path.`,
    });
  });
  return { url, close: () => merchant.close() };
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAvailabilityFailure(error: unknown): boolean {
  if (error instanceof LiveConfigError) return true;
  if (error instanceof AttestationError) {
    return error.code === 'MALFORMED' && /request failed|HTTP 5\d\d|timed out|fetch failed|ECONN|EHOSTUNREACH|ENETUNREACH|socket/i.test(error.message);
  }
  return /could not build the isolated agent worker|isolated agent worker exited|isolated agent worker image|could not start cloudflared|cloudflared did not return|cloudflared exited|DEMO_MERCHANT_URL|no merchant purchase completed|fetch failed|ECONN|EHOSTUNREACH|ENETUNREACH|EADDRINUSE|ETIMEDOUT|timed out|not configured|not set|is missing|still starting/i.test(errorText(error));
}
