import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SignedClaim, SignedPayoutRecord } from './protocol';

export interface IssuerTabState {
  earned: number;
  paid: number;
  seq: number;
}

export interface IssuerSettlementState {
  merchantId: string;
  quoteId?: string;
  fingerprint: string;
  /** Exact canonical token encodings accepted by this settlement. */
  tokens: string[];
  result: SignedClaim;
}

export interface InFlightPayoutRecord {
  merchantId: string;
  hash: string;
  raw: string;
  nonce: number;
  amountTokens: number;
  payTo: string;
}

export interface MerchantNonceRecord {
  merchantId: string;
  nonce: string;
  timestamp: number;
}

/** Keys are deliberately absent: they are generated in memory and do not survive issuer restart. */
export interface IssuerStateSnapshot {
  version: 1;
  spent: string[];
  settlements: IssuerSettlementState[];
  tabs: Record<string, IssuerTabState>;
  fundsHeld: number;
  unspentIssued: number;
  payouts: Record<string, SignedPayoutRecord[]>;
  inFlightPayouts: InFlightPayoutRecord[];
  merchantNonces: MerchantNonceRecord[];
}

export interface IssuerStateStore {
  load(): Promise<IssuerStateSnapshot | undefined>;
  /** Append a complete state snapshot before the operation is acknowledged. */
  append(snapshot: IssuerStateSnapshot): Promise<void>;
}

/** Default store for tests and the current Confidential Space image. */
export class MemoryIssuerStateStore implements IssuerStateStore {
  private latest?: IssuerStateSnapshot;

  async load(): Promise<IssuerStateSnapshot | undefined> {
    return this.latest ? clone(this.latest) : undefined;
  }

  async append(snapshot: IssuerStateSnapshot): Promise<void> {
    this.latest = clone(snapshot);
  }
}

/** Local/non-enclave append-only state journal with a sequence and SHA-256 hash chain. */
export class FileIssuerStateStore implements IssuerStateStore {
  private loaded = false;
  private sequence = 0;
  private previousHash = '0'.repeat(64);

  constructor(readonly path: string) {}

  private get headPath(): string { return `${this.path}.head`; }

  async load(): Promise<IssuerStateSnapshot | undefined> {
    let data: Buffer;
    try {
      data = await readFile(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await readFile(this.headPath);
          throw new Error(`issuer state journal is missing but its monotonic head exists: ${this.path}`);
        } catch (headError) {
          if ((headError as NodeJS.ErrnoException).code !== 'ENOENT') throw headError;
        }
        this.loaded = true;
        this.sequence = 0;
        this.previousHash = '0'.repeat(64);
        return undefined;
      }
      throw e;
    }
    if (data.length === 0) {
      try {
        await readFile(this.headPath);
        throw new Error(`issuer state journal was truncated to empty: ${this.path}`);
      } catch (headError) {
        if ((headError as NodeJS.ErrnoException).code !== 'ENOENT') throw headError;
      }
      this.loaded = true;
      this.sequence = 0;
      this.previousHash = '0'.repeat(64);
      return undefined;
    }
    if (data[data.length - 1] !== 0x0a) throw new Error(`issuer state journal is truncated (missing final newline): ${this.path}`);

    const lines = data.toString('utf8').slice(0, -1).split('\n');
    let expectedPrevious = '0'.repeat(64);
    let last: IssuerStateSnapshot | undefined;
    let sequence = 0;
    let hashes: string[] = ['0'.repeat(64)];
    for (const line of lines) {
      sequence += 1;
      let record: JournalRecord;
      try {
        record = JSON.parse(line) as JournalRecord;
      } catch {
        throw new Error(`issuer state journal record ${sequence} is malformed: ${this.path}`);
      }
      if (record.version !== 1 || record.sequence !== sequence || record.previousHash !== expectedPrevious || !isSnapshot(record.state)) {
        throw new Error(`issuer state journal chain is invalid at record ${sequence}: ${this.path}`);
      }
      const hash = journalHash(record.sequence, record.previousHash, record.state);
      if (record.hash !== hash) throw new Error(`issuer state journal hash mismatch at record ${sequence}: ${this.path}`);
      expectedPrevious = hash;
      hashes.push(hash);
      last = record.state;
    }
    let head: JournalHead;
    try {
      head = JSON.parse(await readFile(this.headPath, 'utf8')) as JournalHead;
    } catch (e) {
      throw new Error(`issuer state journal has no readable monotonic head: ${this.path}; ${(e as Error).message}`);
    }
    if (head.version !== 1 || !Number.isSafeInteger(head.sequence) || typeof head.hash !== 'string' || !/^[0-9a-f]{64}$/.test(head.hash)) {
      throw new Error(`issuer state monotonic head is malformed: ${this.headPath}`);
    }
    if (sequence < head.sequence || sequence > head.sequence + 1 || hashes[head.sequence] !== head.hash) {
      throw new Error(`issuer state journal rollback or head mismatch: ${this.path}`);
    }
    // A process can die after fsyncing one journal record but before replacing the head. The
    // single valid extension is safe to adopt; an older journal is always rejected.
    if (sequence === head.sequence + 1) await this.writeHead(sequence, expectedPrevious);
    this.loaded = true;
    this.sequence = sequence;
    this.previousHash = expectedPrevious;
    return last ? clone(last) : undefined;
  }

  async append(snapshot: IssuerStateSnapshot): Promise<void> {
    if (!this.loaded) throw new Error('issuer state journal must be loaded before append');
    const nextSequence = this.sequence + 1;
    const hash = journalHash(nextSequence, this.previousHash, snapshot);
    const line: JournalRecord = {
      version: 1,
      sequence: nextSequence,
      previousHash: this.previousHash,
      state: clone(snapshot),
      hash,
    };
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const file = await open(this.path, 'a', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(line)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await this.writeHead(nextSequence, hash);
    } catch (e) {
      // A failed append may have left a partial record or a journal/head mismatch. Do not
      // acknowledge later state changes from this instance until it has reloaded and verified.
      this.loaded = false;
      throw e;
    }
    this.sequence = nextSequence;
    this.previousHash = hash;
  }

  private async writeHead(sequence: number, hash: string): Promise<void> {
    const tmp = `${this.headPath}.tmp`;
    const file = await open(tmp, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, sequence, hash }), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, this.headPath);
    const dir = await open(dirname(this.path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

interface JournalRecord {
  version: 1;
  sequence: number;
  previousHash: string;
  state: IssuerStateSnapshot;
  hash: string;
}

interface JournalHead {
  version: 1;
  sequence: number;
  hash: string;
}

function journalHash(sequence: number, previousHash: string, state: IssuerStateSnapshot): string {
  return createHash('sha256').update(canonical({ version: 1, sequence, previousHash, state })).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isSnapshot(value: unknown): value is IssuerStateSnapshot {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<IssuerStateSnapshot>;
  return state.version === 1 && Array.isArray(state.spent) && Array.isArray(state.settlements) &&
    !!state.tabs && typeof state.tabs === 'object' && Number.isSafeInteger(state.fundsHeld) &&
    Number.isSafeInteger(state.unspentIssued) && !!state.payouts && typeof state.payouts === 'object' &&
    Array.isArray(state.inFlightPayouts) && Array.isArray(state.merchantNonces);
}
