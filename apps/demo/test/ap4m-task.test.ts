import { describe, expect, it, vi } from 'vitest';
import { AP4M_TASK_RESOURCES, runPaymentTask } from '../src/ap4m-task';

const paid = { resource: { report: 'test' }, transactionHash: '0x' + 'ab'.repeat(32), spentRlusd: '0.05', cached: false };
const options = () => ({ resources: AP4M_TASK_RESOURCES, budget: '0.15', signal: new AbortController().signal,
  buy: vi.fn(async (_id: string, _budget: string) => paid), publish: vi.fn() });

describe('three-service x402 task', () => {
  it('pays sequentially with the remaining budget and returns all receipts', async () => {
    const s = options();
    expect(await runPaymentTask(s)).toHaveLength(3);
    expect(s.buy.mock.calls).toEqual([['xrp-research-1', '0.15'], ['gas-report-1', '0.1'], ['fee-estimate-1', '0.05']]);
    expect(s.publish).toHaveBeenCalledWith('budget', 'Task spending: 0.15 / 0.15 RLUSD.');
  });
  it('reuses completed results for free when resuming the task', async () => {
    const s = options();
    s.buy.mockResolvedValueOnce({ ...paid, cached: true, spentRlusd: '0' });
    await runPaymentTask(s);
    expect(s.buy.mock.calls[1]).toEqual(['gas-report-1', '0.15']);
    expect(s.publish).toHaveBeenCalledWith('budget', 'Task spending: 0.1 / 0.15 RLUSD.');
  });
  it('stops on an unresolved payment or cancellation before buying the next service', async () => {
    const s = options();
    s.buy.mockRejectedValueOnce(new Error('redemption uncertain'));
    await expect(runPaymentTask(s)).rejects.toThrow('uncertain');
    expect(s.buy).toHaveBeenCalledTimes(1);
    s.buy.mockClear();
    const control = new AbortController();
    s.buy.mockImplementationOnce(async () => { control.abort(); return paid; });
    await expect(runPaymentTask({ ...s, signal: control.signal })).rejects.toThrow();
    expect(s.buy).toHaveBeenCalledTimes(1);
  });
});
