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
