import { describe, expect, it } from 'vitest';
import {
  TokenIssuer,
  TokenVerifier,
  blindTokens,
  challengeHeader,
  deserializeToken,
  encodeAuthorization,
  finalizeTokens,
  generateIssuerKeys,
  parseAuthorization,
  serializeToken,
  tokenId,
} from '../src/index';

describe('RFC 9578 type 0x0002 tokens', () => {
  it('issues, serializes and verifies generic tokens', async () => {
    const keys = await generateIssuerKeys();
    const issuer = new TokenIssuer(keys);
    const pending = await blindTokens(keys.publicKeyBytes, 3);
    const responses = await issuer.issue(pending.map((p) => p.request));
    const tokens = await finalizeTokens(pending, responses);
    const verifier = new TokenVerifier(keys.publicKeyBytes);

    for (const t of tokens) expect(await verifier.verify(t)).toBe(true);
    expect(new Set(tokens.map(tokenId)).size).toBe(3);

    const roundTrip = deserializeToken(serializeToken(tokens[0]));
    expect(await verifier.verify(roundTrip)).toBe(true);

    const header = encodeAuthorization(tokens);
    expect(header.startsWith('PrivateToken token=')).toBe(true);
    const parsed = parseAuthorization(header);
    expect(parsed.map(tokenId)).toEqual(tokens.map(tokenId));
    expect(challengeHeader(keys.publicKeyBytes)).toContain('token-key=');
  });

  it('rejects tokens signed by a different issuer key', async () => {
    const keys = await generateIssuerKeys();
    const other = await generateIssuerKeys();
    const pending = await blindTokens(keys.publicKeyBytes, 1);
    const tokens = await finalizeTokens(pending, await new TokenIssuer(keys).issue(pending.map((p) => p.request)));
    expect(await new TokenVerifier(other.publicKeyBytes).verify(tokens[0])).toBe(false);
  });

  it('rejects a token with a flipped signature bit', async () => {
    const keys = await generateIssuerKeys();
    const pending = await blindTokens(keys.publicKeyBytes, 1);
    const [token] = await finalizeTokens(pending, await new TokenIssuer(keys).issue(pending.map((p) => p.request)));
    token.authenticator[10] ^= 1;
    expect(await new TokenVerifier(keys.publicKeyBytes).verify(token)).toBe(false);
  });
});
