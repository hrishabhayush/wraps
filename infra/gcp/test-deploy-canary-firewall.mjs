#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wraps-canary-firewall-'));
const gcpDir = path.join(tempRoot, 'infra/gcp');
const stateDir = path.join(gcpDir, '.state');
const binDir = path.join(tempRoot, 'bin');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });

try {
  fs.copyFileSync(path.join(repoRoot, 'infra/gcp/deploy.sh'), path.join(gcpDir, 'deploy.sh'));
  fs.copyFileSync(path.join(repoRoot, 'infra/gcp/lib.sh'), path.join(gcpDir, 'lib.sh'));
  fs.copyFileSync(path.join(repoRoot, 'infra/gcp/relay.Dockerfile'), path.join(gcpDir, 'relay.Dockerfile'));
  fs.writeFileSync(path.join(gcpDir, 'expected.json'), JSON.stringify({
    roles: {
      relay: {
        imageReference: `us-central1-docker.pkg.dev/wraps-hack/wraps/relay@sha256:${'a'.repeat(64)}`,
        config: { gcpWifProvider: 'projects/123456789012/locations/global/workloadIdentityPools/wraps-attested/providers/wraps-cs' },
      },
    },
  }));
  fs.writeFileSync(path.join(stateDir, 'issuer-state.env'), [
    'export GCP_WIF_PROVIDER=projects/123456789012/locations/global/workloadIdentityPools/wraps-attested/providers/wraps-cs',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(stateDir, 'merchant-auth.env'), [
    'export ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION=projects/wraps-hack/secrets/wraps-relay-settle-key/versions/1',
  ].join('\n') + '\n');

  const mockGcloudPath = path.join(binDir, 'gcloud');
  fs.writeFileSync(mockGcloudPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${'${MOCK_LOG}'}"
case " $* " in
  *" compute instances describe "*)
    if [ ! -f "${'${MOCK_VM_CREATED}'}" ]; then exit 1; fi
    case "$*" in
      *natIP*) printf '203.0.113.42\\n' ;;
      *) printf 'wraps-relay-canary\\n' ;;
    esac
    ;;
  *" firewall-rules describe wraps-allow-wireguard-canary "*)
    if [ ! -f "${'${MOCK_ALLOW_CREATED}'}" ]; then exit 1; fi
    node -e 'console.log(JSON.stringify({direction:"INGRESS",priority:300,network:"https://www.googleapis.com/compute/v1/projects/wraps-hack/global/networks/default",sourceRanges:process.env.WG_CANARY_SOURCE_RANGES.split(","),targetTags:["relay-canary"],allowed:[{IPProtocol:"udp",ports:["51820"]}],denied:[]}))'
    ;;
  *" firewall-rules create wraps-allow-wireguard-canary "*) touch "${'${MOCK_ALLOW_CREATED}'}" ;;
  *" firewall-rules describe wraps-relay-canary-deny-ipv6 "*)
    if [ ! -f "${'${MOCK_DENY_IPV6_CREATED}'}" ]; then exit 1; fi
    node -e 'console.log(JSON.stringify({direction:"INGRESS",priority:500,network:"https://www.googleapis.com/compute/v1/projects/wraps-hack/global/networks/default",sourceRanges:["::/0"],targetTags:["relay-canary"],denied:[{IPProtocol:"all"}],allowed:[]}))'
    ;;
  *" firewall-rules create wraps-relay-canary-deny-ipv6 "*) touch "${'${MOCK_DENY_IPV6_CREATED}'}" ;;
  *" firewall-rules describe wraps-relay-canary-deny "*)
    if [ ! -f "${'${MOCK_DENY_IPV4_CREATED}'}" ]; then exit 1; fi
    node -e 'console.log(JSON.stringify({direction:"INGRESS",priority:500,network:"https://www.googleapis.com/compute/v1/projects/wraps-hack/global/networks/default",sourceRanges:["0.0.0.0/0"],targetTags:["relay-canary"],denied:[{IPProtocol:"all"}],allowed:[]}))'
    ;;
  *" firewall-rules create wraps-relay-canary-deny "*) touch "${'${MOCK_DENY_IPV4_CREATED}'}" ;;
  *" compute instances create "*) touch "${'${MOCK_VM_CREATED}'}" ;;
  *" firewall-rules "*) printf 'unexpected firewall access: %s\\n' "$*" >&2; exit 9 ;;
  *) : ;;
