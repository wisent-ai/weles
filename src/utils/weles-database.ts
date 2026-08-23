export interface WelesDatabaseCredentials {
  readonly url: string;
  readonly token: string;
}

/** Supabase is removed from Weles. Always returns null; callers must handle absence. */
export function optionalWelesDatabase(): WelesDatabaseCredentials | null {
  return null;
}

export function requireWelesDatabase(): WelesDatabaseCredentials {
  throw new Error('Supabase is removed from Weles');
}

export function welesDatabaseHeaders(_db: WelesDatabaseCredentials, extra?: Record<string, string>): Record<string, string> {
  return { ...extra };
}
