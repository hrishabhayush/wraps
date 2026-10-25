// Google Cloud Confidential Space attestation.
//
// Inside the workload, the Confidential Space launcher serves a token endpoint on a
// Unix socket. The launcher collects the hardware evidence (AMD SEV on N2D), sends it
// to Google Cloud Attestation, and returns a signed OIDC JWT. The JWT names the
// container image digest, the OS image, the debug state, and echoes our nonces.
//
// Docs (read Oct 2026):
//   token request:  cloud.google.com/confidential-computing/confidential-space/docs/connect-external-resources
//   token claims:   cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims
//   images:         cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-images
//
// Binding: we send two nonces. nonce 1 is the client's nonce (hex). nonce 2 is
// hashPublicKeys() of the workload's keys (hex), so the token covers the exact keys
// the server hands out, including its TLS key.
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { hex } from './ed25519';
import {
  AttestationError,
  AttestationExpectations,
  AttestationProvider,
  AttestationVerifier,
  VerifiedAttestation,
} from './types';

export const CONFIDENTIAL_SPACE_FORMAT = 'gcp-confidential-space-v1';

/** Launcher socket and endpoint for Google Cloud Attestation tokens. */
export const TEE_SERVER_SOCKET = '/run/container_launcher/teeserver.sock';
export const TEE_TOKEN_PATH = '/v1/token';

/** Token issuer and OIDC discovery document for Google Cloud Attestation. */
export const GCP_ATTESTATION_ISSUER = 'https://confidentialcomputing.googleapis.com';
export const GCP_ATTESTATION_DISCOVERY = `${GCP_ATTESTATION_ISSUER}/.well-known/openid-configuration`;

/** Our custom audience. The docs forbid https://sts.google.com as a custom audience. */
export const DEFAULT_AUDIENCE = 'https://wraps.invalid/issuer';

/** Request limits from the docs: up to 6 nonces, each 10 to 74 bytes. */
const NONCE_MIN = 10;
const NONCE_MAX = 74;

/** dbgstat value for a production image. A debug image reports "enabled". */
export const DBGSTAT_PRODUCTION = 'disabled-since-boot';
export const SWNAME_CONFIDENTIAL_SPACE = 'CONFIDENTIAL_SPACE';

/** Nonce strings sent to the launcher. Exported so the verifier and tests share one convention. */
export function confidentialSpaceNonces(clientNonce: Uint8Array, publicKeysHash: Uint8Array): [string, string] {
  const n1 = hex(clientNonce);
  const n2 = hex(publicKeysHash);
  for (const n of [n1, n2]) {
    if (n.length < NONCE_MIN || n.length > NONCE_MAX) {
      throw new AttestationError('MALFORMED', `nonce must hex-encode to ${NONCE_MIN}..${NONCE_MAX} chars (client nonce 5 to 37 bytes)`);
    }
  }
  return [n1, n2];
}

export interface ConfidentialSpaceProviderOptions {
  audience?: string;
  socketPath?: string;
}

/** Workload side: asks the launcher for a token that binds the client nonce and our keys. */
export class ConfidentialSpaceProvider implements AttestationProvider {
  readonly format = CONFIDENTIAL_SPACE_FORMAT;
  private readonly audience: string;
  private readonly socketPath: string;

  constructor(opts: ConfidentialSpaceProviderOptions = {}) {
    this.audience = opts.audience ?? DEFAULT_AUDIENCE;
    this.socketPath = opts.socketPath ?? TEE_SERVER_SOCKET;
  }

  async attest(nonce: Uint8Array, publicKeysHash: Uint8Array): Promise<string> {
    const body = JSON.stringify({
      audience: this.audience,
      token_type: 'OIDC',
      nonces: confidentialSpaceNonces(nonce, publicKeysHash),
    });
    const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: TEE_TOKEN_PATH,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('launcher token request timed out')));
      req.on('error', reject);
      req.end(body);
    });
    if (status !== 200) throw new Error(`launcher returned HTTP ${status}: ${text.slice(0, 200)}`);
    const token = text.trim();
    if (token.split('.').length !== 3) throw new Error('launcher did not return a JWT');
    return token;
  }
}

/** What the SDK expects from the deployed workload (infra/gcp/expected.json). */
export interface ConfidentialSpacePolicy {
  /** Container image digest, "sha256:<64 hex>". */
  imageDigest: string;
  audience: string;
  /** Accepted hwmodel values, e.g. ["GCP_AMD_SEV"]. */
  hwModels: string[];
  /** Support attribute the OS image must carry. Google recommends "STABLE". */
  requiredSupportAttribute: string;
}

