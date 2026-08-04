export interface WelesDatabaseCredentials {
  readonly url: string;
  readonly token: string;
}

let cached: WelesDatabaseCredentials | null | undefined;

function parseDatabaseOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('WELES_DATABASE_URL must be a valid URL');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('WELES_DATABASE_URL must use HTTPS, except for loopback HTTP');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('WELES_DATABASE_URL must be an origin without credentials, path, query, or fragment');
  }
  return parsed.origin;
}

/** Credentials resolved by the launcher from the exact weles-database Skarbiec item. */
export function optionalWelesDatabase(): WelesDatabaseCredentials | null {
  if (cached !== undefined) return cached;
  const rawUrl = process.env.WELES_DATABASE_URL?.trim() ?? '';
  const token = process.env.WELES_DATABASE_TOKEN?.trim() ?? '';
  if (!rawUrl && !token) {
    cached = null;
    return cached;
  }
  if (!rawUrl || !token) {
    throw new Error('incomplete weles-database launcher configuration');
  }
  cached = { url: parseDatabaseOrigin(rawUrl), token };
  return cached;
}

export function requireWelesDatabase(): WelesDatabaseCredentials {
  const credentials = optionalWelesDatabase();
  if (!credentials) throw new Error('missing weles-database launcher configuration');
  return credentials;
}

export function welesDatabaseHeaders(
  credentials: WelesDatabaseCredentials,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    apikey: credentials.token,
    Authorization: `Bearer ${credentials.token}`,
    ...extra,
  };
}
