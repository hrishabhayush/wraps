import { readFileSync } from 'node:fs';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { CONFIDENTIAL_SPACE_FORMAT } from './confidential-space';
import { AttestationError, type AttestationExpectations, type AttestationVerifier, type VerifiedAttestation } from './types';

export const GCP_ATTESTATION_ISSUER = 'https://confidentialcomputing.googleapis.com';
export const GCP_ATTESTATION_DISCOVERY = `${GCP_ATTESTATION_ISSUER}/.well-known/openid-configuration`;
export const CONFIDENTIAL_SPACE_IMAGE_NAME = 'CONFIDENTIAL_SPACE';
export const CONFIDENTIAL_SPACE_PRODUCTION_DEBUG_STATUS = 'disabled-since-boot';
export const DEFAULT_CONFIDENTIAL_SPACE_SUPPORT_ATTRIBUTE = 'STABLE';

const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_CLOCK_TOLERANCE_SEC = 30;
const SHA256_BYTES = 32;
const MAX_SEEN_NONCES = 100_000;

export interface ConfidentialSpacePolicy {
  /** Published workload image digest, in `sha256:<64 lowercase hex>` form. */
  imageDigest: string;
  /** Custom audience requested by the workload attestation provider. */
  audience: string;
  /** Allowed AMD SEV hardware model identifiers. */
  hwModels: string[];
  /** Required Confidential Space image support attribute, normally `STABLE`. */
  requiredSupportAttribute?: string;
}

export interface ConfidentialSpaceVerifierOptions extends ConfidentialSpacePolicy {
  /** Override Google's remote JWKS in tests; production uses OIDC discovery. */
  keys?: JWTVerifyGetKey;
  issuer?: string;
  /** Reject tokens older than this, even when their `exp` claim is still valid. */
  maxAgeMs?: number;
  /** JWT expiry/not-before clock skew allowance. Defaults to 30 seconds. */
  clockToleranceSec?: number;
  /** Injectable clock for deterministic freshness tests. */
  now?: () => number;
}

export interface ExpectedConfidentialSpaceFile {
  audience: string;
  hwModels: string[];
  requiredSupportAttribute?: string;
  roles: Record<string, { imageDigest: string; imageReference?: string }>;
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

/**
 * Hex-encode both values because Google echoes each nonce as a string in
 * `eat_nonce`. The verifier and workload provider must use this same encoding.
 */
export function confidentialSpaceNonces(clientNonce: Uint8Array, publicKeysHash: Uint8Array): [string, string] {
  if (publicKeysHash.byteLength !== SHA256_BYTES) {
    throw new AttestationError('MALFORMED', `public key hash must be ${SHA256_BYTES} bytes`);
  }
  const pair: [string, string] = [toHexNonce(clientNonce, 'client nonce'), toHexNonce(publicKeysHash, 'public key hash')];
  return pair;
}

/**
 * Parse the shared infra/gcp/expected.json policy for one workload role.
 * The file records digests after Cloud Build pushes the pinned image.
 */
export function loadConfidentialSpacePolicy(path: string, role: 'issuer' | 'relay'): ConfidentialSpacePolicy {
  let raw: ExpectedConfidentialSpaceFile;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as ExpectedConfidentialSpaceFile;
  } catch {
    throw new Error(`could not read Confidential Space policy file ${path}`);
  }
  const imageDigest = raw.roles?.[role]?.imageDigest;
  if (!imageDigest) throw new Error(`${path} has no imageDigest for ${role}. Build and publish the ${role} image first.`);
  return {
    imageDigest,
    audience: raw.audience,
    hwModels: raw.hwModels,
    requiredSupportAttribute: raw.requiredSupportAttribute ?? DEFAULT_CONFIDENTIAL_SPACE_SUPPORT_ATTRIBUTE,
  };
}

let googleKeys: JWTVerifyGetKey | undefined;

