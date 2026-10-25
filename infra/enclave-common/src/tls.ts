// Self-signed TLS identity, made inside the enclave at boot. No CA signs it.
// The SDK trusts the key because the same key is in the attestation document
// (NSM public_key field and publicKeys.tls). Clients must pin the SPKI, not the name.
import * as x509 from '@peculiar/x509';
import { createHash, webcrypto } from 'node:crypto';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface TlsIdentity {
  keyPem: string;
  certPem: string;
  /** SPKI DER of the TLS public key. */
  spkiDer: Buffer;
  /** SHA-256 of spkiDer, hex. Handy for logs and for pinning. */
  spkiSha256: string;
}

export async function createTlsIdentity(commonName: string, validDays = 30): Promise<TlsIdentity> {
  const keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=${commonName}`,
    notBefore: new Date(now - 3600_000),
    notAfter: new Date(now + validDays * 86400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: commonName }]),
    ],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const spkiDer = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey));
  return {
    keyPem: toPem(pkcs8, 'PRIVATE KEY'),
    certPem: cert.toString('pem'),
    spkiDer,
    spkiSha256: createHash('sha256').update(spkiDer).digest('hex'),
  };
}

function toPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${b64.trimEnd()}\n-----END ${label}-----\n`;
}

function randomSerial(): string {
  const b = webcrypto.getRandomValues(new Uint8Array(12));
  b[0] &= 0x7f;
  return Buffer.from(b).toString('hex');
}
