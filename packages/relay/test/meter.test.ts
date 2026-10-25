import { describe, expect, it } from 'vitest';
import { BandwidthMeter, HttpRelayIssuer, type RelayIssuer } from '../src/meter.js';

function stubIssuer(fail = false) {
  const settled: string[] = [];
  const issuer: RelayIssuer = {
    verify: async () => true,
    settle: async (_merchantId, token) => {
      if (fail) throw new Error('issuer unavailable');
      settled.push(token);
    },
  };
  return { issuer, settled };
}

describe('BandwidthMeter', () => {
  it('charges one token for a partial block and another only when the next block is used', async () => {
    const { issuer, settled } = stubIssuer();
    const meter = new BandwidthMeter('relay', ['t1', 't2'], issuer, 10);

    expect((await meter.forward(Buffer.from('12345678'))).bytes.toString()).toBe('12345678');
    expect(settled).toEqual(['t1']);
    expect((await meter.forward(Buffer.from('abcde'))).bytes.toString()).toBe('abcde');
    expect(settled).toEqual(['t1', 't2']);
    expect(meter.bytesUsed).toBe(13);
  });

  it('serializes both directions and never forwards beyond the paid quota', async () => {
    const { issuer, settled } = stubIssuer();
    const meter = new BandwidthMeter('relay', ['t1'], issuer, 10);
    const [up, down] = await Promise.all([
      meter.forward(Buffer.from('12345')),
      meter.forward(Buffer.from('abcde')),
    ]);

    expect(up.bytes.length + down.bytes.length).toBe(10);
    expect(meter.bytesUsed).toBe(10);
    expect(settled).toEqual(['t1']);
    expect(up.exhausted || down.exhausted).toBe(true);
    expect(await meter.forward(Buffer.from('x'))).toMatchObject({ bytes: Buffer.alloc(0), exhausted: true });
  });

  it('fails closed when issuer settlement fails', async () => {
    const { issuer } = stubIssuer(true);
    const meter = new BandwidthMeter('relay', ['t1'], issuer, 10);
    await expect(meter.forward(Buffer.from('data'))).rejects.toThrow('issuer unavailable');
    expect(meter.bytesUsed).toBe(0);
  });

  it('uses the issuer verify and atomic settle endpoints', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ valid: true }), { status: 200 });
    }) as typeof fetch;
    const issuer = new HttpRelayIssuer('https://issuer.example/', fetchImpl);

    expect(await issuer.verify(['serialized-token'])).toBe(true);
    await issuer.settle('relay', 'serialized-token');

    expect(calls).toEqual([
      { url: 'https://issuer.example/verify', body: { tokens: ['serialized-token'] } },
      { url: 'https://issuer.example/settle', body: { merchantId: 'relay', tokens: ['serialized-token'] } },
    ]);
  });
});
