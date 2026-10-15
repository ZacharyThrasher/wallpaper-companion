import { WorkshopError } from './types.js';

export interface WorkshopClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkshopError('cancelled');
}
export function interruptible<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new WorkshopError('cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(new WorkshopError('network')); });
    if (signal.aborted) abort();
  });
}
export const systemClock: WorkshopClock = {
  now: Date.now,
  sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { clearTimeout(timer); cleanup(); reject(new WorkshopError('cancelled')); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  },
};
const endpoints = {
  search: 'https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/',
  details: 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
} as const;

/** One serial queue per provider. Each HTTP attempt starts at least one second apart. */
export class SteamTransport {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #nextStart = 0;
  #fetch: typeof fetch;
  #clock: WorkshopClock;
  #timeoutMs: number;
  constructor(fetcher: typeof fetch, clock: WorkshopClock, timeoutMs: number) {
    this.#fetch = fetcher; this.#clock = clock; this.#timeoutMs = timeoutMs;
  }
  async request(endpoint: keyof typeof endpoints, params: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
    cancelled(signal);
    if (this.#pending >= 100) throw new WorkshopError('busy');
    this.#pending++;
    const previous = this.#tail;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // A cancelled waiter must not let its successors overtake an active request.
    this.#tail = previous.then(() => gate);
    try {
      await interruptible(previous, signal);
      for (let attempt = 0; attempt < 3; attempt++) {
        cancelled(signal);
        const wait = Math.max(0, this.#nextStart - this.#clock.now());
        if (wait > 30_000) throw new WorkshopError('rate_limited');
        if (wait) await this.#clock.sleep(wait, signal);
        cancelled(signal);
        this.#nextStart = this.#clock.now() + 1000;
        const result = await this.#attempt(endpoint, params, signal);
        if (result.status === 429 || result.status === 503) {
          const error = new WorkshopError(result.status === 429 ? 'rate_limited' : 'service_unavailable');
          const delay = this.#retryAfter(result.retryAfter) ?? 1000 * (2 ** attempt);
          this.#nextStart = Math.max(this.#nextStart, this.#clock.now() + delay);
          if (attempt === 2 || delay > 30_000) throw error;
          continue;
        }
        if (result.status === 401 || result.status === 403) throw new WorkshopError('credentials_rejected');
        if (result.status < 200 || result.status >= 300) throw new WorkshopError('http_error');
        return result.body;
      }
      throw new WorkshopError('service_unavailable');
    } finally { release(); this.#pending--; }
  }
  #retryAfter(header: string | null): number | undefined {
    if (!header) return;
    const seconds = /^\d+(\.\d+)?$/.test(header.trim()) ? Number(header) : undefined;
    const delay = seconds === undefined ? Date.parse(header) - this.#clock.now() : seconds * 1000;
    return Number.isFinite(delay) ? Math.max(0, Math.min(delay, Number.MAX_SAFE_INTEGER - this.#clock.now())) : undefined;
  }
  async #attempt(endpoint: keyof typeof endpoints, params: URLSearchParams, signal?: AbortSignal): Promise<{
    status: number; retryAfter: string | null; body?: unknown;
  }> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const url = endpoint === 'search' ? `${endpoints.search}?${params}` : endpoints.details;
      const init: RequestInit = { method: endpoint === 'search' ? 'GET' : 'POST', redirect: 'error',
        signal: controller.signal, headers: { Accept: 'application/json' } };
      if (endpoint === 'details') {
        init.headers = { ...init.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
        init.body = params.toString();
      }
      const response = await interruptible(this.#fetch(url, init), controller.signal);
      if (!response.ok) {
        // Never consume/log an error body, which may echo credentials or arbitrary text.
        if (response.body) await interruptible(response.body.cancel(), controller.signal);
        return { status: response.status, retryAfter: response.headers.get('retry-after') };
      }
      const reader = response.body?.getReader();
      if (!reader) throw new WorkshopError('invalid_response');
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await interruptible(reader.read(), controller.signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) throw new WorkshopError('invalid_response');
          chunks.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      try {
        return { status: response.status, retryAfter: null, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
      } catch { throw new WorkshopError('invalid_response'); }
    } catch (error) {
      if (signal?.aborted) throw new WorkshopError('cancelled');
      if (timedOut) throw new WorkshopError('timeout');
      if (error instanceof WorkshopError && error.code === 'invalid_response') throw error;
      throw new WorkshopError('network');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
}