esac
`);
  fs.chmodSync(mockGcloudPath, 0o755);

  const logPath = path.join(tempRoot, 'gcloud.log');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    MOCK_LOG: logPath,
    MOCK_VM_CREATED: path.join(tempRoot, 'vm-created'),
    MOCK_ALLOW_CREATED: path.join(tempRoot, 'allow-created'),
    MOCK_DENY_IPV4_CREATED: path.join(tempRoot, 'deny-ipv4-created'),
    MOCK_DENY_IPV6_CREATED: path.join(tempRoot, 'deny-ipv6-created'),
    GCP_PROJECT: 'wraps-hack',
    WG_ENABLED: 'true',
    WG_ENDPOINT: '203.0.113.10',
    WG_INTERFACE_ADDRESS: '10.77.0.1/24',
    WG_CANARY_SOURCE_RANGES: '198.51.100.24/32',
    ATTESTATION_AUDIENCE: 'https://wraps.invalid/issuer',
    ISSUER_URL: 'https://203.0.113.20',
    RELAY_HOSTNAME: 'relay-canary.example',
  };
  const run = (args, overrides = {}) => {
    fs.writeFileSync(logPath, '');
    const result = spawnSync('bash', [path.join(gcpDir, 'deploy.sh'), 'relay', ...args], {
      cwd: tempRoot,
      env: { ...env, ...overrides },
      encoding: 'utf8',
    });
    return { ...result, log: fs.readFileSync(logPath, 'utf8') };
  };

  const missingRanges = run(['--canary', '--dry-run'], { WG_CANARY_SOURCE_RANGES: '' });
  assert.notEqual(missingRanges.status, 0, 'canary must require a source CIDR');
  assert.match(missingRanges.stderr, /WG_CANARY_SOURCE_RANGES is required/);
  assert.equal(missingRanges.log, '', 'missing source ranges must fail before any gcloud call');

  const publicRange = run(['--canary', '--dry-run'], { WG_CANARY_SOURCE_RANGES: '0.0.0.0/0' });
  assert.notEqual(publicRange.status, 0, 'canary must reject a public /0 range');
  assert.equal(publicRange.log, '', 'invalid CIDRs must fail before any gcloud call');

  const mixedRanges = run(['--canary', '--dry-run'], {
    WG_CANARY_SOURCE_RANGES: '198.51.100.24/32,2001:db8::24/128',
  });
  assert.notEqual(mixedRanges.status, 0, 'canary must reject mixed IP families in one allow rule');
  assert.match(mixedRanges.stderr, /one IP family/);
  assert.equal(mixedRanges.log, '', 'mixed families must fail before any gcloud call');

  const implicitCanary = run(['--instance-name=wraps-relay-canary']);
  assert.notEqual(implicitCanary.status, 0, 'custom WireGuard relay names must require --canary');
  assert.match(implicitCanary.stderr, /require --canary/);
  assert.equal(implicitCanary.log, '', 'custom name guard must fail before any gcloud call');

  const dryRun = run(['--canary', '--dry-run']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /wraps-allow-wireguard-canary/);
  assert.match(dryRun.stdout, /wraps-relay-canary-deny[^\n]*--source-ranges=0\.0\.0\.0\/0/);
  assert.match(dryRun.stdout, /wraps-relay-canary-deny-ipv6[^\n]*--source-ranges=::\/0/);
  assert.match(dryRun.stdout, /--source-ranges=198\.51\.100\.24\/32/);
  assert.match(dryRun.stdout, /--target-tags=relay-canary/);
  assert.doesNotMatch(dryRun.stdout, /wraps-allow-wireguard(?:\s|$)/);
  assert.doesNotMatch(dryRun.log, /firewall-rules|compute instances create/);

  const ipv6DryRun = run(['--canary', '--dry-run'], {
    WG_CANARY_SOURCE_RANGES: '2001:db8::24/128,2001:db8::25/128',
  });
  assert.equal(ipv6DryRun.status, 0, ipv6DryRun.stderr);
  assert.match(ipv6DryRun.stdout, /--source-ranges=2001:db8::24\/128\\,2001:db8::25\/128/);
  assert.doesNotMatch(ipv6DryRun.log, /firewall-rules|compute instances create/);

  const fakeRun = run(['--canary']);
  assert.equal(fakeRun.status, 0, fakeRun.stderr);
  assert.match(fakeRun.log, /firewall-rules create wraps-allow-wireguard-canary/);
  assert.match(fakeRun.log, /firewall-rules create wraps-relay-canary-deny/);
  assert.match(fakeRun.log, /firewall-rules create wraps-relay-canary-deny-ipv6/);
  assert.match(fakeRun.log, /--source-ranges=0\.0\.0\.0\/0/);
  assert.match(fakeRun.log, /--source-ranges=::\/0/);
  assert.match(fakeRun.log, /--source-ranges=198\.51\.100\.24\/32/);
  assert.match(fakeRun.log, /--target-tags=relay-canary/);
  assert.match(fakeRun.log, /compute instances create wraps-relay-canary/);
  assert.doesNotMatch(fakeRun.log, /wraps-allow-wireguard(?:\s|$)/);
  assert.doesNotMatch(fakeRun.log, /firewall-rules update/);

  process.stdout.write('Canary firewall checks passed: single-family source validation, separate IPv4/IPv6 denies, dry-run isolation, and no production-rule access.\n');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
