import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRelayTlsIdentity } from '../src/tls-identity.js';

describe('relay TLS identity', () => {
  it('creates an in-memory self-signed DNS certificate whose SPKI matches the returned key', async () => {
    const identity = await createRelayTlsIdentity('relay.example.test');
    const certificate = new X509Certificate(identity.certPem);
    const privateKey = createPrivateKey(identity.keyPem);
    const privateKeySpki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

    expect(certificate.subject).toContain('CN=relay.example.test');
    expect(certificate.subject).toBe(certificate.issuer);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.checkHost('relay.example.test')).toBe('relay.example.test');
    expect(Buffer.from(certificate.publicKey.export({ type: 'spki', format: 'der' }))).toEqual(Buffer.from(identity.spki));
    expect(Buffer.from(privateKeySpki)).toEqual(Buffer.from(identity.spki));
  });

  it('encodes IP addresses as IP SANs', async () => {
    const identity = await createRelayTlsIdentity('127.0.0.1');
    const certificate = new X509Certificate(identity.certPem);

    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
  });

  it('rejects an empty or whitespace-padded name', async () => {
    await expect(createRelayTlsIdentity('')).rejects.toThrow('commonName');
    await expect(createRelayTlsIdentity(' relay.example.test')).rejects.toThrow('commonName');
    await expect(createRelayTlsIdentity('relay.example.test/path')).rejects.toThrow('commonName');
  });
});
