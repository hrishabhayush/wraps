import { request } from 'node:http';
import { AttestationError, type AttestationProvider } from './types';

/** Confidential Space launcher IPC endpoint for Google Cloud Attestation. */
export const CONFIDENTIAL_SPACE_SOCKET = '/run/container_launcher/teeserver.sock';
export const CONFIDENTIAL_SPACE_TOKEN_PATH = '/v1/token';
export const CONFIDENTIAL_SPACE_FORMAT = 'gcp-confidential-space-v1';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOKEN_BYTES = 64 * 1024;
const SHA256_BYTES = 32;

export interface ConfidentialSpaceProviderOptions {
  /** Custom audience configured by this workload and expected by its verifier. */
  audience: string;
  /** Override for local tests; production uses the Confidential Space launcher socket. */
  socketPath?: string;
  /** Maximum time to wait for the launcher token endpoint. */
  timeoutMs?: number;
}

/**
 * Requests a Google-signed OIDC attestation token from the Confidential Space
 * launcher. The two `eat_nonce` values bind the relying party's nonce and the
 * hash of every workload public key. Both are hex encoded as the token claim
 * echoes strings, and Google accepts nonce strings from 10 through 74 bytes.
 */
export class ConfidentialSpaceProvider implements AttestationProvider {
  readonly format = CONFIDENTIAL_SPACE_FORMAT;
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ConfidentialSpaceProviderOptions) {
    if (!options.audience || Buffer.byteLength(options.audience, 'utf8') > 512) {
      throw new TypeError('audience must be a non-empty string of at most 512 bytes');
    }
    this.socketPath = options.socketPath ?? CONFIDENTIAL_SPACE_SOCKET;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError('timeoutMs must be a positive integer');
    }
    if (!this.socketPath) throw new TypeError('socketPath must not be empty');
  }

  async attest(nonce: Uint8Array, publicKeysHash: Uint8Array): Promise<string> {
    const nonces = [toLauncherNonce(nonce, 'client nonce'), toLauncherNonce(publicKeysHash, 'public key hash')];
    if (publicKeysHash.byteLength !== SHA256_BYTES) {
      throw new TypeError(`public key hash must be ${SHA256_BYTES} bytes`);
    }

    const body = JSON.stringify({
      audience: this.options.audience,
      token_type: 'OIDC',
      nonces,
    });

    let token: string;
    try {
      token = await this.requestToken(body);
    } catch (error) {
      if (error instanceof AttestationError) throw error;
      // Keep socket/provider internals out of an externally returned error.
      throw new AttestationError('MALFORMED', 'Confidential Space launcher request failed');
    }

    const jwtParts = token.split('.');
    if (jwtParts.length !== 3 || jwtParts.some((part) => part.length === 0)) {
      throw new AttestationError('MALFORMED', 'Confidential Space launcher did not return an OIDC JWT');
    }
    return token;
  }

  private requestToken(body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: CONFIDENTIAL_SPACE_TOKEN_PATH,
          method: 'POST',
          headers: {
            host: 'localhost',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            accept: 'application/jwt, text/plain',
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new AttestationError('MALFORMED', `Confidential Space launcher returned HTTP ${res.statusCode ?? 0}`));
            return;
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer | string) => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += part.length;
            if (bytes > MAX_TOKEN_BYTES) {
              req.destroy(new Error('token response too large'));
              reject(new AttestationError('MALFORMED', 'Confidential Space token response is too large'));
              return;
            }
            chunks.push(part);
          });
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
          res.on('error', () => reject(new AttestationError('MALFORMED', 'could not read Confidential Space token response')));
        },
      );
      req.on('timeout', () => req.destroy(new Error('launcher request timed out')));
      req.on('error', () => reject(new AttestationError('MALFORMED', 'Confidential Space launcher request failed')));
      req.end(body);
    });
  }
}

function toLauncherNonce(bytes: Uint8Array, label: string): string {
  const hex = Buffer.from(bytes).toString('hex');
  // Google validates the UTF-8 byte length of the string placed in `nonces`.
  if (Buffer.byteLength(hex, 'utf8') < 10 || Buffer.byteLength(hex, 'utf8') > 74) {
    throw new TypeError(`${label} must hex-encode to 10 through 74 bytes`);
  }
  return hex;
}
