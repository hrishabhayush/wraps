import { test } from 'node:test';
import assert from 'node:assert/strict';

test('desktop connect sends one stored token to Tauri without passing a mint count', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          return { status: 'connected', inputTokenDisposition: 'spent', tokens: 1, megabytes: 10 };
        },
      },
    },
  });

  try {
    const { TauriBackend } = await import('./backend.ts');
    const backend = new TauriBackend();
    const result = await backend.connect('usc1', 'opaque-blind-token');
    assert.deepEqual(calls[0], { command: 'vpn_connect', args: { token: 'opaque-blind-token' } });
    assert.deepEqual(result, { status: 'connected', inputTokenDisposition: 'spent', tokens: 1, megabytes: 10 });
    await backend.finalizeConnect();
    assert.equal(calls[1].command, 'vpn_finalize_connect');
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
