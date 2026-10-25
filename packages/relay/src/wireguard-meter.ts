import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { parseAuthorization, serializeToken } from '@wraps/tokens';
import type { RelayIssuer } from './meter.js';
import { MAX_TOKENS_PER_TUNNEL } from './meter.js';
import { WIREGUARD_BYTES_PER_TOKEN, type WireGuardQuotaController } from './wireguard-quota.js';
import type { WireGuardPeer } from './wireguard.js';

interface MeteredPeer {
  /** Every registered block has been settled before it becomes available. */
  paidBlocks: number;
  usedBlocks: number;
}

/** Blind-token admission and exact shared nftables byte quotas for configured peers. */
export class WireGuardTokenMeter {
  private readonly peers = new Map<string, WireGuardPeer>();
  private readonly sessions = new Map<string, MeteredPeer>();
  private readonly registering = new Set<string>();
  private polling?: NodeJS.Timeout;
  private pollingNow = false;
  private readonly serialTasks = new Map<string, Promise<void>>();

  constructor(
    peers: WireGuardPeer[],
    private readonly merchantId: string,
    private readonly issuer: RelayIssuer,
    private readonly quotas: WireGuardQuotaController,
    pollIntervalMs = 200,
  ) {
    for (const peer of peers) this.peers.set(peer.publicKey, peer);
    this.polling = setInterval(() => { void this.poll(); }, pollIntervalMs);
    this.polling.unref();
  }

  async register(publicKey: string, tokens: string[]): Promise<void> {
    const peer = this.peers.get(publicKey);
    if (!peer) throw new Error('unknown peer');
    if (this.registering.has(publicKey)) throw new Error('peer registration already in progress');
    if (tokens.length < 1 || tokens.length > MAX_TOKENS_PER_TUNNEL) throw new Error('invalid token batch');
    this.registering.add(publicKey);
    try {
      if (new Set(tokens).size !== tokens.length) throw new Error('duplicate or excessive token batch');
      if (!(await this.issuer.verify(tokens))) throw new Error('invalid tokens');
      const existing = this.sessions.get(publicKey);
      const paidBlocks = existing?.paidBlocks ?? 0;
      if (paidBlocks + tokens.length > 1000) {
        throw new Error('duplicate or excessive token batch');
      }
      if (!existing) {
        // Settle the first prepaid block before adding any forwarding allowance.
        await this.issuer.settle(this.merchantId, tokens[0]);
        await this.quotas.enable(publicKey, peer.allowedAddress.split('/')[0]);
        this.sessions.set(publicKey, { paidBlocks: 1, usedBlocks: 0 });
      }
      const session = this.sessions.get(publicKey)!;
      // Remaining requested quota blocks are prepaid now, so a still-unspent
      // blind token can never be replayed elsewhere while held by the relay.
      for (const token of tokens.slice(existing ? 0 : 1)) {
        await this.issuer.settle(this.merchantId, token);
        session.paidBlocks++;
      }
    } finally {
      this.registering.delete(publicKey);
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'https://relay.invalid');
    if (url.pathname !== '/wireguard/register') return false;
    if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted) return this.respond(res, 400, 'HTTPS required');
    if (req.method !== 'POST') return this.respond(res, 405, 'POST required');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return this.respond(res, 415, 'application/json required');

    try {
      const body = await readJson(req, 96_000) as { publicKey?: unknown; authorization?: unknown };
      if (typeof body.publicKey !== 'string' || typeof body.authorization !== 'string') {
        return this.respond(res, 400, 'publicKey and authorization are required');
      }
      let parsed: ReturnType<typeof parseAuthorization>;
      try {
        parsed = parseAuthorization(body.authorization);
      } catch {
        return this.respond(res, 401, 'a valid PrivateToken header is required');
      }
      if (parsed.length < 1 || parsed.length > MAX_TOKENS_PER_TUNNEL) return this.respond(res, 401, 'a bounded PrivateToken batch is required');
      await this.register(body.publicKey, parsed.map(serializeToken));
      res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ registered: true, bytesPerToken: WIREGUARD_BYTES_PER_TOKEN }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const status = message === 'unknown peer' ? 404
        : message === 'invalid tokens' ? 401
          : message === 'duplicate or excessive token batch' ? 409
            : message === 'request body too large' ? 413
              : error instanceof SyntaxError ? 400 : 503;
      return this.respond(res, status, status === 503 ? 'peer registration failed' : message);
    }
  }

  close(): void {
    if (this.polling) clearInterval(this.polling);
    this.polling = undefined;
    this.sessions.clear();
    this.registering.clear();
  }

  private async poll(): Promise<void> {
    if (this.pollingNow || this.sessions.size === 0) return;
    this.pollingNow = true;
    try {
      const usage = await this.quotas.usedBytes();
      await Promise.all([...this.sessions].map(([publicKey]) => this.serialize(publicKey, async () => {
        const session = this.sessions.get(publicKey);
        if (!session || (usage.get(publicKey) ?? 0) < WIREGUARD_BYTES_PER_TOKEN || session.usedBlocks >= session.paidBlocks) return;
        // Every block was settled at registration. Reset only when an already
        // paid next block exists; otherwise the exhausted quota stays closed.
        if (session.usedBlocks + 1 < session.paidBlocks) await this.quotas.reset(publicKey);
        session.usedBlocks++;
      })));
    } catch {
      // Quota exhaustion is enforced in nftables. A control-plane error must not reopen it.
    } finally {
      this.pollingNow = false;
    }
  }

  private serialize(key: string, action: () => Promise<void>): Promise<void> {
    const previous = this.serialTasks.get(key) ?? Promise.resolve();
    const next = previous.then(action, action);
    this.serialTasks.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  private respond(res: ServerResponse, status: number, message: string): true {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
    return true;
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of req) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
