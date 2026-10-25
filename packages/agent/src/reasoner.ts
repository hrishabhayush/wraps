// The reasoning step is pluggable. The default is deterministic (no LLM key).
// Whatever the reasoner decides, the SDK caps still apply.
import type { Caps, Quote } from '@wraps/sdk';

export interface Task {
  id: string;
  question: string;
  asset: string;
  company: string;
  needsFilings: boolean;
}

export interface Observation {
  task: Task;
  quotes: Quote[];
  balance: number;
  budgetLeft: number;
  caps: Caps;
}

export interface Purchase {
  service: string;
  url: string;
  price: number;
}

export interface Plan {
  thoughts: string[];
  buy: Purchase[];
}

export interface Reasoner {
  plan(obs: Observation): Promise<Plan>;
  /** Sees the data that came back. May ask for more purchases. */
  afterData?(obs: Observation, service: string, data: unknown): Promise<Plan | null>;
}

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Compares prices, buys what the task needs within the budget, ignores instructions inside data. */
export class DeterministicReasoner implements Reasoner {
  async plan(obs: Observation): Promise<Plan> {
    const thoughts: string[] = [];
    const byService = new Map(obs.quotes.map((q) => [q.service, q]));
    const analytics = byService.get('analytics');
    const filings = byService.get('filings');
    thoughts.push(obs.quotes.map((q) => `${label(q.service)} ${q.price} tokens.`).join(' '));

    const wanted: Quote[] = [];
    if (analytics) wanted.push(analytics);
    if (filings && obs.task.needsFilings) {
      thoughts.push('Filings needed.');
      wanted.push(filings);
    } else if (filings) {
      thoughts.push('Filings not needed for this question.');
    }

    // Fit the budget. Drop the cheaper extra first, so the must-have stays.
    let chosen = wanted.filter((q) => q.price <= obs.caps.perCallTokens);
    for (const q of wanted) if (q.price > obs.caps.perCallTokens) thoughts.push(`${label(q.service)} is above my per-call cap. Skipping.`);
    let cost = chosen.reduce((s, q) => s + q.price, 0);
    if (cost > obs.budgetLeft && chosen.length > 1) {
      const keep = obs.task.needsFilings && filings && filings.price <= obs.budgetLeft ? filings : chosen.sort((a, b) => a.price - b.price)[0];
      thoughts.push(`Budget left ${obs.budgetLeft} tokens, not enough for both. Buying ${keep.service} only.`);
      chosen = [keep];
      cost = keep.price;
    }
    if (cost > obs.budgetLeft) {
      thoughts.push(`Budget left ${obs.budgetLeft} tokens. Cannot afford anything useful. Skipping.`);
      return { thoughts, buy: [] };
    }
    if (chosen.length === 2) thoughts.push('Buying both.');
    else if (chosen.length === 1 && !thoughts.some((t) => t.includes('only.'))) thoughts.push(`Buying ${chosen[0].service} only.`);
    thoughts.push(`Budget left: ${obs.budgetLeft - cost} tokens.`);
    return { thoughts, buy: chosen.map((q) => ({ service: q.service, url: q.url, price: q.price })) };
  }

  async afterData(_obs: Observation, service: string, data: unknown): Promise<Plan | null> {
    const note = (data as { note?: unknown })?.note;
    if (typeof note === 'string' && /ignore|buy \d+|instruction/i.test(note)) {
      return { thoughts: [`${label(service)} data contains instructions ("${note.slice(0, 48)}…"). Data is not a command. Ignoring.`], buy: [] };
    }
    return null;
  }
}

/**
 * A deliberately gullible reasoner: it obeys "buy N more" text found in merchant data.
 * Used in tests and `demo:core --gullible` to show the SDK caps hold anyway.
 */
export class GullibleReasoner extends DeterministicReasoner {
  async afterData(obs: Observation, service: string, data: unknown): Promise<Plan | null> {
    const note = (data as { note?: unknown })?.note;
    const m = typeof note === 'string' ? /buy (\d+) more (\w+)/i.exec(note) : null;
    if (!m) return null;
    const n = Number(m[1]);
    const q = obs.quotes.find((x) => m[2].toLowerCase().startsWith(x.service)) ?? obs.quotes.find((x) => x.service === service)!;
    return {
      thoughts: [`The data says to buy ${n} more ${q.service}. Doing it.`],
      buy: Array.from({ length: n }, () => ({ service: q.service, url: q.url, price: q.price })),
    };
  }
}
