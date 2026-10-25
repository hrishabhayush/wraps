// Shares only the capped visitor gateway, never the private wallet/dashboard port.
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSponsoredGateway } from '../apps/demo/src/sponsored-gateway';
import { SponsoredQuota } from '../apps/demo/src/sponsored-quota';
import { browserEnvironment } from '../apps/demo/src/browser-safety';

const backend = 'http://127.0.0.1:4177';
let tunnel: ChildProcess | undefined, gateway: ReturnType<typeof createSponsoredGateway> | undefined;
let closing = false;
async function close() {
  if (closing) return; closing = true;
  tunnel?.kill('SIGTERM');
  await gateway?.close();
}
try {
  const response = await fetch(backend + '/api/status', { signal: AbortSignal.timeout(5000) });
  const state = await response.json();
  if (state.shareProtocol !== 1) throw Error('Restart npm run ap4m:demo in the terminal holding your keys, then run this command again.');
  if (!state.payments || !state.modelReady) throw Error('Start the live AP4M demo with both keys before sharing.');
  if (state.network.ip !== state.expectedIp) console.log('Host VPN offline: public runs will remain paused until Wraps reconnects.');
  tunnel = spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:4179', '--no-autoupdate', '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: browserEnvironment(process.env),
  });
  const origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Cloudflare did not issue a temporary URL within 45 seconds.')), 45000);
    let output = '';
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16000);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    };
    tunnel!.stdout!.on('data', receive); tunnel!.stderr!.on('data', receive);
    tunnel!.once('error', () => { clearTimeout(timeout); reject(Error('Install cloudflared first: brew install cloudflared')); });
    tunnel!.once('exit', () => { clearTimeout(timeout); reject(Error('Cloudflare exited before the public link was ready.')); });
  });
  gateway = createSponsoredGateway({ origin, backend, quota: new SponsoredQuota(join(homedir(), '.local/state/wraps/public-demo/runs')) });
  await new Promise<void>((resolve, reject) => { gateway!.server.once('error', reject); gateway!.server.listen(4179, '127.0.0.1', resolve); });
  console.log(`Temporary public demo: ${origin}`);
  console.log('10 sponsored attempts total; one visitor run at a time. Previously purchased reports are reused.');
  console.log('Keep this terminal, the AP4M demo and Wraps VPN running. Ctrl+C closes public access.');
  console.log('This share link expires automatically after two hours.');
  const expiry = setTimeout(() => void close(), 2 * 60 * 60 * 1000);
  tunnel.once('exit', () => { clearTimeout(expiry); void close(); });
  process.once('SIGINT', () => { clearTimeout(expiry); void close(); });
  process.once('SIGTERM', () => { clearTimeout(expiry); void close(); });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Sharing failed');
  process.exitCode = 1; await close();
}
