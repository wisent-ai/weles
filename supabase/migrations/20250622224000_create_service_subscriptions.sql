-- Central registry of paid SaaS subscriptions used by Weles automations.
-- This closes the gap where service_credentials only stores login secrets
-- but does not track whether the account actually has an active subscription.
CREATE TABLE IF NOT EXISTS public.service_subscriptions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    service_credential_id  text REFERENCES public.service_credentials(id) ON DELETE SET NULL,
    service_name           text NOT NULL,   -- e.g. 'Codex', 'ChatGPT', 'Claude Code'
    provider               text NOT NULL,   -- e.g. 'openai', 'anthropic'
    account_identifier     text NOT NULL,   -- email, username or account id
    status                 text NOT NULL DEFAULT 'unknown'
                           CHECK (status IN ('active','paused','expired','revoked','unknown')),
    plan                   text,            -- e.g. 'Plus', 'Pro', 'Team'
    monthly_cost_usd       numeric(10,2),
    expires_at             timestamptz,
    last_verified_at       timestamptz,
    metadata               jsonb NOT NULL DEFAULT '{}',
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.service_subscriptions IS
    'Canonical registry of paid SaaS subscriptions (Codex, ChatGPT, Claude, etc.)';

-- Keep updated_at current automatically.
CREATE OR REPLACE FUNCTION public.set_service_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS service_subscriptions_updated_at ON public.service_subscriptions;
CREATE TRIGGER service_subscriptions_updated_at
    BEFORE UPDATE ON public.service_subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.set_service_subscriptions_updated_at();

-- One row per service/account so upsert via REST merge-duplicates works.
ALTER TABLE public.service_subscriptions
  ADD CONSTRAINT service_subscriptions_unique_account
  UNIQUE (service_name, provider, account_identifier);

-- Useful lookups.
CREATE INDEX IF NOT EXISTS idx_service_subscriptions_service_status
    ON public.service_subscriptions(service_name, status);
CREATE INDEX IF NOT EXISTS idx_service_subscriptions_account
    ON public.service_subscriptions(provider, account_identifier);

-- Enable RLS; only service role can manage this table.
ALTER TABLE public.service_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role only" ON public.service_subscriptions;
CREATE POLICY "service role only"
    ON public.service_subscriptions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
