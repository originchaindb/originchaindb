import type { RequestOptions } from "./types.js";

/** Normalize all Fetch header forms before applying case-insensitive defaults. */
export function requestHeaders(defaults: Record<string, string>, supplied?: HeadersInit): Record<string, string> {
  const result = { ...defaults };
  new Headers(supplied).forEach((value, name) => { result[name] = value; });
  return result;
}

/** Apply public per-call controls without changing the endpoint's payload. */
export function requestOptions(
  options: RequestOptions,
  init: RequestInit & { rawBody?: boolean; retrySafe?: boolean } = {},
): RequestInit & { rawBody?: boolean; retrySafe?: boolean } {
  const headers = requestHeaders({}, init.headers);
  if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
  return { ...init, headers, signal: options.signal ?? init.signal,
    retrySafe: options.retrySafe ?? init.retrySafe };
}

/** Compose caller cancellation with our timeout without requiring AbortSignal.any. */
export function requestSignal(timeoutMs: number, caller?: AbortSignal | null) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(caller?.reason);
  if (caller?.aborted) cancel();
  else caller?.addEventListener("abort", cancel, { once: true });
  const timer = controller.signal.aborted ? undefined : setTimeout(() => {
    if (!controller.signal.aborted) {
      timedOut = true;
      controller.abort();
    }
  }, timeoutMs);
  return {
    signal: controller.signal,
    failure: (): "timeout" | "cancelled" | "network" =>
      timedOut ? "timeout" : controller.signal.aborted ? "cancelled" : "network",
    cleanup() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", cancel);
    },
  };
}
