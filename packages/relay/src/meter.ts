import { createHash, randomUUID } from 'node:crypto';

export const BYTES_PER_TOKEN = 10_000_000;
export const MAX_TOKENS_PER_TUNNEL = 100;

export interface RelayIssuer {
  verify(tokens: string[]): Promise<boolean>;
  settle(merchantId: string, token: string, quoteId: string): Promise<void>;
  settleStatus?(merchantId: string, quoteId: string, tokens: string[]): Promise<unknown>;
}

/** Stable, issuer-compatible ID for one relay settlement operation. */
export function relaySettlementQuoteId(...parts: string[]): string {
  return `relay_${createHash('sha256').update(parts.join('\0')).digest('hex')}`;
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
  private readonly settlementSessionId = randomUUID();

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
        const quoteId = relaySettlementQuoteId('bandwidth', this.settlementSessionId, String(this.settledTokens), token);
        await this.issuer.settle(this.merchantId, token, quoteId);
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
  private readonly settleKey?: string;
  private readonly relayMerchantId: string;

  constructor(
    issuerUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    auth: { settleKey?: string | null; merchantId?: string } = {},
  ) {
    this.baseUrl = new URL(issuerUrl);
    this.settleKey = auth.settleKey === null ? undefined : auth.settleKey ?? process.env.ISSUER_RELAY_SETTLE_KEY;
    this.relayMerchantId = auth.merchantId ?? process.env.ISSUER_RELAY_MERCHANT_ID ?? 'relay';
    if (this.baseUrl.protocol !== 'https:' && this.baseUrl.hostname !== '127.0.0.1' && this.baseUrl.hostname !== 'localhost') {
      throw new Error('issuer URL must use HTTPS outside localhost');
    }
  }

  async verify(tokens: string[]): Promise<boolean> {
    const body = await this.post('/verify', { tokens }) as { valid?: unknown };
    return body.valid === true;
  }

  async settle(merchantId: string, token: string, quoteId: string): Promise<void> {
    await this.post('/settle', { merchantId: this.settleKey ? this.relayMerchantId : merchantId, quoteId, tokens: [token] });
  }

  async settleStatus(merchantId: string, quoteId: string, tokens: string[]): Promise<unknown> {
    return this.post('/settle/status', {
      merchantId: this.settleKey ? this.relayMerchantId : merchantId,
      quoteId,
      tokens,
    });
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.settleKey && (path === '/settle' || path === '/settle/status')) {
      headers.authorization = `Bearer ${this.settleKey}`;
    }
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`issuer ${path} returned HTTP ${res.status}`);
    return res.json();
  }
}
