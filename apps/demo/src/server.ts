// npm run demo
// Serves the split-screen page. Set DEMO_HOST / DEMO_PORT to change the listener.
import { createDemoApp, LiveDemoController } from './app';
import { PrivateCacheDir } from './cache';
import { controlPolicy } from './control';

const PORT = Number(process.env.DEMO_PORT ?? 4174);
const HOST = process.env.DEMO_HOST ?? '127.0.0.1';
const LIVE_MODE = process.env.DEMO_LIVE === '1';

const cache = await PrivateCacheDir.create();
const policy = controlPolicy(HOST);
const app = createDemoApp({
  policy,
  liveMode: LIVE_MODE,
  controller: (publish) => new LiveDemoController(publish, {
    cache,
    quicknodeUrl: process.env.QUICKNODE_XRPL_URL,
    liveMode: LIVE_MODE,
  }),
});

app.server.listen(PORT, HOST, () => {
  const base = `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;
  app.publish('system', 'ready', {
    url: base,
    liveMode: LIVE_MODE,
    message: LIVE_MODE ? 'Live demo server ready; starting the live services now.' : 'Split-screen demo server ready.',
  });
  console.log(`${LIVE_MODE ? 'Live demo' : 'Demo'} ready at ${base}`);
  console.log(`Caches: ${cache.path} (private, removed on exit)`);
  if (policy.token) {
    console.log(`DEMO_HOST ${HOST} is not loopback. Start and Stop need this token.`);
    console.log(`Open ${base}/#token=${policy.token}`);
  }
  if (LIVE_MODE) {
    if (!process.env.DEMO_MERCHANT_URL) console.log('Local merchant exposure uses cloudflared; install it with: brew install cloudflared');
    console.log('Live service verification starts automatically. If a live endpoint is unavailable, the page offers a clearly labeled local mock run.');
    setTimeout(() => app.controller.start(), 0);
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.shutdown();
  await cache.remove();
  app.server.close(() => process.exit(0));
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