export interface ConfidentialSpaceVerifierOptions extends ConfidentialSpacePolicy {
  /** Key set. Defaults to Google's JWKS, found through the OIDC discovery document. */
  keys?: JWTVerifyGetKey;
  issuer?: string;
  /** Refuse tokens issued longer ago than this. Default 5 minutes. */
  maxAgeMs?: number;
  /** Clock skew allowance for exp / nbf / iat. Default 30 s. */
  clockToleranceSec?: number;
}

interface CsClaims extends JWTPayload {
  eat_nonce?: string | string[];
  hwmodel?: string;
  swname?: string;
  swversion?: string[];
  dbgstat?: string;
  secboot?: boolean;
  submods?: {
    container?: { image_digest?: string; image_reference?: string };
    confidential_space?: { support_attributes?: string[] };
    gce?: { instance_id?: string; instance_name?: string; project_id?: string; zone?: string };
  };
}

/** The decoded, verified token, for display. */
export interface ConfidentialSpaceDetails {
  hwmodel: string;
  swname: string;
  swversion: string[];
  dbgstat: string;
  supportAttributes: string[];
  imageDigest: string;
  imageReference?: string;
  instance?: string;
  issuedAt: number;
  expiresAt: number;
}

export type VerifiedConfidentialSpace = VerifiedAttestation & { details: ConfidentialSpaceDetails };

let googleKeys: JWTVerifyGetKey | undefined;

/** Google's JWKS, located through the issuer's discovery document. Cached per process. */
export function googleAttestationKeys(): JWTVerifyGetKey {
  if (googleKeys) return googleKeys;
  let remote: JWTVerifyGetKey | undefined;
  const lazy: JWTVerifyGetKey = async (header, token) => {
    if (!remote) {
      const res = await fetch(GCP_ATTESTATION_DISCOVERY);
      if (!res.ok) throw new AttestationError('BAD_CHAIN', `discovery returned HTTP ${res.status}`);
      const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
      if (doc.issuer !== GCP_ATTESTATION_ISSUER || !doc.jwks_uri?.startsWith('https://')) {
        throw new AttestationError('BAD_CHAIN', 'unexpected discovery document');
      }
      remote = createRemoteJWKSet(new URL(doc.jwks_uri));
    }
    return remote(header, token);
  };
  googleKeys = lazy;
  return lazy;
}

/** SDK side: every check from SPEC §12, against a Google-signed token. */
export class ConfidentialSpaceVerifier implements AttestationVerifier {
  readonly format = CONFIDENTIAL_SPACE_FORMAT;
  private readonly seenNonces = new Set<string>();

  constructor(private readonly opts: ConfidentialSpaceVerifierOptions) {
    if (!/^sha256:[0-9a-f]{64}$/.test(opts.imageDigest)) throw new Error('imageDigest must be "sha256:<64 hex>"');
    if (!opts.audience) throw new Error('audience required');
    if (!opts.hwModels?.length) throw new Error('hwModels required');
  }

