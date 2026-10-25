// JSON-line logger. In a production enclave stdout goes through a FIFO and
// vsock to the parent (journalctl -u ifi-logs). Anything logged here leaves the enclave.
//
// Rule: never log tokens, keys, IPs and merchant IDs together. Together they
// link a buyer to a purchase, which is the thing the system exists to hide.
// This logger drops the obvious fields. It cannot catch values hidden in a message string.

export type Level = 'debug' | 'info' | 'warn' | 'error';

const REDACT = new Set([
  'token',
  'tokens',
  'authorization',
  'key',
  'privatekey',
  'secret',
  'seed',
  'mnemonic',
  'ip',
  'remoteaddress',
  'clientip',
  'xforwardedfor',
  'nonce',
  'bootconfig',
]);

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = REDACT.has(k.toLowerCase().replace(/[-_]/g, '')) ? '[redacted]' : v;
  }
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe })}\n`);
}
