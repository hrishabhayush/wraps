import { describe, expect, it } from 'vitest';
import { AttestationError } from '@wraps/attestation';
import { startIssuer, type StartIssuerOptions } from '@wraps/issuer';
import { isTamperRefusal, runPrivateAgent } from '../src/agent-run';

type Event = { type: string; data: unknown };

async function run(start?: typeof startIssuer): Promise<Event[]> {
  const events: Event[] = [];
  await runPrivateAgent((type, data) => events.push({ type, data }), { tamper: true, startIssuer: start });
  return events;
}

const types = (events: Event[]) => events.map((e) => e.type);

describe('tamper test', () => {
  it('labels only measurement mismatches as a tamper refusal', () => {
    expect(isTamperRefusal(new AttestationError('PCR_MISMATCH', 'x'))).toBe(true);
    expect(isTamperRefusal(new AttestationError('IMAGE_MISMATCH', 'x'))).toBe(true);
    for (const code of ['DEBUG_MODE', 'NONCE_MISMATCH', 'KEY_MISMATCH', 'BAD_SIGNATURE', 'MALFORMED'] as const) {
      expect(isTamperRefusal(new AttestationError(code, 'x'))).toBe(false);
    }
    expect(isTamperRefusal(new Error('PCR_MISMATCH'))).toBe(false);
  });

  it('shows tamper-refused with PCR_MISMATCH and buys nothing', async () => {
    const events = await run();
    const refused = events.find((e) => e.type === 'tamper-refused');
    expect(refused?.data).toMatchObject({ code: 'PCR_MISMATCH' });
    expect(types(events)).not.toContain('error');
    expect(types(events).filter((t) => t.startsWith('sdk:'))).toEqual([]);
  });

  it('reports an issuer that fails to start as an error, not a tamper refusal', async () => {
    const failing = (async (o: StartIssuerOptions) => {
      if (o.buildName === 'issuer-tampered') throw new Error('listen EADDRINUSE');
      return startIssuer(o);
    }) as typeof startIssuer;
    const events = await run(failing);
    expect(types(events)).not.toContain('tamper-refused');
    expect(events.find((e) => e.type === 'error')?.data).toEqual({ message: 'listen EADDRINUSE' });
  });

  it('reports a different attestation refusal (debug mode) as an error', async () => {
    const debug = ((o: StartIssuerOptions) =>
      startIssuer(o.buildName === 'issuer-tampered' ? { ...o, buildName: 'issuer', debugMode: true } : o)) as typeof startIssuer;
    const events = await run(debug);
    expect(types(events)).not.toContain('tamper-refused');
    expect((events.find((e) => e.type === 'error')?.data as { message: string }).message).toMatch(/DEBUG_MODE/);
  });

  it('reports an accepted tampered issuer as an error', async () => {
    const honest = ((o: StartIssuerOptions) => startIssuer({ ...o, buildName: 'issuer' })) as typeof startIssuer;
    const events = await run(honest);
    expect(types(events)).not.toContain('tamper-refused');
    expect((events.find((e) => e.type === 'error')?.data as { message: string }).message).toMatch(/accepted the tampered issuer/);
    expect(types(events)).not.toContain('sdk:paid');
  });
});
