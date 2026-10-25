import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('APP-SEC-01 stores a quote ID before settling, signs both routes, and reuses it after an unknown outcome', async () => {
  const storage = new MemoryStorage();
  storage.setItem('wraps.tokens.v1', JSON.stringify({ tokens: ['blind-token-1'], history: [] }));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });

  const authCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          authCalls.push({ command, args });
          if (command === 'merchant_auth_public_key') return 'public-spki-key';
          return {
            'x-wraps-merchant-signature': 'signature',
            'x-wraps-merchant-timestamp': '123',
            'x-wraps-merchant-nonce': 'abcdefghijklmnop',
          };
        },
      },
    },
  });

  const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  let settleAttempts = 0;
  let statusAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ path, body, headers: new Headers(init?.headers) });
    if (path === '/settle') {
      settleAttempts++;
      if (settleAttempts === 1) throw new Error('settle response lost');
      return new Response(JSON.stringify({ settled: true }), { status: 200 });
    }
    if (path === '/settle/status') {
      statusAttempts++;
      if (statusAttempts === 1) throw new Error('status request lost');
      return new Response(JSON.stringify({ status: 'unspent' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    const tokens = await import('./tokens.ts');
    await assert.rejects(tokens.spend(1, 'usc1'), /outcome is unknown/);
    const afterUnknown = JSON.parse(storage.getItem('wraps.tokens.v1')!);
    assert.equal(afterUnknown.tokens.length, 0);
    assert.match(afterUnknown.pendingSettle.quoteId, /^[a-f0-9]{32}$/);
    assert.deepEqual(afterUnknown.pendingSettle.tokens, ['blind-token-1']);

    await tokens.spend(1, 'usc1');
    const afterSuccess = JSON.parse(storage.getItem('wraps.tokens.v1')!);
    assert.equal(afterSuccess.pendingSettle, undefined);
    assert.equal(afterSuccess.tokens.length, 0);

    const settleRequests = requests.filter(request => request.path === '/settle');
    assert.equal(settleRequests.length, 2);
    assert.deepEqual(settleRequests[0].body, settleRequests[1].body);
    assert.equal(settleRequests[0].body.merchantId, 'node:usc1');
    assert.deepEqual(settleRequests[0].body.tokens, ['blind-token-1']);
    assert.equal(requests.filter(request => request.path === '/settle/status').length, 2);
    assert.ok(requests.every(request => request.headers.get('x-wraps-merchant-signature') === 'signature'));
    assert.ok(requests.every(request => authCalls.some(call => call.command === 'merchant_auth_headers'
      && call.args?.path === request.path
      && call.args?.body === JSON.stringify(request.body))));
    assert.equal(await tokens.merchantAuthPublicKey(), 'public-spki-key');
  } finally {
    globalThis.fetch = originalFetch;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { isTauri?: unknown }).isTauri;
  }
});
