import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import type { LiveDemoConfig } from '../../../scripts/live-config';

const execFile = promisify(execFileCallback);
export const DEFAULT_WORKER_IMAGE = 'wraps-demo-agent-worker:local';

export interface AgentWorkerInput {
  config: LiveDemoConfig;
  merchantUrl: string;
  tamper?: boolean;
  signal?: AbortSignal;
  publish(name: string, data: unknown): void;
}

export interface AgentWorkerResult {
  fallbackAvailable: boolean;
}

export function buildWorkerRunArgs(input: {
  expectedJson: string;
  issuerUrl: string;
  relayUrl: string;
  relayAttestationUrl: string;
  relayIp: string;
  merchantUrl: string;
  tamper?: boolean;
  containerName?: string;
  image?: string;
}): string[] {
  if (isIP(input.relayIp) !== 4) throw new Error('isolated agent worker requires a numeric IPv4 relay IP');
  if (isIP(new URL(input.issuerUrl).hostname.replace(/^\[|\]$/g, '')) !== 4) {
    throw new Error('isolated agent worker requires a numeric IPv4 issuer URL');
  }
  if (input.expectedJson.includes(',') || input.expectedJson.includes(':')) {
    throw new Error('expected policy path cannot contain a comma or colon for a Docker read-only mount');
  }
  const args = [
    'run', '--rm', '--pull=never',
    '--cap-drop=ALL', '--cap-add=NET_ADMIN', '--cap-add=SETUID', '--cap-add=SETGID', '--security-opt=no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--dns=127.0.0.1', '--dns-search=.',
    '--mount', `type=bind,src=${input.expectedJson},dst=/run/wraps/expected.json,readonly`,
    '--env', 'EXPECTED_JSON=/run/wraps/expected.json',
    '--env', `ISSUER_URL=${input.issuerUrl}`,
    '--env', `RELAY_URL=${input.relayUrl}`,
    '--env', `RELAY_ATTESTATION_URL=${input.relayAttestationUrl}`,
    '--env', `WRAPS_RELAY_IP=${input.relayIp}`,
    '--env', `DEMO_MERCHANT_URL=${input.merchantUrl}`,
  ];
  if (input.tamper) args.push('--env', 'DEMO_TAMPER=1');
  if (input.containerName) args.push('--name', input.containerName);
  args.push(input.image ?? DEFAULT_WORKER_IMAGE);
  return args;
}

export async function runIsolatedAgentWorker(input: AgentWorkerInput): Promise<AgentWorkerResult> {
  if (input.signal?.aborted) throw new Error('isolated agent worker was cancelled before startup');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const image = DEFAULT_WORKER_IMAGE;
  input.publish('step', { message: 'Building the isolated agent worker from an allowlisted local source context.' });
  try {
    await execFile('bash', [resolve(root, 'scripts/build-demo-agent-worker.sh')], {
      cwd: root,
      env: { ...process.env, DEMO_AGENT_WORKER_IMAGE: image },
      timeout: 5 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not build the isolated agent worker image: ${detail}`);
  }
  if (input.signal?.aborted) throw new Error('isolated agent worker was cancelled before startup');

  const relayIp = input.config.relayIp;
  const issuerIp = input.config.issuerIp;
  if (isIP(relayIp) !== 4 || isIP(issuerIp) !== 4) {
    throw new Error('live issuer and relay addresses must be numeric IPv4 addresses for the container egress policy');
  }
  const relayUrl = `https://${relayIp}`;
  const issuerUrl = `https://${issuerIp}`;
  const attestationUrl = `http://${relayIp}:${input.config.relayAttestationPort}/attestation`;
  const containerName = `wraps-agent-${process.pid}-${randomBytes(4).toString('hex')}`;
  const args = buildWorkerRunArgs({
    expectedJson: input.config.expectedJson,
    issuerUrl,
    relayUrl,
    relayAttestationUrl: attestationUrl,
    relayIp,
    merchantUrl: input.merchantUrl,
    tamper: input.tamper,
    containerName,
    image,
  });

  return new Promise((resolveResult, rejectResult) => {
    const child = spawn('docker', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    let result: AgentWorkerResult | undefined;
    let settled = false;
    let stopTimer: NodeJS.Timeout | undefined;

    const onAbort = () => {
      // `docker stop` sends SIGTERM to the isolated container, giving it a short
      // graceful close window before Docker kills it. It never touches host routes.
      void execFile('docker', ['stop', '--time', '2', containerName], { cwd: root, timeout: 5_000, maxBuffer: 64 * 1024 })
        .catch(() => child.kill('SIGTERM'));
      stopTimer = setTimeout(() => child.kill('SIGKILL'), 7_000);
      stopTimer.unref();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    lines.on('line', (line) => {
      try {
        const frame = JSON.parse(line) as { type?: unknown; name?: unknown; data?: unknown; fallbackAvailable?: unknown };
        if (frame.type === 'event' && typeof frame.name === 'string') input.publish(frame.name, frame.data);
        else if (frame.type === 'result' && typeof frame.fallbackAvailable === 'boolean') {
          result = { fallbackAvailable: frame.fallbackAvailable };
        }
      } catch {
        // Worker stdout is a newline-delimited JSON protocol. Ignore malformed
        // diagnostics here; Docker stderr is returned only if the worker fails.
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (input.signal?.aborted) return finish(new Error('isolated agent worker was stopped'));
      if (code !== 0) return finish(new Error(`isolated agent worker exited with ${code ?? signal ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`));
      if (!result) return finish(new Error('isolated agent worker exited without a result frame'));
      finish(undefined, result);
    });

    function finish(error?: Error, value?: AgentWorkerResult) {
      if (settled) return;
      settled = true;
      if (stopTimer) clearTimeout(stopTimer);
      input.signal?.removeEventListener('abort', onAbort);
      lines.close();
      if (error) rejectResult(error);
      else resolveResult(value!);
    }
  });
}