/** Resolve Google's signing JWKS through its OIDC discovery document once per process. */
export function googleAttestationKeys(): JWTVerifyGetKey {
  if (googleKeys) return googleKeys;
  let remote: JWTVerifyGetKey | undefined;
  const lazy: JWTVerifyGetKey = async (header, token) => {
    if (!remote) {
      let response: Response;
      try {
        response = await fetch(GCP_ATTESTATION_DISCOVERY);
      } catch {
        throw new AttestationError('BAD_CHAIN', 'could not fetch Google attestation OIDC discovery document');
      }
      if (!response.ok) throw new AttestationError('BAD_CHAIN', `Google discovery returned HTTP ${response.status}`);
      const document = (await response.json()) as { issuer?: string; jwks_uri?: string };
      if (document.issuer !== GCP_ATTESTATION_ISSUER || !document.jwks_uri) {
        throw new AttestationError('BAD_CHAIN', 'Google discovery document has unexpected issuer or no jwks_uri');
      }
      const jwksUrl = new URL(document.jwks_uri);
      if (jwksUrl.protocol !== 'https:') throw new AttestationError('BAD_CHAIN', 'Google jwks_uri must use HTTPS');
      remote = createRemoteJWKSet(jwksUrl);
    }
    return remote(header, token);
  };
  googleKeys = lazy;
  return lazy;
}

/** Verifies a Google-signed Confidential Space OIDC token and its workload claims. */
export class ConfidentialSpaceVerifier implements AttestationVerifier {
  readonly format = CONFIDENTIAL_SPACE_FORMAT;
  private readonly seenNonces = new Set<string>();
  private readonly maxAgeMs: number;
  private readonly clockToleranceSec: number;
  private readonly requiredSupportAttribute: string;
  private readonly now: () => number;

  constructor(private readonly options: ConfidentialSpaceVerifierOptions) {
    if (!/^sha256:[0-9a-f]{64}$/.test(options.imageDigest)) {
      throw new TypeError('imageDigest must be sha256 followed by 64 lowercase hex characters');
    }
    if (!options.audience || Buffer.byteLength(options.audience, 'utf8') > 512) {
      throw new TypeError('audience must be a non-empty string of at most 512 bytes');
    }
    if (!options.hwModels.length || options.hwModels.some((model) => !/^GCP_AMD_SEV(?:_ES)?$/.test(model))) {
      throw new TypeError('hwModels must contain one or more GCP AMD SEV model identifiers');
    }
    this.requiredSupportAttribute = options.requiredSupportAttribute ?? DEFAULT_CONFIDENTIAL_SPACE_SUPPORT_ATTRIBUTE;
    if (!this.requiredSupportAttribute) throw new TypeError('requiredSupportAttribute must not be empty');
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (!Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1) throw new RangeError('maxAgeMs must be a positive integer');
    this.clockToleranceSec = options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
    if (!Number.isSafeInteger(this.clockToleranceSec) || this.clockToleranceSec < 0) {
      throw new RangeError('clockToleranceSec must be a non-negative integer');
    }
    this.now = options.now ?? Date.now;
  }

