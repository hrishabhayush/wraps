// Demo research agent: quotes both services, reasons, refills when low, buys with tokens.
import { InsufficientTokensError, PaymentRefusedError, PrivatePayClient, Quote } from '@wraps/sdk';
import { tokensToRlusd } from '@wraps/issuer';
import { DeterministicReasoner, Observation, Plan, Purchase, Reasoner, Task } from './reasoner';

export interface AgentOptions {
  sdk: PrivatePayClient;
  merchantUrl: string;
  reasoner?: Reasoner;
  /** Refill when the balance drops below this many tokens. */
  refillBelow?: number;
  /** Tokens per refill. */
  refillAmount?: number;
  print?: (line: string) => void;
}

export interface TaskResult {
  task: Task;
  bought: { service: string; data: unknown }[];
  refused: string[];
}

export const DEMO_TASKS: Task[] = [
  { id: 't1', question: 'Is XRP under accumulation, and did Ripple Labs file anything material?', asset: 'XRP', company: 'Ripple Labs', needsFilings: true },
  { id: 't2', question: 'Quick flow check on ETH.', asset: 'ETH', company: '', needsFilings: false },
  { id: 't3', question: 'Due diligence on Circle: flows on USDC and latest filings.', asset: 'USDC', company: 'Circle', needsFilings: true },
  { id: 't4', question: 'Coinbase: COIN-related flows and filings.', asset: 'BTC', company: 'Coinbase', needsFilings: true },
  { id: 't5', question: 'Galaxy Digital: flows and filings.', asset: 'SOL', company: 'Galaxy Digital', needsFilings: true },
  { id: 't6', question: 'One more look at XRP flows.', asset: 'XRP', company: '', needsFilings: false },
];

export class ResearchAgent {
  private readonly reasoner: Reasoner;
  private readonly print: (line: string) => void;
  private readonly refillBelow: number;
  private readonly refillAmount: number;

  constructor(private readonly opts: AgentOptions) {
    this.reasoner = opts.reasoner ?? new DeterministicReasoner();
    this.print = opts.print ?? ((l) => console.log(l));
    this.refillBelow = opts.refillBelow ?? 6;
    this.refillAmount = opts.refillAmount ?? Math.min(20, opts.sdk.caps.maxTopUpTokens);
  }

  private say(line: string) {
    this.print(`  ${line}`);
  }

  async run(tasks: Task[] = DEMO_TASKS): Promise<TaskResult[]> {
    const { sdk } = this.opts;
    const results: TaskResult[] = [];
    for (const task of tasks) {
      if (sdk.budgetLeft === 0) {
        this.print(`Daily cap reached (${sdk.caps.dailyTokens} tokens). Stopping.`);
        break;
      }
      this.print(`\nTask: ${task.question}`);
      results.push(await this.runTask(task));
    }
    return results;
  }

  async runTask(task: Task): Promise<TaskResult> {
    const { sdk, merchantUrl } = this.opts;
    const result: TaskResult = { task, bought: [], refused: [] };
    const urls = {
      analytics: `${merchantUrl}/analytics?asset=${encodeURIComponent(task.asset)}`,
      filings: `${merchantUrl}/filings?company=${encodeURIComponent(task.company || task.asset)}`,
    };
    const quotes = (await Promise.all(Object.values(urls).map((u) => sdk.quote(u)))).filter((q): q is Quote => q !== null);
    const observe = (): Observation => ({ task, quotes, balance: sdk.balance, budgetLeft: sdk.budgetLeft, caps: sdk.caps });

    const queue: Plan[] = [await this.reasoner.plan(observe())];
    while (queue.length) {
      const plan = queue.shift()!;
      if (plan.thoughts.length) this.say(plan.thoughts.join(" "));
      for (const p of plan.buy) {
        const data = await this.buy(p, result);
        if (data === STOP) return result;
        if (data === undefined) continue;
        const follow = await this.reasoner.afterData?.(observe(), p.service, data);
        if (follow) queue.push(follow);
      }
    }
    return result;
  }

  private async buy(p: Purchase, result: TaskResult): Promise<unknown | typeof STOP | undefined> {
    const { sdk } = this.opts;
    try {
      await this.refillIfLow(p.price);
      const res = await sdk.fetch(p.url);
      const body = (await res.json()) as { data?: unknown; error?: string };
      if (!res.ok) {
        this.say(`${p.service}: merchant answered ${res.status} (${body.error}).`);
        return undefined;
      }
      result.bought.push({ service: p.service, data: body.data });
      this.say(`Bought ${p.service} for ${p.price} tokens: ${summarize(p.service, body.data)} Balance ${sdk.balance}, budget left ${sdk.budgetLeft}.`);
      return body.data;
    } catch (e) {
      if (e instanceof PaymentRefusedError) {
        result.refused.push(e.code);
        this.say(`SDK refused: ${e.message}. Stopping this task.`);
        return STOP;
      }
      throw e;
    }
  }

  private async refillIfLow(needed: number) {
    const { sdk } = this.opts;
    if (sdk.balance >= Math.max(needed, this.refillBelow)) return;
    const n = Math.max(this.refillAmount, needed - sdk.balance);
    this.say(`Balance ${sdk.balance} tokens, low. Refilling ${n} tokens (${tokensToRlusd(n)} RLUSD) via the issuer's 402.`);
    await sdk.topUp(n);
    this.say(`Refilled. Balance ${sdk.balance} tokens.`);
    if (sdk.balance < needed) throw new InsufficientTokensError(needed, sdk.balance);
  }
}

const STOP = Symbol('stop');

function summarize(service: string, data: any): string {
  if (service === 'analytics' && data) return `${data.asset} ${data.signal}, netflow ${data.exchangeNetflow}.`;
  if (service === 'filings' && data) return `${data.company}: ${data.latest?.[0]?.form} "${data.latest?.[0]?.summary}"`;
  return '';
}
