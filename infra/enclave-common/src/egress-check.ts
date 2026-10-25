// INF-11 "done when": from inside the enclave, an allowlisted host answers
// and a host not on the list fails. Call once at boot; read the result in
// `journalctl -u ifi-logs`.
import { log } from './log';

export interface EgressCheckResult {
  allowedOk: boolean;
  blockedOk: boolean;
}

export async function checkEgress(
  allowedUrl = 'https://hackathon.ap4m.build/health',
  blockedUrl = 'https://example.com/',
): Promise<EgressCheckResult> {
  const probe = async (url: string) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      return { reached: true, status: res.status };
    } catch (err) {
      return { reached: false, error: (err as Error).cause ? String((err as Error).cause) : (err as Error).message };
    }
  };
  const allowed = await probe(allowedUrl);
  const blocked = await probe(blockedUrl);
  const result = { allowedOk: allowed.reached, blockedOk: !blocked.reached };
  log(result.allowedOk && result.blockedOk ? 'info' : 'warn', 'egress self-test', {
    allowedUrl,
    allowed,
    blockedUrl,
    blocked,
    ...result,
  });
  return result;
}
