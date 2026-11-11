import type { Config } from './config.js';
import { delay, raceSignal } from './control.js';

export class ApiError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}
export type RequestScope = { signal?: AbortSignal | undefined; beforeRequest?: (() => void) | undefined };
type Dependencies = {
  fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; random?: () => number;
  scope?: RequestScope; scheduler?: RequestScheduler;
};
export type ResponseRecord = { timestamp: string; label: string; attempt: number; httpStatus?: number;
  rawResponse?: unknown; rawBody?: string; failure?: string };

export class RequestScheduler {
  private states = new Map<string, { tail: Promise<void>; last: number }>();
  async run<T>(provider: string, interval: number, signal: AbortSignal | undefined, sleep: (ms: number) => Promise<void>, work: () => Promise<T>): Promise<T> {
    let state = this.states.get(provider);
    if (!state) { state = { tail: Promise.resolve(), last: -Infinity }; this.states.set(provider, state); }
    const previous = state.tail;
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    state.tail = previous.then(() => gate);
    try {
      await raceSignal(previous, signal); signal?.throwIfAborted();
      const spacing = interval - (performance.now() - state.last);
      if (spacing > 0) await raceSignal(sleep(spacing), signal);
      signal?.throwIfAborted(); state.last = performance.now();
      return await work();
    } finally { release(); }
  }
}

export class Transport {
  private fetcher: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;
  private scheduler: RequestScheduler;
  private scope: RequestScope;
  constructor(private cfg: Config, private record: (data: ResponseRecord) => Promise<void>, deps: Dependencies = {}) {
    this.fetcher = deps.fetch ?? fetch;
    this.scope = deps.scope ?? {};
    this.sleep = deps.sleep ?? (ms => delay(ms, this.scope.signal));
    this.random = deps.random ?? Math.random;
    this.scheduler = deps.scheduler ?? new RequestScheduler();
  }
  async request<T>(label: string, url: URL, init: RequestInit, decode: (body: unknown) => T): Promise<T> {
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      this.scope.signal?.throwIfAborted();
      let retryAfter = 0;
      const outcome = await this.scheduler.run(url.hostname, this.cfg.intervalMs, this.scope.signal, this.sleep, async () => {
        this.scope.signal?.throwIfAborted(); this.scope.beforeRequest?.();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), this.cfg.timeoutMs);
        const signal = this.scope.signal ? AbortSignal.any([this.scope.signal, controller.signal]) : controller.signal;
        const record: ResponseRecord = { timestamp: new Date().toISOString(), label, attempt: attempt + 1 };
        let value: T | undefined; let failure: ApiError | undefined;
        try {
          const response = await raceSignal(this.fetcher(url, { ...init, signal, redirect: 'error' }), signal);
          record.httpStatus = response.status;
          const header = response.headers.get('retry-after');
          if (header) retryAfter = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
          const text = await raceSignal(response.text(), signal); record.rawBody = text;
          let body: unknown; let json = true;
          try { body = JSON.parse(text); } catch { body = text; json = false; }
          record.rawResponse = body;
          if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status === 429 || response.status >= 500);
          if (!json) throw new ApiError('Invalid JSON response');
          value = decode(body);
        } catch (error) {
          failure = error instanceof ApiError ? error : new ApiError(this.scope.signal?.aborted ? 'Operation cancelled' :
            controller.signal.aborted ? 'Request timeout' : 'Network or response read failure (check DNS, TLS and network access)', !this.scope.signal?.aborted);
          record.failure = failure.message;
        } finally { clearTimeout(timeout); }
        // Already received evidence is persisted even if the parent is now cancelled.
        await this.record(record);
        this.scope.signal?.throwIfAborted();
        return { value, failure };
      });
      if (!outcome.failure) return outcome.value as T;
      if (!outcome.failure.retryable || attempt === this.cfg.maxRetries) throw outcome.failure;
      const exponential = this.cfg.retryBaseMs * 2 ** attempt + Math.floor(this.random() * this.cfg.retryBaseMs);
      const wait = Math.min(this.cfg.retryMaxMs, Math.max(exponential, Number.isFinite(retryAfter) ? retryAfter : 0));
      await raceSignal(this.sleep(wait), this.scope.signal);
    }
    throw new ApiError('Retry budget exhausted');
  }
}
