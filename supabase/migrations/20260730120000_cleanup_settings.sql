-- Phase 16 cleanup settings. Insert-only rather than re-emitting the 252-line
-- seed_demo_data() (20260720120900_seed_function.sql); see DB.md §5.12.
INSERT INTO public.settings (key, value, description) VALUES
  ('cleanup.enabled',                   'true',  'Run the daily retention sweep'),
  ('cleanup.dry_run',                   'false', 'Report what the sweep would delete without deleting'),
  ('cleanup.screenshot_retention_days', '30',    'Days to keep debug screenshots for leads not in failed')
ON CONFLICT (key) DO NOTHING;
