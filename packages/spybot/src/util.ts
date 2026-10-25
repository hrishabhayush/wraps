/** Seconds between the Unix epoch and the Ripple epoch (2000-01-01). */
export const RIPPLE_EPOCH_OFFSET = 946684800;

/** Shorten an XRPL address for display: `rJmsb9…` or `rJmsb9…gVz`. */
export function shortAddr(addr: string, head = 6, tail = 0): string {
  if (addr.length <= head + tail + 1) return addr;
  return addr.slice(0, head) + "…" + (tail > 0 ? addr.slice(-tail) : "");
}

export function rippleTimeToDate(rippleSeconds: number): Date {
  return new Date((rippleSeconds + RIPPLE_EPOCH_OFFSET) * 1000);
}

export function hexToUtf8(hex: string | undefined): string {
  if (!hex) return "";
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Decode an XRPL currency code. Three-letter codes pass through.
 * 40-char hex codes decode to ASCII with trailing zero bytes removed.
 */
export function decodeCurrency(code: string): string {
  if (code.length !== 40) return code;
  const bytes = Buffer.from(code, "hex");
  if (bytes[0] === 0) return code; // not an ASCII-style code
  return bytes.toString("latin1").replace(/\0+$/, "");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Format a Date as local `HH:MM:SS`. */
export function hms(d: Date): string {
  return d.toTimeString().slice(0, 8);
}
