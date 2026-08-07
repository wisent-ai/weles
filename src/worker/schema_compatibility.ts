type EnvLike = Record<string, string | undefined>;

type FetchLike = typeof fetch;

export type DatabaseCompatibility = {
  schemaVersion: number;
  minimum: number;
  maximum: number;
};

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export async function assertDatabaseCompatibility(options: {
  env?: EnvLike;
  fetchImpl?: FetchLike;
} = {}): Promise<DatabaseCompatibility> {
  const env = options.env ?? process.env;
  const baseUrl = (env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!baseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const minimum = positiveInteger(env.WELES_DATABASE_SCHEMA_MINIMUM ?? '4', 'WELES_DATABASE_SCHEMA_MINIMUM');
  const maximum = positiveInteger(env.WELES_DATABASE_SCHEMA_MAXIMUM ?? '5', 'WELES_DATABASE_SCHEMA_MAXIMUM');
  if (minimum > maximum) throw new Error('database schema minimum exceeds maximum');

  const response = await (options.fetchImpl ?? fetch)(
    `${baseUrl}/rest/v1/weles_schema_migrations?select=version&order=version.desc&limit=1`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
      },
    },
  );
  if (!response.ok) {
    throw new Error(`cannot read weles_schema_migrations (${response.status}); apply the release-contract migration first`);
  }
  const rows = await response.json() as Array<{ version?: unknown }>;
  const schemaVersion = Number(rows[0]?.version);
  if (!Number.isInteger(schemaVersion)) throw new Error('database schema ledger is empty');
  if (schemaVersion < minimum || schemaVersion > maximum) {
    throw new Error(`database schema ${schemaVersion} is outside worker range ${minimum}..${maximum}`);
  }
  return { schemaVersion, minimum, maximum };
}
