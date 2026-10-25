import { isIP } from 'node:net';
import { AttestationError, type ConfidentialSpaceDetails, type VerifiedAttestation } from '@wraps/attestation';
import { ResearchAgent, DEMO_TASKS } from '@wraps/agent';
import { MockTopUpWallet, PrivatePayClient, createPinnedRelayTransport } from '@wraps/sdk';
import { createLiveVerifier, mismatchedDigest, parseLiveConfig } from '../../../scripts/live-config';

type WorkerFrame =
  | { type: 'event'; name: string; data: unknown }
  | { type: 'result'; fallbackAvailable: boolean };

function send(frame: WorkerFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function publish(name: string, data: unknown = null): void {
  send({ type: 'event', name, data });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAvailabilityFailure(error: unknown): boolean {
  if (error instanceof AttestationError) {
    return error.code === 'MALFORMED' && /request failed|HTTP 5\d\d|timed out|fetch failed|ECONN|EHOSTUNREACH|ENETUNREACH|socket/i.test(error.message);
  }
  return /fetch failed|ECONN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timed out|still starting/i.test(errorText(error));
}

function verificationSummary(role: 'Issuer' | 'Relay', attestation: VerifiedAttestation, digest: string, keyPinned: boolean) {
  const details = (attestation as VerifiedAttestation & { details?: ConfidentialSpaceDetails }).details;
  return {
    title: `${role} Confidential Space attestation verified`,
    passed: attestation.measurement === digest && keyPinned,
    checks: [
      { name: 'hwmodel', value: details?.hwmodel ?? 'unavailable', expected: 'GCP_AMD_SEV', passed: details?.hwmodel === 'GCP_AMD_SEV' },
      { name: 'swname', value: details?.swname ?? 'unavailable', expected: 'CONFIDENTIAL_SPACE', passed: details?.swname === 'CONFIDENTIAL_SPACE' },
      { name: 'dbgstat', value: details?.dbgstat ?? 'unavailable', expected: 'disabled-since-boot', passed: details?.dbgstat === 'disabled-since-boot' },
      { name: 'image digest', value: attestation.measurement, expected: digest, passed: attestation.measurement === digest },
      { name: 'TLS key pinned', value: keyPinned ? 'yes' : 'no', expected: 'yes', passed: keyPinned },
    ],
  };
}

async function run(): Promise<boolean> {
  const config = parseLiveConfig(process.env);
  const relayIp = new URL(config.relayUrl).hostname.replace(/^\[|\]$/g, '');
  const issuerIp = new URL(config.issuerUrl).hostname.replace(/^\[|\]$/g, '');
  if (isIP(relayIp) !== 4 || isIP(issuerIp) !== 4 || relayIp !== process.env.WRAPS_RELAY_IP) {
    throw new Error('worker requires numeric IPv4 issuer and relay URLs matching its egress allowlist');
  }
  const merchantUrl = process.env.DEMO_MERCHANT_URL;
  if (!merchantUrl) throw new Error('worker requires DEMO_MERCHANT_URL');
  const merchant = new URL(merchantUrl);
  if (merchant.protocol !== 'https:' || merchant.username || merchant.password || merchant.hash) {
    throw new Error('DEMO_MERCHANT_URL must be an HTTPS URL without credentials or a fragment');
  }

  const tamper = process.env.DEMO_TAMPER === '1';
  const relay = await createPinnedRelayTransport({
    relayUrl: config.relayUrl,
    issuerUrl: config.issuerUrl,
    attestationUrl: config.relayAttestationUrl,
    verifier: createLiveVerifier(config, 'relay'),
  });
  try {
    publish('attestation-verification', verificationSummary(
      'Relay', relay.relay.attestation, config.expected.relayDigest, relay.relay.tunnelKey.byteLength > 0,
    ));
    publish('step', { message: 'Connecting to the issuer through the pinned relay.' });
    const issuerDigest = tamper ? mismatchedDigest(config.expected.issuerDigest) : config.expected.issuerDigest;
    const sdk = new PrivatePayClient({
      issuerUrl: config.issuerUrl,
      verifier: createLiveVerifier(config, 'issuer', issuerDigest),
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
          title: 'Relay TLS connection verified', passed: true,
          checks: [{ name: 'TLS key pinned', value: 'yes; live issuer response arrived over the attested relay certificate', expected: 'yes', passed: true }],
        });
        publish('tamper-refused', {
          code: error.code, expectedDigest: issuerDigest,
          message: `Live issuer refused the deliberately wrong expected digest (${issuerDigest}). ${error.message}`,
        });
        return false;
      }
      throw error;
    }
    publish('attestation-verification', {
      title: 'Relay TLS connection verified', passed: true,
      checks: [{ name: 'TLS key pinned', value: 'yes; issuer CONNECT succeeded over the attested relay certificate', expected: 'yes', passed: true }],
    });
    publish('attestation-verification', verificationSummary(
      'Issuer', attested.attestation, config.expected.issuerDigest, Boolean(attested.tlsKey),
    ));
    if (tamper) throw new Error('The live issuer accepted the deliberately wrong expected digest. Tamper verification failed.');

    publish('step', { message: 'Top-up: requesting 20 blind tokens from the verified issuer. The demo wallet uses the mock rail; AP4M is skipped.' });
    await sdk.topUp(20);
    const results = await new ResearchAgent({
      sdk,
      merchantUrl: merchantUrl.replace(/\/$/, ''),
      print: (message) => publish('reasoning', { message }),
    }).run([DEMO_TASKS[0]]);
    if (!results.some((result) => result.bought.length > 0)) throw new Error('No merchant purchase completed through the relay.');
    publish('complete', { message: 'Live issuer and relay verified; the research purchase ran through the attested relay. AP4M top-up was skipped; mock rail used.' });
    return false;
  } finally {
    await relay.close();
  }
}

try {
  const fallbackAvailable = await run();
  send({ type: 'result', fallbackAvailable });
} catch (error) {
  const detail = errorText(error);
  if (isAvailabilityFailure(error)) {
    publish('live-unavailable', {
      message: `Live demo unavailable inside the isolated agent container: ${detail}\nNo local run is being presented as live. Select “Run local mock” to continue with mock attestation and local services.`,
      detail,
    });
    send({ type: 'result', fallbackAvailable: true });
  } else {
    publish('live-refused', {
      message: `Live verification failed inside the isolated agent container: ${detail}\nNo top-up or purchase was sent after the verification refusal.`,
      detail,
    });
    send({ type: 'result', fallbackAvailable: false });
  }
}
