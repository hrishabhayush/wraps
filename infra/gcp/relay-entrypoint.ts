import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { AttestationProvider, AttestationVerifier } from '@wraps/attestation';
import { createRelayTlsIdentity, startConfidentialRelay, startConfidentialWireGuardRelay } from '@wraps/relay';

type AttestationRuntime = {
  ConfidentialSpaceProvider: new (options: { audience: string }) => AttestationProvider;
  verifierFromEnv: (role: 'issuer') => AttestationVerifier;
};

type IssuerRuntime = {
  fetchAttestedIssuer: (issuerUrl: string, verifier: AttestationVerifier) => Promise<unknown>;
  issuerTransport: (attestedIssuer: unknown) => unknown;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positivePort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port`);
  }
  return port;
}

function validateRelayHost(value: string): string {
  if (isIP(value)) return value;
  if (value.length > 253 || value.endsWith('.')) throw new Error('RELAY_HOSTNAME must be a DNS name or IP matching the SDK proxy URL');
  const labels = value.split('.');
  if (labels.length < 2 || labels.some((label) =>
    label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  )) {
    throw new Error('RELAY_HOSTNAME must be a DNS name or IP matching the SDK proxy URL');
  }
  return value.toLowerCase();
}

function waitForListening(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function close(server: HttpServer | HttpsServer): Promise<void> {
  server.closeAllConnections?.();
  // A listener can still be binding when its sibling fails. Wait for bind
  // completion, then close it; skipping it while `listening` is false leaks it.
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      const onListening = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); resolve(); };
      const cleanup = () => {
        server.off('listening', onListening);
        server.off('error', onError);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      if (server.listening) onListening();
    });
  }
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const audience = required('ATTESTATION_AUDIENCE');
  const issuerUrl = new URL(required('ISSUER_URL'));
  if (issuerUrl.protocol !== 'https:') throw new Error('ISSUER_URL must use HTTPS');
  const hostname = validateRelayHost(required('RELAY_HOSTNAME'));

  // These APIs are supplied by the GCP attestation and issuer runtime branches.
  // Keep the structural boundary local so this infra entrypoint can be integrated
  // while those dependency branches remain stacked separately.
  const attestationRuntime = await import('@wraps/attestation') as unknown as AttestationRuntime;
  const issuerRuntime = await import('@wraps/issuer') as unknown as IssuerRuntime;
  const issuerVerifier = attestationRuntime.verifierFromEnv('issuer');
  const attestedIssuer = await issuerRuntime.fetchAttestedIssuer(
    issuerUrl.toString().replace(/\/$/, ''),
    issuerVerifier,
  );
  const issuerFetch = issuerRuntime.issuerTransport(attestedIssuer) as typeof fetch;

  // Both the TLS identity and its private key are created in the workload's
  // process memory. The relay attestation endpoint binds this cert's SPKI.
  const identity = await createRelayTlsIdentity(hostname);
  const provider = new attestationRuntime.ConfidentialSpaceProvider({ audience });
  const relayOptions = {
    issuerUrl: issuerUrl.toString(),
    issuerFetch,
    tlsCertificate: identity.certPem,
    tlsPrivateKey: identity.keyPem,
    attestationProvider: provider,
    proxyHost: process.env.RELAY_PROXY_HOST ?? '0.0.0.0',
    proxyPort: positivePort('RELAY_PROXY_PORT', 443),
    attestationHost: process.env.RELAY_ATTESTATION_HOST ?? '0.0.0.0',
    attestationPort: positivePort('RELAY_ATTESTATION_PORT', 8080),
  };
  const wireGuardEnabled = process.env.WG_ENABLED === 'true';
  if (wireGuardEnabled) await runCommand('sysctl', ['-w', 'net.ipv4.ip_forward=1']);
  const servers = wireGuardEnabled
    ? await startConfidentialWireGuardRelay({
      ...relayOptions,
      wireGuardGateway: {
        endpoint: required('WG_ENDPOINT'),
        listenPort: 51820,
        interfaceAddress: required('WG_INTERFACE_ADDRESS'),
        egressInterface: process.env.WG_EGRESS_INTERFACE ?? 'ens4',
        peers: JSON.parse(required('WG_PEERS_JSON')) as Array<{ publicKey: string; allowedAddress: string }>,
      },
    })
    : startConfidentialRelay(relayOptions);

  const { proxyServer, attestationServer } = servers;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = 'close' in servers
      ? servers.close()
      : Promise.all([close(proxyServer), close(attestationServer)]).then(() => undefined);
    return shutdownPromise;
  };
  const stop = () => {
    void shutdown().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const listeners = [proxyServer, attestationServer];
  const ready = Promise.all(listeners.map(waitForListening));
  for (const server of listeners) {
    server.on('error', () => {
      console.error('[relay] listener failed');
      process.exitCode = 1;
      stop();
    });
  }
  try {
    await ready;
  } catch (error) {
    await shutdown().catch(() => { process.exitCode = 1; });
    throw error;
  }

  console.info(`[relay] ready; proxy :${positivePort('RELAY_PROXY_PORT', 443)}, attestation :${positivePort('RELAY_ATTESTATION_PORT', 8080)}`);

}

main().catch(() => {
  // Never log URLs, keys, nonces, credentials, or attestation token contents.
  console.error('[relay] startup failed');
  process.exitCode = 1;
});
