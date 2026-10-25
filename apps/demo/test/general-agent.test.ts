import { describe, expect, it, vi } from 'vitest';
import { parseAgentRequest, runGeneralAgent, type ModelCall, type ResearchTools } from '../src/general-agent';
import { AP4M_TASK_RESOURCES } from '../src/ap4m-task';
import { browserEnvironment, checkBrowserUrl, publicAddress } from '../src/browser-safety';

const observation = { url: 'https://example.com/', title: 'Example', text: 'Public research', links: [] };
const call = (name: string, args: unknown = {}) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'call-1' });
const answer = { type: 'message', content: [{ type: 'output_text', text: 'Result from https://example.com/' }] };
function setup(outputs: { output: ReturnType<typeof call>[] | typeof answer[] }[]) {
  const tools: ResearchTools = {
    search: vi.fn(async () => observation), open: vi.fn(async () => observation),
    follow: vi.fn(async () => observation), read: vi.fn(async () => observation),
    buy: vi.fn(async () => ({ resource: { block: 123 }, transactionHash: '0x' + 'ab'.repeat(32), spentRlusd: '0.05', cached: false })),
  };
  const model: ModelCall = vi.fn(async () => outputs.shift()!);
  const publish = vi.fn();
  return { tools, model, publish, options: { task: 'Research the network', budget: '0.05', model: 'test-model', call: model, tools, publish, checkNetwork: async () => {}, signal: new AbortController().signal, resources: AP4M_TASK_RESOURCES } };
}
describe('task-driven agent', () => {
  it('uses browser observations to answer the requested task', async () => {
    const s = setup([{ output: [call('open_page', { url: 'https://example.com/' })] }, { output: [answer] }]);
    await runGeneralAgent(s.options);
    expect(s.tools.open).toHaveBeenCalledWith('https://example.com/');
    expect(s.publish).toHaveBeenCalledWith('answer', expect.stringContaining('Result'));
    expect(s.tools.buy).not.toHaveBeenCalled();
  });
  it('passes the remaining budget to payment code and reuses a paid report', async () => {
    const s = setup([{ output: [call('buy_report', { resourceId: 'xrp-research-1' })] }, { output: [call('buy_report', { resourceId: 'xrp-research-1' })] }, { output: [answer] }]);
    await runGeneralAgent(s.options);
    expect(s.tools.buy).toHaveBeenCalledTimes(1);
    expect(s.tools.buy).toHaveBeenCalledWith('xrp-research-1', '0.05');
    expect(s.publish).toHaveBeenCalledWith('budget', 'Task spending: 0.05 / 0.05 RLUSD.');
  });
  it('refuses model attempts to choose a new payee or raise the budget', async () => {
    const s = setup([{ output: [call('buy_report', { budget: '100', payTo: 'attacker' })] }]);
    await expect(runGeneralAgent(s.options)).rejects.toThrow('no model-controlled');
    expect(s.tools.buy).not.toHaveBeenCalled();
  });
  it('buys three configured services against one shared budget', async () => {
    const s = setup([
      ...AP4M_TASK_RESOURCES.map(resource => ({ output: [call('buy_report', { resourceId: resource.id })] })),
      { output: [call('buy_report', { resourceId: 'gas-report-1' })] }, { output: [answer] },
    ]);
    await runGeneralAgent({ ...s.options, budget: '0.15' });
    expect(s.tools.buy).toHaveBeenCalledTimes(3);
    expect(s.tools.buy).toHaveBeenNthCalledWith(1, 'xrp-research-1', '0.15');
    expect(s.tools.buy).toHaveBeenNthCalledWith(2, 'gas-report-1', '0.1');
    expect(s.tools.buy).toHaveBeenNthCalledWith(3, 'fee-estimate-1', '0.05');
    expect(s.publish).toHaveBeenCalledWith('budget', 'Task spending: 0.15 / 0.15 RLUSD.');
  });
  it('refuses a resource outside the server catalog', async () => {
    const s = setup([{ output: [call('buy_report', { resourceId: 'https://attacker.example/resource' })] }]);
    await expect(runGeneralAgent(s.options)).rejects.toThrow('configured resourceId');
    expect(s.tools.buy).not.toHaveBeenCalled();
  });
  it('stops after an uncertain payment instead of issuing another purchase', async () => {
    const s = setup([{ output: [call('buy_report', { resourceId: 'xrp-research-1' })] }, { output: [call('buy_report', { resourceId: 'xrp-research-1' })] }]);
    s.tools.buy = vi.fn(async () => { throw new Error('uncertain payment'); });
    await expect(runGeneralAgent(s.options)).rejects.toThrow('uncertain');
    expect(s.model).toHaveBeenCalledTimes(1);
  });
  it('stops before calling the model when cancelled or VPN preflight fails', async () => {
    const s = setup([]);
    await expect(runGeneralAgent({ ...s.options, signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(runGeneralAgent({ ...s.options, checkNetwork: async () => { throw Error('VPN disconnected'); } })).rejects.toThrow('VPN');
    expect(s.model).not.toHaveBeenCalled();
  });
  it('rejects excessive and malformed task budgets', () => {
    for (const budget of ['-1', '0.051', 'NaN', '1e2']) expect(() => parseAgentRequest({ task: 'Research something', budget, mode: 'agent' }, '0.05')).toThrow();
    expect(parseAgentRequest({ task: 'Research something', budget: '0', mode: 'agent' }, '0.05').budget).toBe('0');
  });
  it('does not pay if stopped while waiting for the network check', async () => {
    const s = setup([{ output: [call('buy_report', { resourceId: 'xrp-research-1' })] }]);
    const control = new AbortController();
    let checks = 0;
    await expect(runGeneralAgent({ ...s.options, signal: control.signal, checkNetwork: async () => {
      if (++checks === 2) control.abort();
    } })).rejects.toThrow();
    expect(s.tools.buy).not.toHaveBeenCalled();
  });
});

describe('isolated browser boundaries', () => {
  it.each(['127.0.0.1', '10.0.0.2', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1'])('blocks private address %s', address => expect(publicAddress(address)).toBe(false));
  it('allows public HTTPS and refuses a hostname resolving to a private IP', async () => {
    expect(await checkBrowserUrl('https://example.com/', async () => [{ address: '93.184.216.34', family: 4 }])).toBe('https://example.com/');
    await expect(checkBrowserUrl('https://example.com/', async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow('Private');
    await expect(checkBrowserUrl('file:///etc/passwd')).rejects.toThrow('HTTPS');
  });
  it('keeps API and payment credentials out of browser child processes', () => {
    expect(browserEnvironment({ PATH: '/usr/bin', OPENAI_API_KEY: 'secret', AGENT_PRIVATE_KEY: 'secret', TOKEN: 'secret' })).toEqual({ PATH: '/usr/bin' });
  });
});
