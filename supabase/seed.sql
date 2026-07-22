-- Personalizer — seed data
-- Spec: docs/DB.md §10.
--
-- Picked up automatically by `supabase db reset` against a local stack. The
-- seed itself lives in public.seed_demo_data(), defined by migration
-- 20260720120900_seed_function.sql — see that file for why. `npm run seed`
-- calls the same function over RPC, so both routes produce exactly the same
-- database and neither can drift from the other.
--
-- Idempotent and safe to re-run.

SELECT public.seed_demo_data();
