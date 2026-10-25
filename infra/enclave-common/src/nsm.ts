// Talks to the Nitro Security Module through the small Rust binary `nsm-attest`
// (infra/enclave-common/nsm-helper). The Dockerfiles build it and copy it to
// /usr/local/bin/nsm-attest. See infra/README.md "Calling NSM from Node".
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Same shape as AttestationProvider in packages/attestation/src/types.ts. */
export interface AttestRequest {
  nonce: Uint8Array;
  userData: Uint8Array;
  publicKey?: Uint8Array;
}

export interface AttestationProvider {
  readonly kind: 'mock' | 'nitro';
  attest(req: AttestRequest): Promise<Uint8Array>;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Real provider. Works only inside a Nitro Enclave. */
export class NsmHelperProvider implements AttestationProvider {
  readonly kind = 'nitro' as const;

  constructor(private readonly binary = process.env.NSM_HELPER ?? '/usr/local/bin/nsm-attest') {}

  async attest(req: AttestRequest): Promise<Uint8Array> {
    const args = ['--nonce', hex(req.nonce), '--user-data', hex(req.userData)];
    if (req.publicKey) args.push('--public-key', hex(req.publicKey));
    try {
      const { stdout } = await run(this.binary, args, { timeout: 5_000, maxBuffer: 1 << 20 });
      const out = stdout.trim();
      if (!/^[0-9a-f]+$/.test(out)) throw new Error('nsm-attest printed something that is not hex');
      return new Uint8Array(Buffer.from(out, 'hex'));
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error(`NSM attestation failed: ${e.stderr?.trim() || e.message}`);
    }
  }
}

/**
 * Fallback provider for the Docker mode (INF-24). It returns plain JSON, not a
 * signed COSE document, and its PCRs are all zero. A real Nitro verifier
 * rejects it, which is what we want. For a mock that the SDK's mock verifier
 * accepts, pass MockNitroProvider from @wraps/attestation instead.
 */
export class UnsignedMockProvider implements AttestationProvider {
  readonly kind = 'mock' as const;

  async attest(req: AttestRequest): Promise<Uint8Array> {
    const zero = '0'.repeat(96);
    const doc = {
      mock: true,
      warning: 'NOT A NITRO ATTESTATION. Docker fallback mode.',
      timestamp: Date.now(),
      pcrs: { 0: zero, 1: zero, 2: zero },
      nonce: hex(req.nonce),
      user_data: hex(req.userData),
      public_key: req.publicKey ? hex(req.publicKey) : null,
    };
    return new Uint8Array(Buffer.from(JSON.stringify(doc)));
  }
}
