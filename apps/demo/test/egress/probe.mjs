import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';

const relayIp = process.env.WRAPS_RELAY_IP;
const deniedIp = process.env.WRAPS_EGRESS_TEST_DENIED_IP;
assert.ok(relayIp && deniedIp, 'probe needs numeric mock relay and denied endpoint IPs');

for (const port of [443, 8080]) {
  const response = await fetch(`http://${relayIp}:${port}/health`, { signal: AbortSignal.timeout(1200) });
  assert.equal(response.status, 200, `relay port ${port} should be reachable`);
  assert.equal(await response.text(), `mock-endpoint:${port}`);
}

let arbitraryAllowed = false;
try {
  await fetch(`http://${deniedIp}:443/health`, { signal: AbortSignal.timeout(700) });
  arbitraryAllowed = true;
} catch {
  // Expected: OUTPUT default DROP prevents a connection to any non-relay IP.
}
assert.equal(arbitraryAllowed, false, 'non-relay HTTP endpoint must be unreachable');

const dnsSocket = createSocket('udp4');
const dnsReached = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 700);
  dnsSocket.once('message', () => { clearTimeout(timer); resolve(true); });
  dnsSocket.send(Buffer.from('mock DNS request'), 53, deniedIp, (error) => {
    if (error) { clearTimeout(timer); resolve(false); }
  });
});
dnsSocket.close();
assert.equal(dnsReached, false, 'DNS request to a reachable mock resolver must be dropped');
process.stdout.write('relay-only egress probe passed\n');
