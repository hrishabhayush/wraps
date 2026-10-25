// Boot config: runtime values the image must not contain (RPC URLs with API
// keys, the issuer payout wallet key). A production enclave has no env vars
// and no disk, so the parent pushes one JSON document over vsock after boot.
//
//   parent:  infra/scripts/deploy.sh pushes /etc/ifi/<role>.boot.json
//   enclave: socat VSOCK-LISTEN:7000 -> TCP 127.0.0.1:7000 -> this server
//
// The first valid document wins. The listener then closes, so nobody can
// replace it later. The config is NOT in the attestation: treat it as operator input.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { enclaveMode } from './mode';
import { log } from './log';

const MAX_BYTES = 64 * 1024;

export interface BootConfigOptions {
  /** Port inside the enclave. Default BOOT_CONFIG_PORT or 7000. */
  port?: number;
  /** Give up after this long. Default: wait forever. */
  timeoutMs?: number;
  /** Docker mode: file to read instead. Default BOOT_CONFIG_FILE or /run/ifi/boot.json. */
  file?: string;
}

export async function waitForBootConfig<T = Record<string, unknown>>(opts: BootConfigOptions = {}): Promise<T> {
  if (enclaveMode() === 'docker') {
    const file = opts.file ?? process.env.BOOT_CONFIG_FILE ?? '/run/ifi/boot.json';
    if (!existsSync(file)) {
      log('warn', 'no boot config file, using empty config', { file });
      return {} as T;
    }
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  }

  const port = opts.port ?? Number(process.env.BOOT_CONFIG_PORT ?? 7000);
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const server = createServer((sock) => {
      const chunks: Buffer[] = [];
      let size = 0;
      sock.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) sock.destroy();
        else chunks.push(c);
      });
      sock.on('end', () => {
        if (done) return void sock.end('already configured\n');
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
          done = true;
          sock.end('ok\n');
          server.close();
          if (timer) clearTimeout(timer);
          log('info', 'boot config received', { bytes: size });
          resolve(value);
        } catch {
          sock.end('bad json\n');
        }
      });
      sock.on('error', () => undefined);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          server.close();
          reject(new Error('timed out waiting for boot config'));
        }, opts.timeoutMs)
      : undefined;
    server.listen(port, '127.0.0.1', () => log('info', 'waiting for boot config', { port }));
  });
}
