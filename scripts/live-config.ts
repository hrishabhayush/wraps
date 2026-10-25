import { existsSync, readFileSync } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { ConfidentialSpaceVerifier, type ConfidentialSpacePolicy, type AttestationVerifier } from '@wraps/attestation';

const execFile = promisify(execFileCallback);
const GCP_PROJECT = 'wraps-hack';
const GCP_ZONE = 'us-central1-a';

export interface LiveDemoConfig {
  issuerUrl: string;
  relayUrl: string;
  relayAttestationUrl: string;
  relayAttestationPort: number;
  issuerIp: string;
  relayIp: string;
  expectedJson: string;
  expected: {
    audience: string;
    hwModels: string[];
    requiredSupportAttribute: string;
    issuerDigest: string;
    relayDigest: string;
  };
}

export class LiveConfigError extends Error {
  constructor(message: string, readonly role?: 'issuer' | 'relay') {
    super(message);
    this.name = 'LiveConfigError';
  }
}

type Environment = Record<string, string | undefined>;

/** Parse environment, .state IPs, and expected.json without contacting GCP or the services. */
export function parseLiveConfig(env: Environment = process.env, cwd = process.cwd()): LiveDemoConfig {
  const expectedJson = resolve(cwd, env.EXPECTED_JSON ?? 'infra/gcp/expected.json');
  const expected = readExpected(expectedJson, env);
  const issuerAddress = env.ISSUER_URL ?? env.ISSUER_IP ?? readStateIp(cwd, 'issuer');
  const relayAddress = env.RELAY_URL ?? env.RELAY_IP ?? readStateIp(cwd, 'relay');
  if (!issuerAddress) throw missingEndpoint('issuer');
  if (!relayAddress) throw missingEndpoint('relay');

  const issuerUrl = httpsOrigin(issuerAddress, 'issuer');
  const relayUrl = httpsOrigin(relayAddress, 'relay');
  const relayAttestationPort = parsePort(env.RELAY_ATTESTATION_PORT ?? '8080');
  const relayIp = env.RELAY_IP?.trim() || readStateIp(cwd, 'relay') || new URL(relayUrl).hostname;
  const issuerIp = env.ISSUER_IP?.trim() || readStateIp(cwd, 'issuer') || new URL(issuerUrl).hostname;
  const relayAttestationUrl = env.RELAY_ATTESTATION_URL
    ? attestationOrigin(env.RELAY_ATTESTATION_URL, relayAttestationPort)
    : `http://${hostForUrl(new URL(relayUrl).hostname)}:${relayAttestationPort}/attestation`;

  return {
    issuerUrl,
    relayUrl,
    relayAttestationUrl,
    relayAttestationPort,
    issuerIp,
    relayIp,
    expectedJson,
    expected,
  };
}

/** Read current VM addresses when env/.state are absent. This only calls read-only gcloud describe. */
export async function resolveLiveConfig(
  env: Environment = process.env,
  cwd = process.cwd(),
  lookupVm: (role: 'issuer' | 'relay') => Promise<string | undefined> = lookupRunningVmIp,
): Promise<LiveDemoConfig> {
  const expectedJson = resolve(cwd, env.EXPECTED_JSON ?? 'infra/gcp/expected.json');
  const expected = readExpected(expectedJson, env);
  const issuerAddress = env.ISSUER_URL ?? env.ISSUER_IP ?? readStateIp(cwd, 'issuer') ?? await lookupVm('issuer');
  const relayAddress = env.RELAY_URL ?? env.RELAY_IP ?? readStateIp(cwd, 'relay') ?? await lookupVm('relay');
  if (!issuerAddress) throw missingEndpoint('issuer');
  if (!relayAddress) throw missingEndpoint('relay');

  const overlay = {
    ...env,
    ISSUER_URL: env.ISSUER_URL ?? asHttps(issuerAddress),
    RELAY_URL: env.RELAY_URL ?? asHttps(relayAddress),
  };
  return parseLiveConfig(overlay, cwd);
}

