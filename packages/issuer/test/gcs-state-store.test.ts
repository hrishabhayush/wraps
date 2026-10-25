import { describe, expect, it } from 'vitest';
import { GcsIssuerStateStore } from '../src/gcs-state-store';
import type { IssuerStateSnapshot } from '../src/state-store';

const KMS_KEY = 'projects/wraps-hack/locations/us-central1/keyRings/issuer-state/cryptoKeys/state';

class FakeGoogleApis {
  readonly objects = new Map<string, string>();
  readonly calls: Array<{ url: URL; init?: RequestInit }> = [];
  private readonly wrappedKeys = new Map<string, { plaintext: string; aad: string }>();
  private generation = 0;
  private wrapId = 0;

  readonly fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    this.calls.push({ url, init });
    const body = typeof init?.body === 'string' ? init.body : '';

    if (url.hostname === 'cloudkms.googleapis.com') {
      const request = JSON.parse(body) as { plaintext?: string; ciphertext?: string; additionalAuthenticatedData?: string };
      if (url.pathname.endsWith(':encrypt')) {
        const wrappedName = `wrapped-${++this.wrapId}`;
        const ciphertext = Buffer.from(wrappedName).toString('base64');
        this.wrappedKeys.set(ciphertext, { plaintext: request.plaintext ?? '', aad: request.additionalAuthenticatedData ?? '' });
        return Response.json({ ciphertext });
      }
      if (url.pathname.endsWith(':decrypt')) {
        const wrapped = this.wrappedKeys.get(request.ciphertext ?? '');
        if (!wrapped || wrapped.aad !== request.additionalAuthenticatedData) return new Response('bad wrapped key', { status: 400 });
        return Response.json({ plaintext: wrapped.plaintext });
      }
      return new Response('unknown KMS operation', { status: 404 });
    }

    if (url.hostname === 'storage.googleapis.com' && url.pathname === '/storage/v1/b/test-state/o') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const name = [...this.objects.keys()].filter((item) => item.startsWith(prefix)).sort()[0];
      return Response.json({ items: name ? [{ name }] : [] });
    }

    if (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/storage/v1/b/test-state/o/')) {
      const encodedName = url.pathname.slice('/storage/v1/b/test-state/o/'.length);
      const name = decodeURIComponent(encodedName);
      const data = this.objects.get(name);
      return data === undefined ? new Response('not found', { status: 404 }) : new Response(data, { status: 200 });
    }

    if (url.hostname === 'storage.googleapis.com' && url.pathname === '/upload/storage/v1/b/test-state/o' && init?.method === 'POST') {
      const name = url.searchParams.get('name') ?? '';
      if (url.searchParams.get('ifGenerationMatch') !== '0') return new Response('missing create-only precondition', { status: 400 });
      if (this.objects.has(name)) return new Response('object exists', { status: 412 });
      this.objects.set(name, body);
      this.generation++;
      return Response.json({ name, generation: String(this.generation) });
    }

    return new Response('unknown API request', { status: 404 });
  }) as typeof fetch;
}

function snapshot(spent: string[], earned = 0): IssuerStateSnapshot {
  return {
    version: 1,
    spent,
    settlements: [],
    tabs: earned ? { merchant: { earned, paid: 0, seq: 1 } } : {},
    fundsHeld: 7,
    unspentIssued: 2,
    payouts: {},
    inFlightPayouts: [],
    merchantNonces: [],
  };
}

function store(apis: FakeGoogleApis): GcsIssuerStateStore {
  return new GcsIssuerStateStore({
    bucket: 'test-state',
    kmsKey: KMS_KEY,
    getAccessToken: async () => 'attested-access-token',
    fetchImpl: apis.fetchImpl,
  });
}

describe('SEC-06 encrypted Cloud Storage issuer state', () => {
  it('writes immutable encrypted snapshots and restores the latest complete ledger state', async () => {
    const apis = new FakeGoogleApis();
    const first = store(apis);
    await expect(first.load()).resolves.toBeUndefined();
    await expect(first.append(snapshot(['sensitive-spent-token-id'], 1))).resolves.toBeUndefined();
    await expect(first.append(snapshot(['sensitive-spent-token-id', 'another-id'], 2))).resolves.toBeUndefined();

    expect(apis.objects.size).toBe(2);
    expect([...apis.objects.values()].join('\n')).not.toContain('sensitive-spent-token-id');
    expect(apis.calls.filter(({ url }) => url.hostname === 'cloudkms.googleapis.com' && url.pathname.endsWith(':encrypt'))).toHaveLength(2);
    expect(apis.calls.filter(({ url }) => url.pathname === '/upload/storage/v1/b/test-state/o')
      .every(({ url }) => url.searchParams.get('ifGenerationMatch') === '0')).toBe(true);

    const restored = store(apis);
    await expect(restored.load()).resolves.toEqual(snapshot(['sensitive-spent-token-id', 'another-id'], 2));
    expect(apis.calls.filter(({ url }) => url.hostname === 'cloudkms.googleapis.com' && url.pathname.endsWith(':decrypt'))).toHaveLength(1);
  });

  it('fails closed when two issuer instances try to append from the same sequence', async () => {
    const apis = new FakeGoogleApis();
    const first = store(apis);
    const stale = store(apis);
    await Promise.all([first.load(), stale.load()]);
    await first.append(snapshot(['first-write']));
    await expect(stale.append(snapshot(['stale-write']))).rejects.toThrow('lost a create-only race');
    expect(apis.objects.size).toBe(1);
  });

  it('refuses an altered latest snapshot instead of restoring an older state', async () => {
    const apis = new FakeGoogleApis();
    const initial = store(apis);
    await initial.load();
    await initial.append(snapshot(['must-not-restore-old-state']));
    const [name, encoded] = [...apis.objects.entries()][0];
    const envelope = JSON.parse(encoded) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}`;
    apis.objects.set(name, JSON.stringify(envelope));
    await expect(store(apis).load()).rejects.toThrow('could not load and authenticate issuer state');
  });

  it('requires load before append and rejects unsafe bucket or key resource names', async () => {
    const apis = new FakeGoogleApis();
    await expect(store(apis).append(snapshot([]))).rejects.toThrow('must be loaded before append');
    expect(() => new GcsIssuerStateStore({ bucket: 'bad bucket', kmsKey: KMS_KEY, getAccessToken: async () => 'x' })).toThrow('valid bucket name');
    expect(() => new GcsIssuerStateStore({ bucket: 'test-state', kmsKey: 'projects/p/key', getAccessToken: async () => 'x' })).toThrow('Cloud KMS cryptoKey resource');
  });
});
