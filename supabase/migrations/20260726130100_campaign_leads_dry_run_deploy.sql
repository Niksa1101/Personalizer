-- Phase 11 · dry-run deploy marker + relaxed deployed URL check (D23, D60)

ALTER TABLE public.campaign_leads
  ADD COLUMN IF NOT EXISTS deployed_dry_run boolean NOT NULL DEFAULT false;

ALTER TABLE public.campaign_leads
  DROP CONSTRAINT IF EXISTS campaign_leads_deployed_url_ck;

ALTER TABLE public.campaign_leads
  ADD CONSTRAINT campaign_leads_deployed_url_ck CHECK (
    status <> 'deployed'
    OR netlify_url IS NOT NULL
    OR deployed_dry_run
  );