/** Best-effort config for preflight: one stopped VM must not hide checks for the other service or XRPL. */
export async function resolveLiveConfigForPreflight(
  env: Environment = process.env,
  cwd = process.cwd(),
  lookupVm: (role: 'issuer' | 'relay') => Promise<string | undefined> = lookupRunningVmIp,
): Promise<{ config: LiveDemoConfig; unavailable: Partial<Record<'issuer' | 'relay', string>> }> {
  const expectedJson = resolve(cwd, env.EXPECTED_JSON ?? 'infra/gcp/expected.json');
  readExpected(expectedJson, env);
  const unavailable: Partial<Record<'issuer' | 'relay', string>> = {};
  const addressFor = async (role: 'issuer' | 'relay'): Promise<string | undefined> => {
    const upper = role.toUpperCase();
    const configured = env[`${upper}_URL`] ?? env[`${upper}_IP`] ?? readStateIp(cwd, role);
    if (configured) return configured;
    try {
      const address = await lookupVm(role);
      if (address) return address;
      unavailable[role] = `${upper}_URL/IP is not set, infra/gcp/.state/${role}.ip is missing, and GCP VM discovery returned no IP. Set ${upper}_URL or run infra/gcp/deploy.sh ${role}.`;
    } catch (error) {
      unavailable[role] = error instanceof Error ? error.message : String(error);
    }
    return undefined;
  };
  const [issuerAddress, relayAddress] = await Promise.all([addressFor('issuer'), addressFor('relay')]);
  const overlay = {
    ...env,
    ISSUER_URL: env.ISSUER_URL ?? asHttps(issuerAddress ?? '127.0.0.1'),
    RELAY_URL: env.RELAY_URL ?? asHttps(relayAddress ?? '127.0.0.1'),
  };
  return { config: parseLiveConfig(overlay, cwd), unavailable };
}

export function createLiveVerifier(
  config: LiveDemoConfig,
  role: 'issuer' | 'relay',
  imageDigest = role === 'issuer' ? config.expected.issuerDigest : config.expected.relayDigest,
): AttestationVerifier {
  const policy: ConfidentialSpacePolicy = {
    imageDigest,
    audience: config.expected.audience,
    hwModels: config.expected.hwModels,
    requiredSupportAttribute: config.expected.requiredSupportAttribute,
  };
  return new ConfidentialSpaceVerifier(policy);
}

export function mismatchedDigest(digest: string): string {
  return `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`;
}

/** Read-only VM-state context for an unreachable endpoint or preflight failure. */
export async function vmAvailabilityHint(role: 'issuer' | 'relay'): Promise<string> {
  try {
    const ip = await lookupRunningVmIp(role);
    if (ip) return `GCP reports wraps-${role} RUNNING at ${ip}; check infra/gcp/status.sh ${role} and update ${role.toUpperCase()}_URL if the IP changed.`;
  } catch (error) {
    if (error instanceof LiveConfigError) return error.message;
    return error instanceof Error ? error.message : String(error);
  }
  return `Could not read the wraps-${role} VM state. If it is terminated, start with: gcloud --project=${GCP_PROJECT} compute instances start wraps-${role} --zone=${GCP_ZONE}. If it does not exist, run infra/gcp/deploy.sh ${role}.`;
}

function readExpected(path: string, env: Environment): LiveDemoConfig['expected'] {
  if (!existsSync(path)) throw new LiveConfigError(`Expected policy file not found: ${path}. Set EXPECTED_JSON or restore infra/gcp/expected.json.`);
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new LiveConfigError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const expected = {
    audience: raw.audience,
    hwModels: raw.hwModels,
    requiredSupportAttribute: raw.requiredSupportAttribute,
    issuerDigest: env.EXPECTED_ISSUER_DIGEST ?? raw.roles?.issuer?.imageDigest,
    relayDigest: env.EXPECTED_RELAY_DIGEST ?? raw.roles?.relay?.imageDigest,
  };
  if (!expected.audience || !Array.isArray(expected.hwModels) || !expected.hwModels.length || !expected.requiredSupportAttribute) {
    throw new LiveConfigError(`${path} is missing the Confidential Space audience, hwModels, or requiredSupportAttribute.`);
  }
  for (const role of ['issuer', 'relay'] as const) {
    const digest = expected[`${role}Digest`];
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new LiveConfigError(`${path} has no valid ${role} image digest. Set EXPECTED_${role.toUpperCase()}_DIGEST or run infra/gcp/build.sh ${role}.`, role);
    }
  }
  return expected;
}

