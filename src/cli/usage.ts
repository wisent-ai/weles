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

/**
 * One answer as `--json` prints it, or as lines a person reads: an object
 * prints `key: value` per field (a string as itself, null as `-`, anything
 * nested as compact JSON), a list prints one compact item per line.
 */
export function printAnswer(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const line = (item: unknown): string => {
    if (item === null || item === undefined) return '-';
    return typeof item === 'string' ? item : JSON.stringify(item);
  };
  if (Array.isArray(value)) {
    process.stdout.write(value.map((item) => `${line(item)}\n`).join(''));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>);
    process.stdout.write(fields.map(([key, field]) => `${key}: ${line(field)}\n`).join(''));
    return;
  }
  process.stdout.write(`${line(value)}\n`);
}
