import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';

const deniedIp = process.env.WRAPS_EGRESS_TEST_DENIED_IP;
assert.ok(deniedIp, 'control probe needs a numeric mock endpoint IP');
const response = await fetch(`http://${deniedIp}:443/health`, { signal: AbortSignal.timeout(1200) });
assert.equal(response.status, 200, 'unfiltered control container must reach the mock endpoint');

const dnsSocket = createSocket('udp4');
const dnsReached = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('mock DNS endpoint did not answer the control container')), 1200);
  dnsSocket.once('message', (message) => {
    clearTimeout(timer);
    resolve(message.toString() === 'mock-dns-response');
  });
  dnsSocket.send(Buffer.from('control DNS request'), 53, deniedIp, (error) => {
    if (error) { clearTimeout(timer); reject(error); }
  });
});
dnsSocket.close();
assert.equal(dnsReached, true, 'unfiltered control container must reach mock DNS');
process.stdout.write('unfiltered control endpoint reachable\n');