function readStateIp(cwd: string, role: 'issuer' | 'relay'): string | undefined {
  const path = resolve(cwd, `infra/gcp/.state/${role}.ip`);
  if (!existsSync(path)) return undefined;
  const ip = readFileSync(path, 'utf8').trim();
  return ip || undefined;
}

function httpsOrigin(address: string, role: 'issuer' | 'relay'): string {
  const candidate = asHttps(address.trim());
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new LiveConfigError(`${role.toUpperCase()}_URL must be a valid HTTPS origin, got ${address}.`, role);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new LiveConfigError(`${role.toUpperCase()}_URL must be an HTTPS origin without credentials, path, query, or fragment.`, role);
  }
  if (role === 'issuer' && url.port) {
    throw new LiveConfigError('ISSUER_URL must use HTTPS port 443 because the attested relay only permits issuer CONNECT on port 443.', role);
  }
  return url.origin;
}

function attestationOrigin(value: string, defaultPort: number): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LiveConfigError(`RELAY_ATTESTATION_URL must be an HTTP(S) URL, got ${value}.`, 'relay');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new LiveConfigError('RELAY_ATTESTATION_URL must be an HTTP(S) URL without credentials or a fragment.', 'relay');
  }
  url.pathname = '/attestation';
  url.search = '';
  if (!url.port) url.port = String(defaultPort);
  return `${url.origin}/attestation`;
}

function asHttps(value: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LiveConfigError(`RELAY_ATTESTATION_PORT must be an integer from 1 to 65535, got ${value}.`, 'relay');
  }
  return port;
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function missingEndpoint(role: 'issuer' | 'relay'): LiveConfigError {
  const upper = role.toUpperCase();
  return new LiveConfigError(
    `${upper}_URL/IP is not set and infra/gcp/.state/${role}.ip is missing. Set ${upper}_URL or ${upper}_IP, or start the service with infra/gcp/deploy.sh ${role}.`,
    role,
  );
}

async function lookupRunningVmIp(role: 'issuer' | 'relay'): Promise<string | undefined> {
  const name = `wraps-${role}`;
  try {
    const { stdout } = await execFile('gcloud', [
      `--project=${GCP_PROJECT}`,
      'compute', 'instances', 'describe', name,
      `--zone=${GCP_ZONE}`,
      '--format=json(status,networkInterfaces[0].accessConfigs[0].natIP)',
    ], { timeout: 8_000, maxBuffer: 128 * 1024 });
    const description = JSON.parse(stdout) as { status?: string; networkInterfaces?: { accessConfigs?: { natIP?: string }[] }[] };
    const status = description.status ?? 'UNKNOWN';
    const ip = description.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
    if (status === 'RUNNING' && ip) return ip;
    if (status === 'TERMINATED' || status === 'SUSPENDED') {
      throw new LiveConfigError(
        `${role} VM ${name} is ${status}. Start it with: gcloud --project=${GCP_PROJECT} compute instances start ${name} --zone=${GCP_ZONE}. Then refresh ${role === 'issuer' ? 'ISSUER_URL' : 'RELAY_URL'} from its new external IP.`,
        role,
      );
    }
    if (status === 'STAGING') {
      throw new LiveConfigError(`${role} VM ${name} is still starting (STAGING). Check it with infra/gcp/status.sh ${role}, then retry npm run demo:live.`, role);
    }
    throw new LiveConfigError(`${role} VM ${name} is ${status} and has no usable external IP. Start or deploy it with infra/gcp/deploy.sh ${role}.`, role);
  } catch (error) {
    if (error instanceof LiveConfigError) throw error;
    return undefined;
  }
}
