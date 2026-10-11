import {
  ProviderDispatchError,
  type ProviderDispatchErrorCategory,
} from "./conversation-model";

/**
 * The absolute end-to-end deadline of one chat request (issue #319, ADR-0151:
 * 30 seconds). It is frozen once at acceptance as a wall-clock instant and
 * every later step shares the remaining time; no step re-acquires a budget.
 *
 * `expired()` reads the injected clock so fake-clock tests and the durable
 * database fence agree, and also turns true once the real timer has fired so a
 * frozen controlled clock cannot keep a request alive.
 */
export type RequestDeadline = Readonly<{
  deadlineAt: Date;
  expired(): boolean;
  /** Aborts when the deadline is reached; pass it to cancellable work. */
  signal: AbortSignal;
  release(): void;
}>;

export function createRequestDeadline(input: {
  clock: () => Date;
  deadlineAt: Date;
  setTimer?: (callback: () => void, delayMs: number) => () => void;
}): RequestDeadline {
  const controller = new AbortController();
  const setTimer =
    input.setTimer ??
    ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return () => clearTimeout(handle);
    });
  let fired = false;
  const fire = () => {
    fired = true;
    controller.abort();
  };
  const remaining = input.deadlineAt.getTime() - input.clock().getTime();
  let cancel: () => void = () => undefined;
  if (remaining <= 0) {
    fire();
  } else {
    cancel = setTimer(fire, remaining);
  }
  return {
    deadlineAt: input.deadlineAt,
    expired: () => fired || input.clock().getTime() >= input.deadlineAt.getTime(),
    release: () => cancel(),
    signal: controller.signal,
  };
}

const INTERRUPTED = Symbol("interrupted");

/**
 * Combines the consumer's cancellation and the request deadline (issue #319).
 * `race` lets the Harness stop waiting on a Provider call that ignores its
 * abort signal, so the deadline holds even when cancellation cannot be
 * delivered; `throwIfInterrupted` keeps new steps from starting afterwards.
 */
export function createRequestInterrupt(
  signal: AbortSignal | undefined,
  deadline: RequestDeadline | undefined,
) {
  const parts = [signal, deadline?.signal].filter(
    (part): part is AbortSignal => part !== undefined,
  );
  const combined = parts.length === 0 ? undefined : AbortSignal.any(parts);
  const reason = (): ProviderDispatchErrorCategory | null =>
    deadline?.expired()
      ? "timeout"
      : combined?.aborted
        ? "aborted"
        : null;
  const interrupted: Promise<typeof INTERRUPTED> =
    combined === undefined
      ? new Promise<never>(() => undefined)
      : new Promise((resolve) => {
          if (combined.aborted) resolve(INTERRUPTED);
          else
            combined.addEventListener("abort", () => resolve(INTERRUPTED), {
              once: true,
            });
        });
  function throwIfInterrupted(): void {
    const category = reason();
    if (category !== null) throw new ProviderDispatchError(category);
  }
  return {
    ended: () => reason() !== null,
    signal: combined,
    throwIfInterrupted,
    async sleep(
      delay: (ms: number) => Promise<void>,
      ms: number,
    ): Promise<void> {
      const waited = delay(ms);
      waited.catch(() => undefined);
      await Promise.race([waited, interrupted]);
      throwIfInterrupted();
    },
    /** Wait for one piece of work, but never past the end of the request. */
    async guard<T>(work: Promise<T>): Promise<T> {
      work.catch(() => undefined);
      const next = await Promise.race([work, interrupted]);
      if (next === INTERRUPTED) {
        throwIfInterrupted();
        throw new ProviderDispatchError("aborted");
      }
      return next;
    },
    async *race<T>(source: AsyncIterable<T>): AsyncIterable<T> {
      const iterator = source[Symbol.asyncIterator]();
      for (;;) {
        const pending = iterator.next();
        pending.catch(() => undefined);
        const next = await Promise.race([pending, interrupted]);
        if (next === INTERRUPTED) {
          // Never await this: a call that ignores cancellation never returns.
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
          throwIfInterrupted();
          throw new ProviderDispatchError("aborted");
        }
        if (next.done === true) return;
        yield next.value;
      }
    },
  };
}
