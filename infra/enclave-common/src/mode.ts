// Where the app runs. The image sets ENCLAVE_MODE=nitro. The fallback script
// (infra/scripts/fallback-docker.sh) overrides it with ENCLAVE_MODE=docker.
import { existsSync } from 'node:fs';

export type EnclaveMode = 'nitro' | 'docker';

export function enclaveMode(): EnclaveMode {
  const raw = process.env.ENCLAVE_MODE ?? 'nitro';
  if (raw === 'nitro' || raw === 'docker') return raw;
  throw new Error(`ENCLAVE_MODE must be "nitro" or "docker", got "${raw}"`);
}

/** True when the Nitro Security Module device is present. */
export function hasNsmDevice(): boolean {
  return existsSync('/dev/nsm');
}

/** Port the app listens on inside the enclave. enclave-init forwards vsock to it. */
export function appPort(): number {
  return Number(process.env.APP_PORT ?? 8443);
}

/** 127.0.0.1 inside the enclave (vsock forwarder in front), 0.0.0.0 in the Docker fallback. */
export function listenHost(): string {
  return process.env.ENCLAVE_LISTEN_HOST ?? (enclaveMode() === 'nitro' ? '127.0.0.1' : '0.0.0.0');
}
