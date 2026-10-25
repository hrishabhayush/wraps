import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

export const MERCHANT_AUTH_HEADERS = {
  signature: 'x-wraps-merchant-signature',
  timestamp: 'x-wraps-merchant-timestamp',
  nonce: 'x-wraps-merchant-nonce',
} as const;

export interface MerchantAuthConfig {
  /** Explicit environment switch. When true, missing merchant credentials are refused. */
  enforce?: boolean;
  /** merchantId -> base64url-encoded Ed25519 SPKI DER public key. */
  publicKeys?: Record<string, string | Uint8Array>;
  /** Maximum age/future skew for signed requests. Defaults to 60 seconds. */
  timestampWindowMs?: number;
  /** Local-only escape hatch. The issuer server still restricts it to loopback callers. */
  developmentMode?: boolean;
  /** Temporary legacy relay credential. Relay ID is fixed and the key must be sent as a bearer token. */
  relay?: { merchantId: string; key: string };
}

export type MerchantAuthMode = 'legacy-open' | 'enforced';

/** Direct callers infer enforcement from configured credentials; env parsing sets this explicitly. */
export function getMerchantAuthMode(config?: MerchantAuthConfig): MerchantAuthMode {
  if (config?.enforce !== undefined) return config.enforce ? 'enforced' : 'legacy-open';
  return config?.relay || Object.keys(config?.publicKeys ?? {}).length > 0 ? 'enforced' : 'legacy-open';
}

export interface MerchantAuthHeaders {
  [key: string]: string;
  [MERCHANT_AUTH_HEADERS.signature]: string;
  [MERCHANT_AUTH_HEADERS.timestamp]: string;
  [MERCHANT_AUTH_HEADERS.nonce]: string;
}

export interface MerchantAuthVerification {
  ok: boolean;
  status: number;
  message: string;
  nonce?: string;
  timestamp?: number;
}

/** Parse production merchant authentication settings. A dev bypass is accepted only on loopback mock runs. */
export function merchantAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  host = env.ISSUER_HOST ?? '0.0.0.0',
  attestation = env.ATTESTATION ?? 'mock',
): MerchantAuthConfig {
  let publicKeys: Record<string, string> = {};
  const rawKeys = env.ISSUER_MERCHANT_AUTH_KEYS;
  const hasMerchantKeys = rawKeys !== undefined;
  if (hasMerchantKeys) {
    let parsed: unknown;
    try { parsed = JSON.parse(rawKeys!); } catch { throw new Error('ISSUER_MERCHANT_AUTH_KEYS must be a JSON object of merchant ID to base64url SPKI public key'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== 'string')) {
      throw new Error('ISSUER_MERCHANT_AUTH_KEYS must be a JSON object of merchant ID to base64url SPKI public key');
    }
    publicKeys = parsed as Record<string, string>;
  }
  const developmentMode = env.ISSUER_DEV_MERCHANT_AUTH === '1';
  if (developmentMode && (!['127.0.0.1', '::1', 'localhost'].includes(host) || attestation === 'confidential-space')) {
    throw new Error('ISSUER_DEV_MERCHANT_AUTH=1 is only allowed for a loopback, non-Confidential-Space local issuer');
  }
  const relayKey = env.ISSUER_RELAY_SETTLE_KEY;
  if (relayKey === '') throw new Error('ISSUER_RELAY_SETTLE_KEY must not be empty when configured');
  return {
    enforce: hasMerchantKeys || relayKey !== undefined,
    publicKeys,
    ...(developmentMode ? { developmentMode: true } : {}),
    ...(relayKey ? { relay: { merchantId: env.ISSUER_RELAY_MERCHANT_ID ?? 'relay', key: relayKey } } : {}),
  };
}

/** Stable bytes signed by a merchant for one HTTP request. */
export function merchantRequestMessage(
  merchantId: string,
  method: string,
  path: string,
  body: Uint8Array | string,
  timestamp: number,
  nonce: string,
): Buffer {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return Buffer.from(
    `wraps-merchant-auth-v1\n${merchantId}\n${method.toUpperCase()}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}`,
    'utf8',
  );
}

export function signMerchantRequest(
  privateKey: KeyObject,
  merchantId: string,
  method: string,
  path: string,
  body: Uint8Array | string,
  timestamp = Date.now(),
  nonce = randomBytes(16).toString('base64url'),
): MerchantAuthHeaders {
  const message = merchantRequestMessage(merchantId, method, path, body, timestamp, nonce);
  return {
    [MERCHANT_AUTH_HEADERS.signature]: sign(null, message, privateKey).toString('base64url'),
    [MERCHANT_AUTH_HEADERS.timestamp]: String(timestamp),
    [MERCHANT_AUTH_HEADERS.nonce]: nonce,
  };
}

export function verifyMerchantRequest(
  config: MerchantAuthConfig | undefined,
  merchantId: string,
  method: string,
  path: string,
  body: Uint8Array | string,
  headers: Record<string, string | string[] | undefined>,
  now = Date.now(),
): MerchantAuthVerification {
  if (!merchantId) return { ok: false, status: 400, message: 'merchantId required' };

  const relay = config?.relay;
  if (relay && merchantId === relay.merchantId) {
    const got = Buffer.from(header(headers, 'authorization') ?? '');
    const want = Buffer.from(`Bearer ${relay.key}`);
    if (got.length === want.length && timingSafeEqual(got, want)) {
      // Legacy relay calls cannot sign yet. This credential is intentionally limited to its fixed ID.
      return { ok: true, status: 200, message: 'ok' };
    }
    return { ok: false, status: 401, message: 'relay credential required' };
  }

  const encodedKey = config?.publicKeys?.[merchantId];
  if (!encodedKey) return { ok: false, status: 401, message: 'unknown merchant or missing credential' };

  const signatureText = header(headers, MERCHANT_AUTH_HEADERS.signature);
  const timestampText = header(headers, MERCHANT_AUTH_HEADERS.timestamp);
  const nonce = header(headers, MERCHANT_AUTH_HEADERS.nonce);
  if (!signatureText || !timestampText || !nonce || !/^\d{1,16}$/.test(timestampText) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return { ok: false, status: 401, message: 'merchant signature headers are required' };
  }
  const timestamp = Number(timestampText);
  const windowMs = config.timestampWindowMs ?? 60_000;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > windowMs) {
    return { ok: false, status: 401, message: 'merchant request timestamp is stale' };
  }

  try {
    const publicKeyBytes = typeof encodedKey === 'string' ? Buffer.from(encodedKey, 'base64url') : Buffer.from(encodedKey);
    if (typeof encodedKey === 'string' && publicKeyBytes.toString('base64url') !== encodedKey) {
      return { ok: false, status: 401, message: 'bad merchant signature' };
    }
    const publicKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
    const signature = Buffer.from(signatureText, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== signatureText || !verify(null, merchantRequestMessage(merchantId, method, path, body, timestamp, nonce), publicKey, signature)) {
      return { ok: false, status: 401, message: 'bad merchant signature' };
    }
  } catch {
    return { ok: false, status: 401, message: 'bad merchant signature' };
  }
  return { ok: true, status: 200, message: 'ok', nonce, timestamp };
}

export function merchantPrivateKeyFromB64u(value: string): KeyObject {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('non-canonical encoding');
    const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    return key;
  } catch {
    throw new Error('MERCHANT_AUTH_PRIVATE_KEY must be a base64url PKCS#8 Ed25519 private key');
  }
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
}
