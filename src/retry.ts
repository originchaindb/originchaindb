/** Retry policy shared with the Python and Go conformance fixtures. */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function retryEligible(method: string, retrySafe?: boolean): boolean {
  if (retrySafe !== undefined && typeof retrySafe !== "boolean") {
    throw new TypeError("retrySafe must be a boolean");
  }
  return retrySafe ?? ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function retryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null) return undefined;
  value = value.trim();
  if (/^[0-9]+$/.test(value)) return Math.min(1e12, Number(value)) * 1000;
  // Date.parse accepts non-HTTP strings such as "1.5"; reject those first.
  if (!/^(?:[A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9:]{8} GMT|[A-Za-z]+, [0-9]{2}-[A-Za-z]{3}-[0-9]{2} [0-9:]{8} GMT|[A-Za-z]{3} [A-Za-z]{3} [ 0-9][0-9] [0-9:]{8} [0-9]{4})$/.test(value)) return undefined;
  // asctime has no timezone; HTTP defines it as GMT, not the local zone.
  const date = Date.parse(value.endsWith("GMT") ? value : `${value} GMT`);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
}

export function backoff(attempt: number): number {
  return Math.random() * Math.min(4000, 250 * 2 ** Math.min(attempt, 4));
}

export function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
