// RFC 9578 Privacy Pass, token type 0x0002 (Blind RSA, 2048-bit, SHA-384, PSS).
// All crypto comes from @cloudflare/privacypass-ts. This file only wires it up.
import {
  AuthorizationHeader,
  Token,
  TokenChallenge,
  TOKEN_TYPES,
  WWWAuthenticateHeader,
  publicVerif,
} from '@cloudflare/privacypass-ts';
import { createHash } from 'node:crypto';

const { Issuer, Client, Origin, BlindRSAMode, getPublicKeyBytes, TokenRequest, TokenResponse } = publicVerif;
const { convertRSASSAPSSToEnc } = publicVerif;

export const TOKEN_TYPE = 0x0002;
export const DEFAULT_ISSUER_NAME = 'issuer.wraps.local';
const MODE = BlindRSAMode.PSS;
const TYPE = TOKEN_TYPES.BLIND_RSA;

export { Token };

export interface IssuerKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** SPKI bytes with the RSASSA-PSS OID, as RFC 9578 section 6.5 defines. */
  publicKeyBytes: Uint8Array;
}

/**
 * Tokens are generic: empty redemption context and no origin info.
 * So one token works at any merchant. Double spend is stopped by the issuer's spent list.
 */
export function genericChallenge(issuerName = DEFAULT_ISSUER_NAME): TokenChallenge {
  return new TokenChallenge(TOKEN_TYPE, issuerName, new Uint8Array(0));
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

export function fromB64u(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export async function generateIssuerKeys(modulusLength = 2048): Promise<IssuerKeyPair> {
  const kp = await Issuer.generateKey(MODE, { modulusLength, publicExponent: Uint8Array.from([1, 0, 1]) });
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeyBytes: await getPublicKeyBytes(kp.publicKey) };
}

/** token_key_id = SHA-256 of the public key bytes (RFC 9578 section 6.5). */
export function tokenKeyId(publicKeyBytes: Uint8Array): Uint8Array {
  return sha256(publicKeyBytes);
}

/** Issuer side: signs blinded token requests. It never sees the token nonce. */
export class TokenIssuer {
  private readonly issuer: InstanceType<typeof Issuer>;
  constructor(readonly keys: IssuerKeyPair, readonly name = DEFAULT_ISSUER_NAME) {
    this.issuer = new Issuer(MODE, name, keys.privateKey, keys.publicKey);
  }

  async issue(requests: Uint8Array[]): Promise<Uint8Array[]> {
    const expectedTruncatedId = tokenKeyId(this.keys.publicKeyBytes)[31];
    const out: Uint8Array[] = [];
    for (const bytes of requests) {
      const req = TokenRequest.deserialize(TYPE, bytes);
      if (req.truncatedTokenKeyId !== expectedTruncatedId) throw new Error('token request is for a different issuer key');
      out.push((await this.issuer.issue(req)).serialize());
    }
    return out;
  }
}

/** Client side: one pending blinding per token. Keep these private to the agent. */
export interface PendingToken {
  client: InstanceType<typeof Client>;
  request: Uint8Array;
}

export async function blindTokens(
  publicKeyBytes: Uint8Array,
  count: number,
  issuerName = DEFAULT_ISSUER_NAME,
): Promise<PendingToken[]> {
  const challenge = genericChallenge(issuerName);
  const pending: PendingToken[] = [];
  for (let i = 0; i < count; i++) {
    const client = new Client(MODE);
    const req = await client.createTokenRequest(challenge, publicKeyBytes);
    pending.push({ client, request: req.serialize() });
  }
  return pending;
}

export async function finalizeTokens(pending: PendingToken[], responses: Uint8Array[]): Promise<Token[]> {
  if (pending.length !== responses.length) throw new Error('response count does not match request count');
  const tokens: Token[] = [];
  for (let i = 0; i < pending.length; i++) {
    tokens.push(await pending[i].client.finalize(TokenResponse.deserialize(responses[i])));
  }
  return tokens;
}

/** Verifier: checks type, key id, generic challenge digest, and the RSA signature. */
export class TokenVerifier {
  private readonly origin = new Origin(MODE);
  private readonly keyId: Uint8Array;
  private readonly challengeDigest: Uint8Array;
  private keyPromise: Promise<CryptoKey>;

  constructor(readonly publicKeyBytes: Uint8Array, readonly issuerName = DEFAULT_ISSUER_NAME) {
    this.keyId = tokenKeyId(publicKeyBytes);
    this.challengeDigest = sha256(genericChallenge(issuerName).serialize());
    this.keyPromise = importTokenPublicKey(publicKeyBytes);
  }

  async verify(token: Token): Promise<boolean> {
    const a = token.authInput;
    if (a.tokenType !== TOKEN_TYPE) return false;
    if (!equalBytes(a.tokenKeyId, this.keyId)) return false;
    if (!equalBytes(a.challengeDigest, this.challengeDigest)) return false;
    try {
      return await this.origin.verify(token, await this.keyPromise);
    } catch {
      return false;
    }
  }
}

export async function importTokenPublicKey(publicKeyBytes: Uint8Array): Promise<CryptoKey> {
  const spki = convertRSASSAPSSToEnc(publicKeyBytes);
  return crypto.subtle.importKey('spki', spki, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
}

/** Spent-list key. The nonce is 32 random bytes chosen by the client. */
export function tokenId(token: Token): string {
  return toHex(token.authInput.nonce);
}

export function serializeToken(token: Token): string {
  return b64u(token.serialize());
}

export function deserializeToken(s: string): Token {
  return Token.deserialize(TYPE, fromB64u(s));
}

/**
 * RFC 9577 Authorization header. RFC 9577 sends one token per request.
 * A price of N tokens sends N comma-separated PrivateToken credentials (our extension).
 */
export function encodeAuthorization(tokens: Token[]): string {
  return tokens.map((t) => new AuthorizationHeader(t).toString()).join(', ');
}

export function parseAuthorization(header: string | undefined): Token[] {
  if (!header) return [];
  try {
    return AuthorizationHeader.parse(TYPE, header).map((h) => h.token);
  } catch {
    return [];
  }
}

/** RFC 9577 WWW-Authenticate challenge for a merchant 402. */
export function challengeHeader(publicKeyBytes: Uint8Array, issuerName = DEFAULT_ISSUER_NAME): string {
  return new WWWAuthenticateHeader(genericChallenge(issuerName), publicKeyBytes).toString();
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