  async verify(attestation: string, expect: AttestationExpectations): Promise<VerifiedConfidentialSpace> {
    const [expectedNonce, expectedKeysHash] = confidentialSpaceNonces(expect.nonce, expect.publicKeysHash);
    const currentTime = new Date(this.now());
    let claims: CsClaims;
    try {
      const result = await jwtVerify(attestation, this.options.keys ?? googleAttestationKeys(), {
        issuer: this.options.issuer ?? GCP_ATTESTATION_ISSUER,
        audience: this.options.audience,
        algorithms: ['RS256'],
        clockTolerance: this.clockToleranceSec,
        currentDate: currentTime,
        requiredClaims: ['exp', 'iat'],
      });
      claims = result.payload as CsClaims;
    } catch (error) {
      throw mapJoseError(error);
    }

    if (!claims.hwmodel || !this.options.hwModels.includes(claims.hwmodel)) {
      throw new AttestationError('BAD_PLATFORM', `hardware model ${claims.hwmodel ?? '(missing)'} is not allowed`);
    }
    if (claims.swname !== CONFIDENTIAL_SPACE_IMAGE_NAME) {
      throw new AttestationError('BAD_PLATFORM', `software image ${claims.swname ?? '(missing)'} is not Confidential Space`);
    }
    if (claims.secboot !== true) throw new AttestationError('BAD_PLATFORM', 'secure boot is not enabled');
    if (claims.dbgstat !== CONFIDENTIAL_SPACE_PRODUCTION_DEBUG_STATUS) {
      throw new AttestationError('DEBUG_MODE', `debug status ${claims.dbgstat ?? '(missing)'} is not production`);
    }

    const supportAttributes = claims.submods?.confidential_space?.support_attributes;
    if (!Array.isArray(supportAttributes) || supportAttributes.some((value) => typeof value !== 'string')) {
      throw new AttestationError('BAD_PLATFORM', 'Confidential Space support attributes are missing or malformed');
    }
    if (!supportAttributes.includes(this.requiredSupportAttribute)) {
      throw new AttestationError('BAD_PLATFORM', `image lacks support attribute ${this.requiredSupportAttribute}`);
    }

    const imageDigest = claims.submods?.container?.image_digest;
    if (imageDigest !== this.options.imageDigest) {
      throw new AttestationError('IMAGE_MISMATCH', `image digest ${imageDigest ?? '(missing)'} is not the expected workload image`);
    }

    const nonceClaims = typeof claims.eat_nonce === 'string' ? [claims.eat_nonce] : claims.eat_nonce;
    if (!Array.isArray(nonceClaims) || nonceClaims.length !== 2) {
      throw new AttestationError('NONCE_MISMATCH', 'expected the client nonce and public key hash in eat_nonce');
    }
    if (nonceClaims[0] !== expectedNonce) throw new AttestationError('NONCE_MISMATCH', 'client nonce does not match');
    if (nonceClaims[1] !== expectedKeysHash) throw new AttestationError('KEY_MISMATCH', 'attested public key hash does not match');

    const nonceKey = nonceClaims[0];
    if (this.seenNonces.has(nonceKey)) throw new AttestationError('NONCE_REUSED', 'client nonce was already accepted');
    if (this.seenNonces.size >= MAX_SEEN_NONCES) {
      throw new AttestationError('STALE', 'attestation replay cache is full; verifier must be restarted');
    }

    const issuedAt = (claims.iat ?? 0) * 1000;
    const age = currentTime.getTime() - issuedAt;
    if (age > this.maxAgeMs || age < -(this.clockToleranceSec * 1000)) {
      throw new AttestationError('STALE', `token age ${age}ms is outside the allowed window`);
    }
    this.seenNonces.add(nonceKey);

    const gce = claims.submods?.gce;
    return {
      format: this.format,
      moduleId: gce?.instance_id ?? claims.sub ?? 'unknown',
      timestamp: issuedAt,
      pcrs: {},
      publicKeysHash: expectedKeysHash,
      nonce: expectedNonce,
      details: {
        hwmodel: claims.hwmodel,
        swname: claims.swname,
        swversion: Array.isArray(claims.swversion) ? claims.swversion : [],
        dbgstat: claims.dbgstat,
        supportAttributes,
        imageDigest,
        imageReference: claims.submods?.container?.image_reference,
        instance: gce ? `${gce.project_id ?? ''}/${gce.zone ?? ''}/${gce.instance_name ?? ''}` : undefined,
        issuedAt,
        expiresAt: (claims.exp ?? 0) * 1000,
      },
    };
  }
}

function toHexNonce(bytes: Uint8Array, label: string): string {
  const value = Buffer.from(bytes).toString('hex');
  if (Buffer.byteLength(value, 'utf8') < 10 || Buffer.byteLength(value, 'utf8') > 74) {
    throw new AttestationError('MALFORMED', `${label} must hex-encode to 10 through 74 bytes`);
  }
  return value;
}

function mapJoseError(error: unknown): AttestationError {
  if (error instanceof AttestationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof joseErrors.JWTExpired) return new AttestationError('STALE', 'Google attestation token is expired');
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return new AttestationError('BAD_ISSUER', 'Google attestation token has an unexpected issuer');
    if (error.claim === 'aud') return new AttestationError('BAD_AUDIENCE', 'Google attestation token has an unexpected audience');
    return new AttestationError('STALE', `Google attestation claim validation failed (${error.claim})`);
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return new AttestationError('BAD_SIGNATURE', 'Google attestation signature is invalid');
  if (error instanceof joseErrors.JWKSNoMatchingKey) return new AttestationError('BAD_CHAIN', 'Google attestation signing key was not found');
  if (error instanceof joseErrors.JOSEAlgNotAllowed) return new AttestationError('BAD_SIGNATURE', 'Google attestation signing algorithm is not allowed');
  if (error instanceof joseErrors.JWKSInvalid) return new AttestationError('BAD_CHAIN', 'Google attestation JWKS is invalid');
  return new AttestationError('MALFORMED', message);
}
