import { formatUnits, parseUnits } from 'ethers';
import type { PaidResource } from './browser-payment';

export const AP4M_TASK = 'Buy the network snapshot, gas utilization report, and transfer fee estimate using x402. Show all three results and payment receipts within 0.15 testnet RLUSD.';
export const AP4M_TASK_RESOURCES: PaidResource[] = [
  { id: 'xrp-research-1', description: 'Saved XRPL EVM testnet network snapshot (0.05 RLUSD).', url: 'http://127.0.0.1:4180/resource' },
  { id: 'gas-report-1', description: 'Saved XRPL EVM testnet block gas utilization report (0.05 RLUSD).', url: 'http://127.0.0.1:4181/resource' },
  { id: 'fee-estimate-1', description: 'Saved XRPL EVM testnet gas price and native transfer fee estimate (0.05 RLUSD).', url: 'http://127.0.0.1:4182/resource' },
];

export interface PurchaseResult { resource: unknown; transactionHash: string; spentRlusd: string; cached: boolean }

/** Sequential purchases let each voucher use the previous confirmed cumulative amount. */
export async function runPaymentTask(options: {
  resources: PaidResource[]; budget: string; signal: AbortSignal;
  buy(resourceId: string, budget: string): Promise<PurchaseResult>;
  publish(type: string, message: string): void;
}) {
  let spent = 0n;
  const limit = parseUnits(options.budget, 18);
  const results = [];
  for (const resource of options.resources) {
    options.signal.throwIfAborted();
    options.publish('action', `Purchasing ${resource.description}`);
    const result = await options.buy(resource.id, formatUnits(limit - spent, 18));
    const cost = parseUnits(result.spentRlusd, 18);
    if (cost < 0n || cost > limit - spent) throw new Error('Payment result exceeds the task budget');
    spent += cost;
    results.push({ id: resource.id, ...result });
    options.publish('transaction', result.transactionHash);
    options.publish('payment', result.cached ? `${resource.id}: saved result retrieved; no additional charge.` : `${resource.id}: paid ${result.spentRlusd} RLUSD.`);
    options.publish('budget', `Task spending: ${formatUnits(spent, 18)} / ${options.budget} RLUSD.`);
  }
  return results;
}
