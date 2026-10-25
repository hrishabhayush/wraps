// Who may call the demo's control endpoints (/api/start, /api/stop).
//
// Loopback host (the default): only loopback clients, and the Host header must name a loopback
// address, so a DNS-rebinding page cannot reach the endpoints through the browser.
// Any other host: every control call needs the random token made at start-up.
// In both modes a cross-origin browser request is refused.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export const TOKEN_HEADER = 'x-demo-token';

export interface ControlPolicy {
  host: string;
  loopbackOnly: boolean;
  /** Set when the host is not loopback. Clients send it in the x-demo-token header. */
  token?: string;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h;
  return isIP(v4) === 4 && v4.startsWith('127.');
}

export function controlPolicy(host: string, makeToken = () => randomBytes(24).toString('base64url')): ControlPolicy {
  return isLoopbackHost(host) ? { host, loopbackOnly: true } : { host, loopbackOnly: false, token: makeToken() };
}

function hostName(hostHeader: string): string {
  // "[::1]:4174" → "::1", "127.0.0.1:4174" → "127.0.0.1", "localhost" → "localhost"
  if (hostHeader.startsWith('[')) return hostHeader.slice(1, hostHeader.indexOf(']'));
  const colon = hostHeader.lastIndexOf(':');
  return colon > -1 && hostHeader.indexOf(':') === colon ? hostHeader.slice(0, colon) : hostHeader;
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ControlDecision = { ok: true } | { ok: false; status: 403; error: string };

export function checkControl(req: IncomingMessage, policy: ControlPolicy): ControlDecision {
  const hostHeader = req.headers.host ?? '';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (!originHost || originHost !== hostHeader) return { ok: false, status: 403, error: 'cross-origin control request refused' };
  }
  if (policy.loopbackOnly) {
    if (!isLoopbackHost(req.socket.remoteAddress ?? '')) return { ok: false, status: 403, error: 'control endpoints accept loopback clients only' };
    if (!isLoopbackHost(hostName(hostHeader))) return { ok: false, status: 403, error: 'control endpoints need a loopback Host header' };
    return { ok: true };
  }
  const given = req.headers[TOKEN_HEADER];
  if (typeof given !== 'string' || !policy.token || !sameToken(given, policy.token)) {
    return { ok: false, status: 403, error: 'missing or wrong demo control token' };
  }
  return { ok: true };
}
