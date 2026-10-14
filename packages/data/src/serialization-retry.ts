/**
 * Re-runs a whole SERIALIZABLE transaction when PostgreSQL aborts it because a
 * concurrent transaction conflicted (SQLSTATE 40001, or 40P01 for a deadlock).
 *
 * A newer user message is accepted while the older answer is still being
 * claimed, committed or settled (issue #319), so these conflicts are an
 * expected, benign race on the request path rather than a failure. Callers pass
 * an operation that opens and finishes its own transaction, so a retry always
 * starts from a clean state.
 */
export async function retryOnSerializationFailure<T>(
  operation: () => Promise<T>,
  options: Readonly<{ attempts?: number; sleep?: (ms: number) => Promise<void> }> = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isSerializationConflict(error)) {
        throw error;
      }
      await sleep(10 * 2 ** attempt + Math.floor(Math.random() * 10));
    }
  }
}

export function isSerializationConflict(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "40001" || code === "40P01";
}
