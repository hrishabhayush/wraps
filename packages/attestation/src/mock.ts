// MOCK attestation. It mimics the shape and the checks of an AWS Nitro
// attestation, but the "AWS root" is a local Ed25519 key. It proves nothing
// about real hardware. Use it for tests and for the no-enclave fallback (INF-24).
import {
  Ed25519KeyPair,
  b64u,
  ed25519FromSeed,
  ed25519Sign,
  ed25519Verify,
  fromB64u,
  generateEd25519,
  hex,
  sha256,
  sha384,
} from './ed25519';
import {
  AttestationError,
  AttestationExpectations,
  AttestationProvider,
  AttestationVerifier,
  Pcrs,
  VerifiedAttestation,
  isAllZero,
} from './types';

export const MOCK_FORMAT = 'mock-nitro-v1';
const CERT_CONTEXT = 'wraps-mock-cert-v1';
const DOC_CONTEXT = 'wraps-mock-doc-v1';

/** Not a secret. Every process derives the same mock root from it, so they agree without config. */
export const DEFAULT_MOCK_ROOT_SEED = 'wraps-mock-attestation-root-dev-only';

export function mockRootKey(seed = process.env.MOCK_ATTESTATION_ROOT_SEED ?? DEFAULT_MOCK_ROOT_SEED): Ed25519KeyPair {
  return ed25519FromSeed(sha256(seed));
}

/** A fake but stable PCR value for a named build, e.g. mockPcr('issuer-v1'). */
export function mockPcr(buildName: string): string {
  return hex(sha384(`wraps-build:${buildName}`));
}

export const ZERO_PCR = '0'.repeat(96);

/** PCRs a mock enclave reports. debug=true gives all zeros, like Nitro debug mode. */
export function mockPcrs(buildName: string, debug = false): Pcrs {
  if (debug) return { '0': ZERO_PCR, '1': ZERO_PCR, '2': ZERO_PCR };
  return { '0': mockPcr(`${buildName}:pcr0`), '1': mockPcr('kernel:pcr1'), '2': mockPcr(`${buildName}:pcr2`) };
}

interface MockDocument {
  moduleId: string;
  digest: 'SHA384';
  timestamp: number;
  pcrs: Pcrs;
  userData: string;
  nonce: string;
}

interface MockEnvelope {
  format: typeof MOCK_FORMAT;
  /** Leaf "certificate": the enclave's signing key, signed by the root. */
  certificate: { publicKey: string; signature: string };
  document: string;
  signature: string;
}

export interface MockProviderOptions {
  /** Build name that determines PCR0 and PCR2. Change it to simulate a modified issuer. */
  buildName: string;
  debug?: boolean;
  pcrs?: Pcrs;
  root?: Ed25519KeyPair;
  moduleId?: string;
}

export class MockAttestationProvider implements AttestationProvider {
  readonly format = MOCK_FORMAT;
  private readonly leaf = generateEd25519();
  private readonly certificate: MockEnvelope['certificate'];
  private readonly pcrs: Pcrs;

  constructor(private readonly opts: MockProviderOptions) {
    const root = opts.root ?? mockRootKey();
    const certSig = ed25519Sign(root.privateKey, concat(CERT_CONTEXT, this.leaf.publicKeyBytes));
    this.certificate = { publicKey: b64u(this.leaf.publicKeyBytes), signature: b64u(certSig) };
    this.pcrs = opts.pcrs ?? mockPcrs(opts.buildName, opts.debug);
  }

  async attest(nonce: Uint8Array, publicKeysHash: Uint8Array): Promise<string> {
    const doc: MockDocument = {
      moduleId: this.opts.moduleId ?? 'i-mock-enc0000000000000',
      digest: 'SHA384',
      timestamp: Date.now(),
      pcrs: this.pcrs,
      userData: hex(publicKeysHash),
      nonce: hex(nonce),
    };
    const docBytes = new TextEncoder().encode(JSON.stringify(doc));
    const sig = ed25519Sign(this.leaf.privateKey, concat(DOC_CONTEXT, docBytes));
    const env: MockEnvelope = { format: MOCK_FORMAT, certificate: this.certificate, document: b64u(docBytes), signature: b64u(sig) };
    return b64u(new TextEncoder().encode(JSON.stringify(env)));
  }
}

