// The invocation itself is wrong: a missing argument or flag, an unknown
// command or action, flags that contradict each other. A class rather than a
// phrase, so the entry point tells it from a failure of a well-formed command
// without reading the message: a usage error exits 2, every other failure 1.
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The exit status for a failure the CLI caught. */
export function exitStatusFor(error: unknown): number {
  return error instanceof UsageError ? 2 : 1;
}
