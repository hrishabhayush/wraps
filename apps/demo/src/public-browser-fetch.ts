import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { checkBrowserUrl, publicAddress } from './browser-safety';

// Pin the socket to a validated address; a second DNS lookup must not reach the LAN.
export async function publicBrowserFetch(value: string, redirects = 0): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(await checkBrowserUrl(value));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Private destination blocked');
  const pinned = addresses[0];
  const result = await new Promise<{ status: number; location?: string; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const req = request(url, {
      agent: false,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; WrapsResearch/1.0)', 'accept-encoding': 'identity' },
      signal: AbortSignal.timeout(15000),
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { res.destroy(new Error('Page exceeds research size limit')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'content-encoding', 'access-control-allow-origin']) {
          const value = res.headers[name]; if (typeof value === 'string') headers[name] = value;
        }
        resolve({ status: res.statusCode ?? 502, location: res.headers.location, headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject); req.end();
  });
  if (result.status >= 300 && result.status < 400 && result.location) {
    if (redirects >= 4) throw new Error('Too many redirects');
    return publicBrowserFetch(new URL(result.location, url).href, redirects + 1);
  }
  return result;
}
