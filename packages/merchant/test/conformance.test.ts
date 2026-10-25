// x402 conformance, merchant side: quote binding, single-use grants, cache hygiene, relay.
// Sources (see packages/issuer/test/conformance.test.ts and docs/SECURITY-CONFORMANCE.md):
//   [USENIX'26] Wang et al., arXiv 2607.19545 (SR1-SR8)
//   [Five]      Li, Wang, Wang, arXiv 2605.11781 (M1, M3, M5)
//   [FreeRide]  Ling et al., arXiv 2605.30998 (flaw classes)
// These are our own tests against the papers' rules, not an external audit.
import { once } from 'node:events';
import { request } from 'node:http';
import { createConnection, createServer as createTcpServer, type Server as NetServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockAttestationVerifier, b64u, fromB64u, mockPcrs } from '@wraps/attestation';
import { MockTopUpWallet, QUOTE_HEADER, RunningIssuer, Transport, startIssuer } from '@wraps/issuer';
import { createRelayServer, type RelayIssuer } from '@wraps/relay';
import { PrivatePayClient } from '@wraps/sdk';
import { Token, blindTokens, encodeAuthorization, finalizeTokens, serializeToken } from '@wraps/tokens';
import { Merchant, defaultServices } from '../src/index';

const quiet = () => {};
const verifier = () => new MockAttestationVerifier({ expectedPcrs: mockPcrs('issuer') });
const wallet = new MockTopUpWallet();

let issuer: RunningIssuer;
let merchant: Merchant;
let url: string;
let t = Date.now();
const now = () => t;

beforeAll(async () => {
  issuer = await startIssuer({ log: quiet, payoutIntervalMs: 3_600_000 });
  merchant = new Merchant({ merchantId: 'm-conf', issuerUrl: issuer.url, verifier: verifier(), log: quiet, now, quoteTtlMs: 60_000 });
  url = await merchant.start();
});
afterAll(async () => {
  await merchant.close();
  await issuer.close();
});

async function mint(n: number): Promise<Token[]> {
  const core = issuer.core;
  const pending = await blindTokens(core.publicKeys.token, n, core.name);
  const responses = await core.issuePaid(pending.map((p) => b64u(p.request)), await wallet.pay(core.quote(n)));
  return finalizeTokens(pending, responses.map(fromB64u));
}

/** Unpaid GET: returns the 402 body with its quote. */
async function quote(path: string, base = url) {
  const r = await fetch(`${base}${path}`);
  expect(r.status).toBe(402);
  return (await r.json()) as { quoteId: string; resource: string; price: number; expiresAt: number; error?: string };
}

function pay(path: string, tokens: Token[], quoteId?: string, base = url) {
  const headers: Record<string, string> = { authorization: encodeAuthorization(tokens) };
  if (quoteId !== undefined) headers[QUOTE_HEADER] = quoteId;
  return fetch(`${base}${path}`, { headers });
}