export interface MockVerifierOptions {
  /** Expected PCR values by index. PCR0 is required. */
  expectedPcrs: Pcrs;
  /** Root public key (SPKI). Defaults to the shared mock root. */
  rootPublicKey?: Uint8Array;
  /** Reject documents older than this. Default 5 minutes. */
  maxAgeMs?: number;
}

/** Runs the same checks a real Nitro verifier runs, against the mock root. */
export class MockAttestationVerifier implements AttestationVerifier {
  readonly format = MOCK_FORMAT;
  private readonly seenNonces = new Set<string>();
  private readonly rootPublicKey: Uint8Array;

  constructor(private readonly opts: MockVerifierOptions) {
    if (!opts.expectedPcrs['0']) throw new Error('expectedPcrs must include PCR0');
    this.rootPublicKey = opts.rootPublicKey ?? mockRootKey().publicKeyBytes;
  }

  async verify(attestation: string, expect: AttestationExpectations): Promise<VerifiedAttestation> {
    let env: MockEnvelope;
    let doc: MockDocument;
    let docBytes: Uint8Array;
    try {
      env = JSON.parse(new TextDecoder().decode(fromB64u(attestation)));
      if (env.format !== MOCK_FORMAT) throw new Error(`format ${env.format}`);
      docBytes = fromB64u(env.document);
      doc = JSON.parse(new TextDecoder().decode(docBytes));
    } catch (e) {
      throw new AttestationError('MALFORMED', (e as Error).message);
    }

    // 1. Certificate chain: leaf signed by the root.
    const leafKey = fromB64u(env.certificate.publicKey);
    if (!ed25519Verify(this.rootPublicKey, concat(CERT_CONTEXT, leafKey), fromB64u(env.certificate.signature))) {
      throw new AttestationError('BAD_CHAIN', 'certificate does not chain to the trusted root');
    }
    // 2. Document signature by the leaf.
    if (!ed25519Verify(leafKey, concat(DOC_CONTEXT, docBytes), fromB64u(env.signature))) {
      throw new AttestationError('BAD_SIGNATURE', 'document signature is invalid');
    }
    // 3. Debug mode: all-zero PCRs.
    for (const i of ['0', '1', '2']) {
      if (doc.pcrs[i] === undefined || isAllZero(doc.pcrs[i])) {
        throw new AttestationError('DEBUG_MODE', `PCR${i} is all zeros (debug-mode enclave)`);
      }
    }
    // 4. Code hash.
    for (const [i, want] of Object.entries(this.opts.expectedPcrs)) {
      if ((doc.pcrs[i] ?? '').toLowerCase() !== want.toLowerCase()) {
        throw new AttestationError('PCR_MISMATCH', `PCR${i} does not match the published build`);
      }
    }
    // 5. Keys.
    if (doc.userData !== hex(expect.publicKeysHash)) {
      throw new AttestationError('KEY_MISMATCH', 'public keys do not match the keys in the attestation');
    }
    // 6. Nonce: must be ours, and never accepted before.
    if (doc.nonce !== hex(expect.nonce)) throw new AttestationError('NONCE_MISMATCH', 'nonce does not match');
    if (this.seenNonces.has(doc.nonce)) throw new AttestationError('NONCE_REUSED', 'nonce was already used');
    // 7. Freshness.
    const age = Date.now() - doc.timestamp;
    if (age > (this.opts.maxAgeMs ?? 5 * 60_000) || age < -60_000) {
      throw new AttestationError('STALE', `document age ${age} ms`);
    }
    this.seenNonces.add(doc.nonce);

    return {
      format: MOCK_FORMAT,
      moduleId: doc.moduleId,
      timestamp: doc.timestamp,
      pcrs: doc.pcrs,
      measurement: doc.pcrs['0'],
      publicKeysHash: doc.userData,
      nonce: doc.nonce,
    };
  }
}

function concat(context: string, data: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(context), Buffer.from([0]), Buffer.from(data)]));
}
