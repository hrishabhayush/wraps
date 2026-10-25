import { describe, expect, it } from 'vitest';
import { deriveWireGuardPublicKey } from '../src/wireguard.js';

describe('WireGuard key handling', () => {
  it('derives the RFC 7748 X25519 public key from a private key', () => {
    const privateKey = Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex').toString('base64');
    expect(Buffer.from(deriveWireGuardPublicKey(privateKey), 'base64').toString('hex'))
      .toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  });

  it('rejects noncanonical private keys', () => {
    expect(() => deriveWireGuardPublicKey('not-a-key')).toThrow('standard base64');
  });
});
