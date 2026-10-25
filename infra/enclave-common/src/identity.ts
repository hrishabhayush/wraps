// The enclave identity: the TLS key, the app's own public keys, and a way to
// get a fresh attestation document over all of them.
import type { KeyObject } from 'node:crypto';
import { USER_DATA_ALG, keysHash, toSpkiDer } from './keys';
import { enclaveMode, hasNsmDevice } from './mode';
import { type AttestationProvider, NsmHelperProvider, UnsignedMockProvider } from './nsm';
import { type TlsIdentity, createTlsIdentity } from './tls';

export interface EnclaveIdentityOptions {
  /** "issuer" or "relay". Used as the TLS common name: <role>.enclave */
  role: string;
  /**
   * The app's public keys, generated in memory before this call.
   * Issuer example: { tokenSigning: <blind RSA SPKI>, claimSigning: <Ed25519 SPKI> }.
   * The name "tls" is reserved; this helper adds it.
   */
  publicKeys?: Record<string, KeyObject | string | Uint8Array>;
  /** Override the provider, e.g. MockNitroProvider from @wraps/attestation in Docker mode. */
  provider?: AttestationProvider;
}

export interface AttestationResponse {
  /** "nitro" or "mock". The SDK must refuse "mock" unless it runs in mock mode. */
  provider: 'nitro' | 'mock';
  /** Base64 of the COSE_Sign1 attestation document from NSM. */
  document: string;
  /** Echo of the client nonce, hex. */
  nonce: string;
  /** Key name -> base64 SPKI DER. The SDK recomputes user_data from this. */
  publicKeys: Record<string, string>;
  userDataAlg: typeof USER_DATA_ALG;
  /** Hex of user_data, for debugging. The SDK must use the value inside the document. */
  userData: string;
  /** Name of the key that is also in the NSM public_key field. */
  publicKeyField: 'tls';
}

export interface EnclaveIdentity {
  readonly role: string;
  readonly tls: TlsIdentity;
  readonly publicKeys: Readonly<Record<string, string>>;
  readonly userData: Buffer;
  readonly provider: AttestationProvider;
  attest(nonce: Uint8Array): Promise<AttestationResponse>;
}

export async function createEnclaveIdentity(opts: EnclaveIdentityOptions): Promise<EnclaveIdentity> {
  const provider = opts.provider ?? defaultProvider();
  const tls = await createTlsIdentity(`${opts.role}.enclave`);

  const publicKeys: Record<string, string> = { tls: tls.spkiDer.toString('base64') };
  for (const [name, key] of Object.entries(opts.publicKeys ?? {})) {
    if (name === 'tls') throw new Error('the key name "tls" is reserved');
    publicKeys[name] = toSpkiDer(key).toString('base64');
  }
  Object.freeze(publicKeys);
  const userData = keysHash(publicKeys);

  return Object.freeze({
    role: opts.role,
    tls,
    publicKeys,
    userData,
    provider,
    async attest(nonce: Uint8Array): Promise<AttestationResponse> {
      const doc = await provider.attest({ nonce, userData, publicKey: tls.spkiDer });
      return {
        provider: provider.kind,
        document: Buffer.from(doc).toString('base64'),
        nonce: Buffer.from(nonce).toString('hex'),
        publicKeys,
        userDataAlg: USER_DATA_ALG,
        userData: userData.toString('hex'),
        publicKeyField: 'tls',
      };
    },
  });
}

/** Nitro mode needs /dev/nsm and fails closed without it. Docker mode uses the unsigned mock. */
function defaultProvider(): AttestationProvider {
  if (enclaveMode() === 'docker') return new UnsignedMockProvider();
  if (!hasNsmDevice()) {
    throw new Error('ENCLAVE_MODE=nitro but /dev/nsm is missing. Refusing to start without attestation.');
  }
  return new NsmHelperProvider();
}
