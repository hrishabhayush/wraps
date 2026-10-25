// Tiny JSON-over-HTTP helpers on node:http. No framework.
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  return (await readJsonWithRaw(req, limit)).value;
}

export async function readJsonWithRaw(req: IncomingMessage, limit = 1_000_000): Promise<{ value: any; raw: Buffer }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks);
  if (size === 0) return { value: {}, raw };
  try {
    return { value: JSON.parse(raw.toString('utf8')), raw };
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store, private', ...headers });
  res.end(JSON.stringify(body));
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Fixed-window rate limit per key (SPEC §12: rate-limit attestation endpoints). */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now > h.reset) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n += 1;
    return h.n <= this.max;
  }
}

/** Base URL a server is listening on, for tests and the demo. */
export function listenUrl(server: import('node:http').Server): string {
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('server not listening on TCP');
  const scheme = 'setSecureContext' in server ? 'https' : 'http'; // https.Server has setSecureContext
  return `${scheme}://127.0.0.1:${a.port}`;
}
