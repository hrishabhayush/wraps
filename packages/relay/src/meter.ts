export const BYTES_PER_TOKEN = 10_000_000;
export const MAX_TOKENS_PER_TUNNEL = 100;

export interface RelayIssuer {
  verify(tokens: string[]): Promise<boolean>;
  settle(merchantId: string, token: string): Promise<void>;
}

export interface ForwardedChunk {
  /** Bytes permitted by the settled token quota. */
  bytes: Buffer;
  /** True when the chunk exceeded the available quota. */
  exhausted: boolean;
}

/**
 * A tunnel-wide, bidirectional byte meter. It serializes concurrent writes so
 * each next token is settled exactly once before bytes use its 10 MB block.
 */
export class BandwidthMeter {
  readonly serializedTokens: string[];
  private totalBytes = 0;
  private settledTokens = 0;
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  private failureReason: unknown;

  constructor(
    private readonly merchantId: string,
    serializedTokens: string[],
    private readonly issuer: RelayIssuer,
    private readonly bytesPerToken = BYTES_PER_TOKEN,
  ) {
    this.serializedTokens = serializedTokens;
  }

  get bytesUsed(): number {
    return this.totalBytes;
  }

  get tokensSettled(): number {
    return this.settledTokens;
  }

  /** Settle tokens as their quota is needed, charging one token for a partial final block. */
  forward(chunk: Buffer): Promise<ForwardedChunk> {
    const job = this.queue.then(async () => {
      if (this.failed) throw this.failureReason;
      try {
        return await this.forwardInOrder(chunk);
      } catch (error) {
        // Settlement may have succeeded remotely before a timeout or network
        // failure reached us. Poison the meter so queued writes never retry it.
        this.failed = true;
        this.failureReason = error;
        throw error;
      }
    });
    this.queue = job.then(() => undefined, () => undefined);
    return job;
  }

  private async forwardInOrder(chunk: Buffer): Promise<ForwardedChunk> {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.totalBytes === this.settledTokens * this.bytesPerToken) {
        const token = this.serializedTokens[this.settledTokens];
        if (!token) return { bytes: chunk.subarray(0, offset), exhausted: true };

        // A timeout is treated as an unknown result. Do not retry or forward
        // more bytes; the caller closes the tunnel and discards this batch.
        await this.issuer.settle(this.merchantId, token);
        this.settledTokens++;
      }

      const quota = this.settledTokens * this.bytesPerToken - this.totalBytes;
      const take = Math.min(quota, chunk.length - offset);
      this.totalBytes += take;
      offset += take;
    }
    const exhausted = this.totalBytes === this.serializedTokens.length * this.bytesPerToken;
    return { bytes: chunk, exhausted };
  }
}

/** HTTP client for the issuer's atomic /settle endpoint. */
export class HttpRelayIssuer implements RelayIssuer {
  private readonly baseUrl: URL;

  constructor(
    issuerUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    this.baseUrl = new URL(issuerUrl);
    if (this.baseUrl.protocol !== 'https:' && this.baseUrl.hostname !== '127.0.0.1' && this.baseUrl.hostname !== 'localhost') {
      throw new Error('issuer URL must use HTTPS outside localhost');
    }
  }

  async verify(tokens: string[]): Promise<boolean> {
    const body = await this.post('/verify', { tokens }) as { valid?: unknown };
    return body.valid === true;
  }

  async settle(merchantId: string, token: string): Promise<void> {
    await this.post('/settle', { merchantId, tokens: [token] });
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`issuer ${path} returned HTTP ${res.status}`);
    return res.json();
  }
}
