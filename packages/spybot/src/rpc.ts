import { sleep } from "./util.js";

export const PUBLIC_NODES = [
  "https://s1.ripple.com:51234/",
  "https://s2.ripple.com:51234/",
  "https://xrplcluster.com/",
];

/** XRPL testnet nodes. Keep this list separate from mainnet fallbacks. */
export const TESTNET_NODES = ["https://s.altnet.rippletest.net:51234/"];

/** Errors that mean "try again later or try another node". */
const RETRYABLE = new Set(["tooBusy", "slowDown", "noNetwork", "noCurrent", "noClosed", "amendmentBlocked", "failedToForward"]);

export interface RpcOptions {
  /** Endpoints tried in rotation. Defaults to public mainnet nodes. */
  endpoints?: string[];
  /** Max attempts per call across all endpoints. */
  maxAttempts?: number;
  /** First backoff delay in ms. Doubles each retry, capped at maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onRetry?: (info: { endpoint: string; attempt: number; reason: string; delayMs: number }) => void;
}

export class RpcError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

/**
 * Minimal XRPL JSON-RPC client. Rotates between endpoints on every call,
 * and on rate limits (`tooBusy`, HTTP 429/503) or network errors it moves
 * to the next endpoint and backs off exponentially.
 */
export class XrplRpc {
  readonly endpoints: string[];
  private next = 0;
  private opts: Required<Omit<RpcOptions, "onRetry" | "endpoints">> & Pick<RpcOptions, "onRetry">;

  constructor(opts: RpcOptions = {}) {
    this.endpoints = opts.endpoints?.length ? opts.endpoints : PUBLIC_NODES;
    this.opts = {
      maxAttempts: opts.maxAttempts ?? 8,
      baseDelayMs: opts.baseDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 10_000,
      timeoutMs: opts.timeoutMs ?? 20_000,
      fetchImpl: opts.fetchImpl ?? fetch,
      onRetry: opts.onRetry,
    };
  }

  /** Build the endpoint list from a Quicknode URL (first) plus public nodes as fallback. */
  static withQuicknode(url: string | undefined, opts: RpcOptions = {}): XrplRpc {
    const endpoints = url ? [url, ...PUBLIC_NODES] : PUBLIC_NODES;
    return new XrplRpc({ ...opts, endpoints });
  }

  /** Build a testnet-only RPC client. Never mixes testnet and mainnet nodes. */
  static testnet(opts: RpcOptions = {}): XrplRpc {
    return new XrplRpc({ ...opts, endpoints: opts.endpoints?.length ? opts.endpoints : TESTNET_NODES });
  }

  async request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let lastReason = "";
    for (let attempt = 0; attempt < this.opts.maxAttempts; attempt++) {
      const endpoint = this.endpoints[this.next % this.endpoints.length];
      this.next++;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
        let res: Response;
        try {
          res = await this.opts.fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ method, params: [params] }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 429 || res.status >= 500) {
          lastReason = `HTTP ${res.status}`;
        } else {
          const body: any = await res.json();
          const result = body?.result;
          if (result?.status === "success") return result as T;
          const code: string = result?.error ?? "unknown";
          if (!RETRYABLE.has(code)) {
            throw new RpcError(`${method}: ${code}${result?.error_message ? ` (${result.error_message})` : ""}`, code);
          }
          lastReason = code;
        }
      } catch (err) {
        if (err instanceof RpcError) throw err;
        lastReason = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message;
      }
      const delayMs = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      this.opts.onRetry?.({ endpoint, attempt, reason: lastReason, delayMs });
      await sleep(delayMs);
    }
    throw new RpcError(`${method}: gave up after ${this.opts.maxAttempts} attempts (${lastReason})`, lastReason);
  }
}
