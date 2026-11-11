export function abortError(): Error { return new Error('Operation cancelled or aborted'); }

export async function raceSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    // The operation may have rejected synchronously before cancellation was observed.
    void work.catch(() => {});
    throw signal.reason instanceof Error ? signal.reason : abortError();
  }
  let stop: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', stop); }
}

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await raceSignal(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}