const issuerValid = async (tokens: Token[]) => {
  const r = await fetch(`${issuer.url}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokens: tokens.map(serializeToken) }) });
  return ((await r.json()) as { valid: boolean }).valid;
};

describe('SR1 / cross-resource substitution [USENIX\'26, FreeRide] / M3 [Five]', () => {
  it('SR1: the 402 names a quote bound to this resource, price and expiry', async () => {
    const q = await quote('/analytics?asset=XRP');
    expect(q).toMatchObject({ resource: '/analytics?asset=XRP', price: 2, quoteId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(q.expiresAt).toBe(t + 60_000);
  });

  it('SR1: a payment that does not reference a quote is refused and the tokens stay unspent', async () => {
    const tokens = await mint(2);
    const r = await pay('/analytics', tokens);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toMatch(/must reference a quote/);
    expect(await issuerValid(tokens)).toBe(true);
  });

  it('FreeRide cross-resource substitution: a quote for the cheap service does not unlock the expensive one', async () => {
    const cheap = await quote('/analytics');
    const tokens = await mint(4); // enough tokens for filings, quote for analytics
    const r = await pay('/filings', tokens, cheap.quoteId);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toMatch(/different resource/);
    expect(await issuerValid(tokens)).toBe(true);
  });

  it('SR1: a quote for one query cannot pay for another query on the same path', async () => {
    const q = await quote('/analytics?asset=XRP');
    const tokens = await mint(2);
    expect((await pay('/analytics?asset=ETH', tokens, q.quoteId)).status).toBe(402);
    expect((await pay('/analytics?asset=XRP', tokens, q.quoteId)).status).toBe(200);
  });

  it('M3: a quote is a single-use grant; fresh tokens cannot reuse a paid quote', async () => {
    const q = await quote('/analytics');
    expect((await pay('/analytics', await mint(2), q.quoteId)).status).toBe(200);
    const again = await pay('/analytics', await mint(2), q.quoteId);
    expect(again.status).toBe(402);
    expect((await again.json()).error).toMatch(/already used|unknown quote/);
  });

  it('M3 / FreeRide duplicate-settlement race: concurrent identical paid requests, exactly one is served', async () => {
    const q = await quote('/analytics');
    const tokens = await mint(2);
    const statuses = (await Promise.all(Array.from({ length: 5 }, () => pay('/analytics', tokens, q.quoteId)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  });

  it('M3: the same tokens on two quotes at once: only one request is served', async () => {
    const [q1, q2] = [await quote('/analytics'), await quote('/analytics')];
    const tokens = await mint(2);
    const statuses = (await Promise.all([pay('/analytics', tokens, q1.quoteId), pay('/analytics', tokens, q2.quoteId)])).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 402]);
  });

  it('SR1: the SDK refuses to pay a 402 whose quote names another resource', async () => {
    const lying: Transport = async (u, init) => {
      const r = await fetch(u, init);
      if (r.status !== 402) return r;
      const body = await r.json();
      return new Response(JSON.stringify({ ...body, resource: '/filings' }), { status: 402, headers: r.headers });
    };
    const sdk = new PrivatePayClient({ issuerUrl: issuer.url, verifier: verifier(), wallet, caps: { perCallTokens: 5, dailyTokens: 50, maxTopUpTokens: 20 }, transport: lying });
    await sdk.connect();
    await sdk.topUp(2);
    await expect(sdk.fetch(`${url}/analytics`)).rejects.toMatchObject({ code: 'BAD_QUOTE' });
    expect(sdk.balance).toBe(2);
  });
});

describe('M5: cache and header hygiene [Five]', () => {
  it('M5: paid merchant responses carry Cache-Control: no-store, private', async () => {
    const q = await quote('/analytics');
    const r = await pay('/analytics', await mint(2), q.quoteId);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store, private');
    expect(r.headers.get('vary')).toMatch(/authorization/i);
  });

  it('M5: 402 challenges are not cacheable either', async () => {
    const r = await fetch(`${url}/filings`);
    expect(r.status).toBe(402);
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('M5: the relay does not cache and does not modify the payment headers', async () => {
    // The relay is a CONNECT tunnel: it forwards bytes and never terminates TLS, so it cannot
    // read, cache, add, strip or duplicate HTTP headers. This checks the bytes end to end.
    const seen: Buffer[] = [];
    const reply = Buffer.from('HTTP/1.1 200 OK\r\ncache-control: no-store, private\r\ncontent-length: 2\r\n\r\nok');
    const upstream: NetServer = createTcpServer((s) => {
      const chunks: Buffer[] = [];
      s.on('data', (c) => {
        chunks.push(c);
        const all = Buffer.concat(chunks);
        if (all.includes('\r\n\r\n', clientHello().length)) {
          seen.push(all);
          s.write(reply);
        }
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upPort = (upstream.address() as { port: number }).port;
    const relayIssuer: RelayIssuer = { verify: async () => true, settle: async () => {} };
    const relay = createRelayServer({ issuer: relayIssuer }, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      connect: () => createConnection({ host: '127.0.0.1', port: upPort }),
    });
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    const relayPort = (relay.address() as { port: number }).port;
    const proxyAuth = encodeAuthorization(await mint(1));
    const paid = Buffer.from(`GET /analytics HTTP/1.1\r\nhost: m\r\nauthorization: ${encodeAuthorization(await mint(2))}\r\n${QUOTE_HEADER}: ${'ab'.repeat(16)}\r\n\r\n`);
    const sent = Buffer.concat([clientHello(), paid]);

    const tunnel = () =>
      new Promise<Buffer>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: relayPort, method: 'CONNECT', path: 'example.com:443', headers: { 'proxy-authorization': proxyAuth } });
        req.on('connect', (_res, socket) => {
          const got: Buffer[] = [];
          socket.on('data', (c) => {
            got.push(c);
            if (Buffer.concat(got).length >= reply.length) {
              socket.destroy();
              resolve(Buffer.concat(got));
            }
          });
          socket.write(sent);
        });
        req.on('error', reject);
        req.end();
      });
    try {
      const first = await tunnel();
      const second = await tunnel();
      expect(seen).toHaveLength(2); // both requests reached the origin: nothing was served from a cache
      for (const s of seen) expect(s.equals(sent)).toBe(true); // byte-identical, one copy of each header
      expect(first.equals(reply) && second.equals(reply)).toBe(true); // response headers untouched
    } finally {
      relay.closeAllConnections();
      await new Promise<void>((r) => relay.close(() => r()));
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});

describe('SR4 / denial of settlement [USENIX\'26, FreeRide]', () => {
  it('SR4 / FreeRide denial of settlement: the merchant serves nothing when settlement fails, and the payer can retry', async () => {
    let failNext = true;
    const flaky: Transport = async (u, init) => {
      if (u.endsWith('/settle') && failNext) {
        failNext = false;
        return new Response(JSON.stringify({ error: 'issuer unavailable' }), { status: 503 });
      }
      return fetch(u, init);
    };
    const m = new Merchant({ merchantId: 'm-flaky', issuerUrl: issuer.url, verifier: verifier(), log: quiet, transport: flaky });
    const base = await m.start();
    try {
      const q = await quote('/analytics', base);
      const tokens = await mint(2);
      const r1 = await pay('/analytics', tokens, q.quoteId, base);
      expect(r1.status).toBe(402);
      const body = await r1.json();
      expect(body.error).toMatch(/settle failed/);
      expect(body.data).toBeUndefined();
      expect(m.claims).toHaveLength(0);
      // Not settled: the tokens are unspent and the quote is open again.
      const r2 = await pay('/analytics', tokens, q.quoteId, base);
      expect(r2.status).toBe(200);
      expect(m.latestClaim?.claim.totalTokens).toBe(2);
    } finally {
      await m.close();
    }
  });
});

describe('SR4 / ambiguous settlement: a quote reopens only when settle is known to have failed', () => {
  /** A merchant whose /settle calls go through `settle`. Other issuer calls pass through. */
  async function withMerchant(settle: Transport, fn: (base: string, m: Merchant, clock: { t: number }) => Promise<void>) {
    const clock = { t: Date.now() };
    const transport: Transport = (u, init) => (u.endsWith('/settle') ? settle(u, init) : fetch(u, init));
    const m = new Merchant({ merchantId: `m-amb-${Math.random().toString(16).slice(2)}`, issuerUrl: issuer.url, verifier: verifier(), log: quiet, transport, now: () => clock.t });
    const base = await m.start();
    try {
      await fn(base, m, clock);
    } finally {
      await m.close();
    }
  }

  it('SR4 ambiguous settle: the answer is lost after the issuer settled; /settle/status confirms it and the merchant serves once', async () => {
    const lost: Transport = async (u, init) => {
      await fetch(u, init); // the issuer settles
      throw new Error('socket hang up'); // but the merchant never sees the answer
    };
    await withMerchant(lost, async (base, m) => {
      const q = await quote('/analytics', base);
      const tokens = await mint(2);
      const r1 = await pay('/analytics', tokens, q.quoteId, base);
      expect(r1.status).toBe(200);
      expect((await r1.json()).data).toBeDefined();
      expect(m.claims).toHaveLength(0); // no signed claim arrived, but the tokens are spent
      expect(await issuerValid(tokens)).toBe(false);
      const again = await pay('/analytics', tokens, q.quoteId, base);
      expect(again.status).toBe(402); // served once, never twice
    });
  });

  it('SR4 ambiguous settle: issuer unreachable; the quote stays held, even past expiry, until the same tokens settle it', async () => {
    let down = true;
    const unreachable: Transport = async (u, init) => {
      if (down) throw new Error('connect ETIMEDOUT');
      return fetch(u, init);
    };
    await withMerchant(unreachable, async (base, m, clock) => {
      const q = await quote('/analytics', base);
      const tokens = await mint(2);
      const r1 = await pay('/analytics', tokens, q.quoteId, base);
      expect(r1.status).toBe(503);
      expect(r1.headers.get('retry-after')).toBe('1');
      expect(await r1.json()).toMatchObject({ pending: true, quoteId: q.quoteId });
      expect(await issuerValid(tokens)).toBe(true);

      // Not reopened: another payment cannot take the held quote.
      const other = await mint(2);
      const steal = await pay('/analytics', other, q.quoteId, base);
      expect(steal.status).toBe(402);
      expect((await steal.json()).error).toMatch(/settlement pending for other tokens/);
      expect(await issuerValid(other)).toBe(true);

      // The paid request is not lost: the same tokens settle it, even after the quote's expiry.
      down = false;
      clock.t += 60_001;
      const r2 = await pay('/analytics', tokens, q.quoteId, base);
      expect(r2.status).toBe(200);
      expect(m.claims).toHaveLength(1);
      expect((await pay('/analytics', tokens, q.quoteId, base)).status).toBe(402);
    });
  });

  it('SR4 ambiguous settle race: a delayed settle lands after the merchant answered pending; the retry serves once and the tab counts it once', async () => {
    let release!: () => void;
    let landed!: Promise<Response>;
    let first = true;
    const delayed: Transport = async (u, init) => {
      if (!first) return fetch(u, init);
      first = false;
      landed = new Promise<void>((r) => (release = r)).then(() => fetch(u, init));
      throw new Error('request timed out'); // the merchant gives up; the request is still on its way
    };
    await withMerchant(delayed, async (base, m) => {
      const q = await quote('/analytics', base);
      const tokens = await mint(2);
      expect((await pay('/analytics', tokens, q.quoteId, base)).status).toBe(503);

      release();
      expect((await landed).status).toBe(200); // the late settle lands at the issuer

      const r2 = await pay('/analytics', tokens, q.quoteId, base);
      expect(r2.status).toBe(200); // retry: idempotent settle returns the original claim, serve
      expect((await pay('/analytics', tokens, q.quoteId, base)).status).toBe(402);

      // The next paid request's claim covers the late settle plus this one: 2 + 2 tokens.
      const q2 = await quote('/analytics', base);
      expect((await pay('/analytics', await mint(2), q2.quoteId, base)).status).toBe(200);
      expect(m.latestClaim?.claim.totalTokens).toBe(4);
    });
  });

  it('SR4 ambiguous settle race: after a gateway 504, concurrent retries with the same tokens are served exactly once', async () => {
    let first = true;
    const gateway: Transport = async (u, init) => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ error: 'gateway timeout' }), { status: 504 });
      }
      return fetch(u, init);
    };
    await withMerchant(gateway, async (base, m) => {
      const q = await quote('/analytics', base);
      const tokens = await mint(2);
      expect((await pay('/analytics', tokens, q.quoteId, base)).status).toBe(503);
      const statuses = (await Promise.all(Array.from({ length: 5 }, () => pay('/analytics', tokens, q.quoteId, base)))).map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(m.claims).toHaveLength(1);
      expect(m.latestClaim?.claim.totalTokens).toBe(2);
    });
  });
});

describe('SEC-03: cross-merchant double-serve during an ambiguous settle', () => {
  /** Merchant A: its /settle calls go through `settle`. Merchant B: a plain merchant. */
  async function withTwoMerchants(settle: Transport, fn: (a: { base: string; m: Merchant }, b: { base: string; m: Merchant }) => Promise<void>) {
    const tag = Math.random().toString(16).slice(2);
    const transport: Transport = (u, init) => (u.endsWith('/settle') ? settle(u, init) : fetch(u, init));
    const ma = new Merchant({ merchantId: `m-sec03-a-${tag}`, issuerUrl: issuer.url, verifier: verifier(), log: quiet, transport });
    const mb = new Merchant({ merchantId: `m-sec03-b-${tag}`, issuerUrl: issuer.url, verifier: verifier(), log: quiet });
    const [a, b] = [await ma.start(), await mb.start()];
    try {
      await fn({ base: a, m: ma }, { base: b, m: mb });
    } finally {
      await ma.close();
      await mb.close();
    }
  }

  const tab = (merchantId: string) => issuer.core.pendingPayouts().find((l) => l.merchantId === merchantId)?.amountTokens ?? 0;

  it('SEC-03 cross-merchant race: tokens settled at merchant B during A\'s ambiguous settle; A refuses, B serves, exactly one serve', async () => {
    let entered!: () => void;
    let release!: () => void;
    const inSettle = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    // A's first settle never reaches the issuer: it hangs, then times out. Later calls pass.
    let first = true;
    const timesOut: Transport = async (u, init) => {
      if (!first) return fetch(u, init);
      first = false;
      entered();
      await gate;
      throw new Error('request timed out');
    };
    await withTwoMerchants(timesOut, async (a, b) => {
      const tokens = await mint(2);
      const qa = await quote('/analytics', a.base);
      const qb = await quote('/analytics', b.base);
      const atA = pay('/analytics', tokens, qa.quoteId, a.base);
      await inSettle; // A is now unsure whether its settle landed

      // The payer races the same tokens at B. B verifies, settles and serves.
      const atB = await pay('/analytics', tokens, qb.quoteId, b.base);
      expect(atB.status).toBe(200);
      expect((await atB.json()).data).toBeDefined();

      // A's settle fails. The tokens are spent, but /settle/status says not by A: A must not serve.
      release();
      const ra = await atA;
      expect(ra.status).toBe(402);
      const body = await ra.json();
      expect(body.error).toMatch(/spent elsewhere/);
      expect(body.data).toBeUndefined();
      expect(body.error).not.toContain(b.m.merchantId); // A learns nothing about B

      expect(a.m.claims).toHaveLength(0);
      expect(b.m.claims).toHaveLength(1);
      expect(tab(a.m.merchantId)).toBe(0);
      expect(tab(b.m.merchantId)).toBe(2);
      // A's quote reopened for a fresh payment; the raced tokens never buy anything at A.
      expect((await pay('/analytics', tokens, qa.quoteId, a.base)).status).toBe(402);
      expect((await pay('/analytics', await mint(2), qa.quoteId, a.base)).status).toBe(200);
    });
  });

  it('SEC-03 cross-merchant race: after A answers pending, the payer spends the tokens at B; A\'s retry refuses and never serves', async () => {
    let first = true;
    const gateway: Transport = async (u, init) => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ error: 'gateway timeout' }), { status: 504 }); // never reached the issuer
      }
      return fetch(u, init);
    };
    await withTwoMerchants(gateway, async (a, b) => {
      const tokens = await mint(2);
      const qa = await quote('/analytics', a.base);
      const r1 = await pay('/analytics', tokens, qa.quoteId, a.base);
      expect(r1.status).toBe(503); // unspent, but a gateway status: the settle may still land
      expect(await r1.json()).toMatchObject({ pending: true });

      const qb = await quote('/analytics', b.base);
      expect((await pay('/analytics', tokens, qb.quoteId, b.base)).status).toBe(200);

      const retry = await pay('/analytics', tokens, qa.quoteId, a.base);
      expect(retry.status).toBe(402);
      expect((await retry.json()).error).toMatch(/spent elsewhere/);
      expect(a.m.claims).toHaveLength(0);
      expect(tab(a.m.merchantId)).toBe(0);
      expect(tab(b.m.merchantId)).toBe(2);
    });
  });

  it('SEC-03: retrying /settle after a lost answer and a failed status lookup is safe; the original claim comes back and the tab counts once', async () => {
    let calls = 0;
    let statusDown = true;
    const lost: Transport = async (u, init) => {
      calls++;
      if (calls > 1) return fetch(u, init);
      await fetch(u, init); // the issuer settles
      throw new Error('socket hang up'); // the answer is lost
    };
    const tag = Math.random().toString(16).slice(2);
    const transport: Transport = (u, init) => {
      if (u.endsWith('/settle/status') && statusDown) return Promise.reject(new Error('connect ECONNREFUSED'));
      return u.endsWith('/settle') ? lost(u, init) : fetch(u, init);
    };
    const m = new Merchant({ merchantId: `m-sec03-retry-${tag}`, issuerUrl: issuer.url, verifier: verifier(), log: quiet, transport });
    const base = await m.start();
    try {
      const q = await quote('/analytics', base);
      const tokens = await mint(2);
      const r1 = await pay('/analytics', tokens, q.quoteId, base);
      expect(r1.status).toBe(503); // settled, but the merchant cannot know yet
      statusDown = false;
      const statuses = (await Promise.all(Array.from({ length: 3 }, () => pay('/analytics', tokens, q.quoteId, base)))).map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1); // idempotent settle replays the claim; one serve
      expect(m.claims).toHaveLength(1);
      expect(m.latestClaim?.claim.totalTokens).toBe(2);
      expect(tab(m.merchantId)).toBe(2);
      expect((await pay('/analytics', tokens, q.quoteId, base)).status).toBe(402);
    } finally {
      await m.close();
    }
  });
});

describe('SR5: freshness and meaningless proofs [USENIX\'26] + M1 [Five]', () => {
  it('SR5: a payment against a stale quote is refused', async () => {
    const q = await quote('/analytics');
    const tokens = await mint(2);
    t += 60_001;
    const r = await pay('/analytics', tokens, q.quoteId);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toMatch(/quote expired/);
    expect(await issuerValid(tokens)).toBe(true);
  });

  it('M1: malformed authorization headers and quote ids are refused', async () => {
    const bad = await fetch(`${url}/analytics`, { headers: { authorization: 'PrivateToken token=!!!' } });
    expect(bad.status).toBe(402);
    expect((await bad.json()).error).toMatch(/malformed/);
    const r = await pay('/analytics', await mint(2), 'not-hex');
    expect((await r.json()).error).toMatch(/malformed quote id/);
  });

  it('SR5: the wrong number of tokens is refused (no partial or over-payment)', async () => {
    const q = await quote('/filings');
    expect((await pay('/filings', await mint(3), q.quoteId)).status).toBe(402);
  });

  it('SR5: a merchant cannot be configured with a zero or fractional price', () => {
    const [svc] = defaultServices();
    for (const price of [0, -1, 0.5]) {
      expect(() => new Merchant({ issuerUrl: 'http://x', verifier: verifier(), services: [{ ...svc, price }] })).toThrow(/positive whole number/);
    }
  });
});

function clientHello(): Buffer {
  const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00, 0x00, 0x02, 0x13, 0x01, 0x01, 0x00])]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 0x01;
  handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.alloc(5);
  record[0] = 0x16;
  record[1] = 0x03;
  record[2] = 0x01;
  record.writeUInt16BE(handshake.length + body.length, 3);
  return Buffer.concat([record, handshake, body]);
}
