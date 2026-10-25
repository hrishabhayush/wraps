import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';

let readyCount = 0;
const ready = () => {
  readyCount += 1;
  if (readyCount === 3) process.stdout.write('MOCK_READY\n');
};

for (const port of [443, 8080]) {
  createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`mock-endpoint:${port}`);
  }).listen(port, '0.0.0.0', ready);
}

const dns = createSocket('udp4');
dns.on('message', (_message, remote) => {
  process.stdout.write('DNS_QUERY\n');
  dns.send(Buffer.from('mock-dns-response'), remote.port, remote.address);
});
dns.bind(53, '0.0.0.0', ready);
