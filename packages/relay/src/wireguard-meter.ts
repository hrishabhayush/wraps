import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { parseAuthorization, serializeToken } from '@wraps/tokens';
import type { RelayIssuer } from './meter.js';
import { WIREGUARD_BYTES_PER_TOKEN, type WireGuardQuotaController } from './wireguard-quota.js';
import { nextFreePeerAddress, type WireGuardPeer } from './wireguard.js';

/** Open, paid registration: unknown keys get the next free address once they pay. */
export interface OpenWireGuardRegistration {
  maxPeers: number;
  interfaceAddress: string;
  addPeer(peer: WireGuardPeer): Promise<void>;
}

const WIREGUARD_KEY = /^[A-Za-z0-9+/]{43}=$/;
const STAGE_LABELS = new Set(['peer-add-failed', 'settle-failed', 'quota-failed']);

/** Run one registration step; on failure rethrow only a fixed label. */
async function stage<T>(label: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch {
    throw new Error(label);
  }
}

interface MeteredPeer {
  /** Every registered block has been settled before it becomes available. */
  paidBlocks: number;
  usedBlocks: number;
  quotaExhausted: boolean;
}

/** Blind-token admission and exact shared nftables byte quotas for configured peers. */
export class WireGuardTokenMeter {
  private readonly peers = new Map<string, WireGuardPeer>();
  private readonly sessions = new Map<string, MeteredPeer>();
  private readonly registrationLimits = new Map<string, { startedAt: number; count: number }>();
  private readonly staticPeers: number;
  private polling?: NodeJS.Timeout;
  private pollingNow = false;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    peers: WireGuardPeer[],
    private readonly merchantId: string,
    private readonly issuer: RelayIssuer,
    private readonly quotas: WireGuardQuotaController,
    pollIntervalMs = 200,
    private readonly open?: OpenWireGuardRegistration,
  ) {
    for (const peer of peers) this.peers.set(peer.publicKey, peer);
    this.staticPeers = peers.length;
    this.polling = setInterval(() => { void this.poll(); }, pollIntervalMs);
    this.polling.unref();
  }

  /** Pays for a quota block. Returns the peer's tunnel address. */
  async register(publicKey: string, tokens: string[]): Promise<string> {
    if (tokens.length !== 1) throw new Error('exactly one token is required per registration');
    if (!this.open && !this.peers.has(publicKey)) throw new Error('unknown peer');
    if (!WIREGUARD_KEY.test(publicKey) || Buffer.from(publicKey, 'base64').toString('base64') !== publicKey) {
      throw new Error('malformed public key');
    }
    let address = '';
    await this.serialize(async () => {
      if (!(await this.issuer.verify(tokens))) throw new Error('invalid tokens');
      let peer = this.peers.get(publicKey);
      if (!peer) {
        // Open relay: admit this key. It gets no forwarding until its quota is paid below.
        if (this.peers.size - this.staticPeers >= this.open!.maxPeers) throw new Error('relay is full');
        const allowedAddress = nextFreePeerAddress(this.open!.interfaceAddress, [...this.peers.values()].map((p) => p.allowedAddress));
        if (!allowedAddress) throw new Error('relay is full');
        peer = { publicKey, allowedAddress };
        await stage('peer-add-failed', () => this.open!.addPeer(peer!));
        this.peers.set(publicKey, peer);
      }
      address = peer.allowedAddress;
      const existing = this.sessions.get(publicKey);
      if (!existing) {
        // Settle the first prepaid block before adding any forwarding allowance.
        await stage('settle-failed', () => this.issuer.settle(this.merchantId, tokens[0]));
        await stage('quota-failed', () => this.quotas.enable(publicKey, peer!.allowedAddress.split('/')[0]));
        this.sessions.set(publicKey, { paidBlocks: 1, usedBlocks: 0, quotaExhausted: false });
        return;
      }
      if (existing.paidBlocks >= 1000) throw new Error('peer quota limit reached');
      // Reconcile before payment in case the packet quota expired before the
      // asynchronous poller observed it.
      const usage = await this.quotas.usedBytes();
      await this.reconcile(publicKey, existing, usage.get(publicKey) ?? 0);
      await this.issuer.settle(this.merchantId, tokens[0]);
      existing.paidBlocks++;
      if (existing.quotaExhausted) {
        await this.quotas.reset(publicKey);
        existing.quotaExhausted = false;
      }
    });
    return address;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'https://relay.invalid');
    if (url.pathname !== '/wireguard/register') return false;
    if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted) return this.respond(res, 400, 'HTTPS required');
    if (req.method !== 'POST') return this.respond(res, 405, 'POST required');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return this.respond(res, 415, 'application/json required');
    if (!this.allowRegistration(req.socket.remoteAddress ?? 'unknown')) return this.respond(res, 429, 'registration rate limit exceeded');

    try {
      const body = await readJson(req, 8192) as { publicKey?: unknown; authorization?: unknown };
      if (typeof body.publicKey !== 'string' || typeof body.authorization !== 'string') {
        return this.respond(res, 400, 'publicKey and authorization are required');
      }
      let parsed: ReturnType<typeof parseAuthorization>;
      try {
        parsed = parseAuthorization(body.authorization);
      } catch {
        return this.respond(res, 401, 'a valid PrivateToken header is required');
      }
      if (parsed.length !== 1) return this.respond(res, 401, 'exactly one PrivateToken is required per registration');
      const address = await this.register(body.publicKey, parsed.map(serializeToken));
      res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ registered: true, address, bytesPerToken: WIREGUARD_BYTES_PER_TOKEN }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const status = message === 'unknown peer' ? 404
        : message === 'invalid tokens' ? 401
          : message === 'malformed public key' ? 400
          : message === 'peer quota limit reached' || message === 'relay is full' ? 409
            : message === 'request body too large' ? 413
              : error instanceof SyntaxError ? 400 : 503;
      // 503s carry only a fixed stage label, never raw error text.
      const label = STAGE_LABELS.has(message) ? message : 'peer registration failed';
      return this.respond(res, status, status === 503 ? label : message);
    }
  }

  close(): void {
    if (this.polling) clearInterval(this.polling);
    this.polling = undefined;
    this.sessions.clear();
    this.registrationLimits.clear();
  }

  private async poll(): Promise<void> {
    if (this.pollingNow || this.sessions.size === 0) return;
    this.pollingNow = true;
    try {
      await this.serialize(async () => {
        const usage = await this.quotas.usedBytes();
        for (const [publicKey, session] of this.sessions) {
          await this.reconcile(publicKey, session, usage.get(publicKey) ?? 0);
        }
      });
    } catch {
      // Quota exhaustion is enforced in nftables. A control-plane error must not reopen it.
    } finally {
      this.pollingNow = false;
    }
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.operations.then(action, action);
    this.operations = next.then(() => undefined, () => undefined);
    return next;
  }

  private async reconcile(publicKey: string, session: MeteredPeer, usedBytes: number): Promise<void> {
    if (usedBytes < WIREGUARD_BYTES_PER_TOKEN) return;
    if (!session.quotaExhausted) {
      session.quotaExhausted = true;
      session.usedBlocks++;
    }
    if (session.quotaExhausted && session.usedBlocks < session.paidBlocks) {
      await this.quotas.reset(publicKey);
      session.quotaExhausted = false;
    }
  }

  private allowRegistration(source: string): boolean {
    const now = Date.now();
    const current = this.registrationLimits.get(source);
    if (!current || now - current.startedAt >= 60_000) {
      this.registrationLimits.set(source, { startedAt: now, count: 1 });
      if (this.registrationLimits.size > 10_000) {
        for (const [ip, entry] of this.registrationLimits) {
          if (now - entry.startedAt >= 60_000) this.registrationLimits.delete(ip);
        }
      }
      return true;
    }
    if (current.count >= 120) return false;
    current.count++;
    return true;
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
