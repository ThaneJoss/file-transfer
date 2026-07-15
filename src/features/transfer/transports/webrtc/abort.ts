export function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("操作已取消。", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortReason(signal);
}

export function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const done = (result: { ok: true; value: T } | { ok: false; error: unknown }) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };
    const onAbort = () => done({ ok: false, error: abortReason(signal) });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => done({ ok: true, value }),
      (error: unknown) => done({ ok: false, error }),
    );
  });
}
