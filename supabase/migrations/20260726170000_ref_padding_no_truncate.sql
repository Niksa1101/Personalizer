-- Fix: ref generators truncated instead of widening past the pad width.
--
-- `lpad(text, n, '0')` does not only pad — it TRUNCATES (on the right) when the
-- input is already longer than n. So:
--
--   lpad('99',    2, '0') = '99'    -> CMP-99   (fine)
--   lpad('100',   2, '0') = '10'    -> CMP-10   (collides with campaign #10)
--   lpad('117',   2, '0') = '11'    -> CMP-11
--   lpad('118',   2, '0') = '11'    -> CMP-11   -> campaigns_ref_uk violation
--   lpad('10000', 4, '0') = '1000'  -> LD-1000  (collides with lead #1000)
--
-- Every value in a decade collapses to the same two characters, so once the
-- campaign sequence passes 99 exactly one INSERT per decade can succeed and
-- every other one fails with a duplicate key. `campaign_ref_seq` was already at
-- 117 when this was found, i.e. campaign creation was broken outright. The lead
-- generator has the identical defect at 10 000, which a large import would hit.
--
-- Widening the pad width would only move the cliff. `greatest(<width>, length)`
-- removes it: lpad still zero-pads short values to the historical width, and is
-- a no-op once the number outgrows it. Refs stay CMP-01 / LD-0001 shaped below
-- the boundary and simply get longer above it.
--
-- nextval() is evaluated once per call via the CTE — referencing it twice in the
-- expression would advance the sequence twice per ref.
--
-- No backfill: only refs generated at sequence values above the pad width could
-- be wrong, and no such row survives (campaigns hold CMP-01 and CMP-75, both
-- from below the boundary). Sequences are left where they are; the next campaign
-- ref becomes CMP-118, which collides with nothing.

CREATE OR REPLACE FUNCTION public.next_campaign_ref()
 RETURNS text
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  WITH n AS (SELECT nextval('public.campaign_ref_seq') AS v)
  SELECT 'CMP-' || lpad(n.v::text, greatest(2, length(n.v::text)), '0') FROM n
$function$;

CREATE OR REPLACE FUNCTION public.next_lead_ref()
 RETURNS text
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  WITH n AS (SELECT nextval('public.lead_ref_seq') AS v)
  SELECT 'LD-' || lpad(n.v::text, greatest(4, length(n.v::text)), '0') FROM n
$function$;
