import { isIP } from 'node:net';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface RelayTlsIdentity {
  /** Private key in PKCS#8 PEM form; keep only in the workload's memory. */
  keyPem: string;
  /** Self-signed certificate in PEM form. */
  certPem: string;
  /** SPKI DER bytes to bind into the workload attestation. */
  spki: Uint8Array;
}

/** Generate the relay's P-256 TLS identity in memory, with no CA or disk writes. */
export async function createRelayTlsIdentity(commonName: string): Promise<RelayTlsIdentity> {
  const name = commonName.trim();
  if (!name || name !== commonName || /[\r\n]/.test(name)) {
    throw new TypeError('commonName must be a non-empty DNS name or IP address');
  }
  const sanType = isIP(name) ? 'ip' : 'dns';
  if (sanType === 'dns' && !isDnsName(name)) {
    throw new TypeError('commonName must be a non-empty DNS name or IP address');
  }

  const keys = (await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const now = Date.now();
  const serial = webcrypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(serial).toString('hex'),
    name: `CN=${name}`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 30 * 24 * 60 * 60_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: sanType, value: name }]),
    ],
  });

  const [privateKey, publicKey] = await Promise.all([
    webcrypto.subtle.exportKey('pkcs8', keys.privateKey),
    webcrypto.subtle.exportKey('spki', keys.publicKey),
  ]);
  return {
    keyPem: toPem(Buffer.from(privateKey), 'PRIVATE KEY'),
    certPem: certificate.toString('pem'),
    spki: new Uint8Array(publicKey),
  };
}

function toPem(der: Buffer, label: string): string {
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function isDnsName(name: string): boolean {
  if (name.length > 253) return false;
  return name.split('.').every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
  );
}
