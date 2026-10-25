import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveDemoController } from '../src/app';
import { runLivePrivateAgent } from '../src/live-agent-run';
import { LiveConfigError } from '../../../scripts/live-config';
import type { DemoEvent } from '../src/app';

describe('live demo fallback', () => {
  it('labels an unavailable GCP service and offers mock fallback without pretending it is live', async () => {
    const events: { type: string; data: unknown }[] = [];
    const result = await runLivePrivateAgent((type, data) => events.push({ type, data }), {
      dependencies: {
        resolveConfig: async () => { throw new LiveConfigError('issuer VM is TERMINATED; start it with gcloud compute instances start wraps-issuer', 'issuer'); },
        createRelay: async () => { throw new Error('must not be called'); },
        createTunnel: async () => { throw new Error('must not be called'); },
      },
    });
    expect(result.fallbackAvailable).toBe(true);
    expect(events.find((event) => event.type === 'live-unavailable')?.data).toMatchObject({
      message: expect.stringContaining('No local run is being presented as live'),
    });
  });

  it('offers an explicitly local mock run when live services are unavailable', async () => {
    const events: DemoEvent[] = [];
    const liveRun = vi.fn(async (publish: (type: string, data?: unknown) => void) => {
      publish('live-unavailable', { message: 'Live services unavailable; choose local mock.' });
      return { fallbackAvailable: true };
    });
    const mockRun = vi.fn(async (publish: (type: string, data?: unknown) => void) => {
      publish('status', { message: 'Local mock issuer and merchant started.' });
    });
    const controller = new LiveDemoController((panel, type, data) => {
      events.push({ id: events.length + 1, at: new Date().toISOString(), panel, type, data });
    }, {
      cache: {} as never,
      liveMode: true,
      startSpy: async () => {},
      runLive: liveRun as never,
      runMock: mockRun as never,
    });

    expect(controller.start()).toBe(true);
    await vi.waitFor(() => expect(controller.fallbackAvailable).toBe(true));
    expect(events.some((event) => event.type === 'live-unavailable')).toBe(true);
    expect(events.some((event) => event.panel === 'system' && (event.data as any).fallbackAvailable)).toBe(true);
    expect(controller.start('mock')).toBe(true);
    await vi.waitFor(() => expect(mockRun).toHaveBeenCalledTimes(1));
    expect(events.some((event) => event.panel === 'system' && /Local mock run started/.test((event.data as any).message))).toBe(true);

    await controller.stop();
  });
});