  async verify(attestation: string, expect: AttestationExpectations): Promise<VerifiedConfidentialSpace> {
    const o = this.opts;
    // 1. Signature (Google's key), issuer, audience, expiry. RS256 only.
    let claims: CsClaims;
    try {
      const r = await jwtVerify(attestation, o.keys ?? googleAttestationKeys(), {
        issuer: o.issuer ?? GCP_ATTESTATION_ISSUER,
        audience: o.audience,
        algorithms: ['RS256'],
        clockTolerance: o.clockToleranceSec ?? 30,
        requiredClaims: ['exp', 'iat'],
      });
      claims = r.payload as CsClaims;
    } catch (e) {
      throw mapJoseError(e);
    }

    // 2. Hardware and OS: a Confidential VM running the Confidential Space image, secure boot on.
    if (!claims.hwmodel || !o.hwModels.includes(claims.hwmodel)) {
      throw new AttestationError('BAD_PLATFORM', `hwmodel ${claims.hwmodel} is not one of ${o.hwModels.join(', ')}`);
    }
    if (claims.swname !== SWNAME_CONFIDENTIAL_SPACE) {
      throw new AttestationError('BAD_PLATFORM', `swname ${claims.swname} (a revoked image reports GCE)`);
    }
    if (claims.secboot !== true) throw new AttestationError('BAD_PLATFORM', 'secure boot is off');

    // 3. Debug: the debug image lets the operator SSH in as root.
    if (claims.dbgstat !== DBGSTAT_PRODUCTION) {
      throw new AttestationError('DEBUG_MODE', `dbgstat is "${claims.dbgstat}", need "${DBGSTAT_PRODUCTION}" (production image)`);
    }
    const support = claims.submods?.confidential_space?.support_attributes ?? [];
    if (!support.includes(o.requiredSupportAttribute)) {
      throw new AttestationError('BAD_PLATFORM', `image support attributes [${support.join(', ')}] lack ${o.requiredSupportAttribute}`);
    }

    // 4. Code: the exact container image we published.
    const digest = claims.submods?.container?.image_digest ?? '';
    if (digest !== o.imageDigest) {
      throw new AttestationError('IMAGE_MISMATCH', `image digest ${digest || '(none)'} is not the published build ${o.imageDigest}`);
    }

    // 5. Nonces: [client nonce, key hash], in that order.
    const nonces = typeof claims.eat_nonce === 'string' ? [claims.eat_nonce] : (claims.eat_nonce ?? []);
    const [wantNonce, wantKeys] = confidentialSpaceNonces(expect.nonce, expect.publicKeysHash);
    if (nonces.length !== 2) throw new AttestationError('NONCE_MISMATCH', `expected 2 nonces, got ${nonces.length}`);
    if (nonces[1] !== wantKeys) throw new AttestationError('KEY_MISMATCH', 'public keys do not match the keys in the attestation');
    if (nonces[0] !== wantNonce) throw new AttestationError('NONCE_MISMATCH', 'nonce does not match');
    if (this.seenNonces.has(wantNonce)) throw new AttestationError('NONCE_REUSED', 'nonce was already used');

    // 6. Freshness beyond exp: the token must be recent.
    const issuedAtMs = (claims.iat ?? 0) * 1000;
    const age = Date.now() - issuedAtMs;
    if (age > (o.maxAgeMs ?? 5 * 60_000) || age < -60_000) throw new AttestationError('STALE', `token age ${age} ms`);
    this.seenNonces.add(wantNonce);

    const gce = claims.submods?.gce;
    return {
      format: CONFIDENTIAL_SPACE_FORMAT,
      moduleId: gce?.instance_id ?? claims.sub ?? 'unknown',
      timestamp: issuedAtMs,
      pcrs: {},
      measurement: digest,
      publicKeysHash: wantKeys,
      nonce: wantNonce,
      details: {
        hwmodel: claims.hwmodel,
        swname: claims.swname,
        swversion: claims.swversion ?? [],
        dbgstat: claims.dbgstat,
        supportAttributes: support,
        imageDigest: digest,
        imageReference: claims.submods?.container?.image_reference,
        instance: gce ? `${gce.project_id}/${gce.zone}/${gce.instance_name}` : undefined,
        issuedAt: issuedAtMs,
        expiresAt: (claims.exp ?? 0) * 1000,
      },
    };
  }
}

function mapJoseError(e: unknown): AttestationError {
  if (e instanceof AttestationError) return e;
  const msg = (e as Error)?.message ?? String(e);
  if (e instanceof joseErrors.JWTExpired) return new AttestationError('STALE', msg);
  if (e instanceof joseErrors.JWTClaimValidationFailed) {
    if (e.claim === 'iss') return new AttestationError('BAD_ISSUER', msg);
    if (e.claim === 'aud') return new AttestationError('BAD_AUDIENCE', msg);
    return new AttestationError('STALE', msg);
  }
  if (e instanceof joseErrors.JWSSignatureVerificationFailed) return new AttestationError('BAD_SIGNATURE', msg);
  if (e instanceof joseErrors.JWKSNoMatchingKey) return new AttestationError('BAD_CHAIN', `no Google key matches the token: ${msg}`);
  if (e instanceof joseErrors.JOSEAlgNotAllowed) return new AttestationError('BAD_SIGNATURE', msg);
  return new AttestationError('MALFORMED', msg);
}

/** infra/gcp/expected.json: shared policy plus one image per role. */
export interface ExpectedFile {
  audience: string;
  hwModels: string[];
  requiredSupportAttribute: string;
  roles: Record<string, { imageDigest: string; imageReference?: string }>;
}

export function loadConfidentialSpacePolicy(path: string, role: 'issuer' | 'relay'): ConfidentialSpacePolicy {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ExpectedFile;
  const r = raw.roles?.[role];
  if (!r?.imageDigest) throw new Error(`${path} has no imageDigest for ${role}. Run infra/gcp/build.sh ${role}.`);
  return {
    imageDigest: r.imageDigest,
    audience: raw.audience,
    hwModels: raw.hwModels,
    requiredSupportAttribute: raw.requiredSupportAttribute,
  };
}
