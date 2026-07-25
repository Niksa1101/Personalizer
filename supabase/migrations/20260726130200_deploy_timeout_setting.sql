-- Phase 11 · deploy.timeout_ms setting seed (D15, Phase 9 finding-6 pairing)

INSERT INTO public.settings (key, value, description) VALUES
  (
    'deploy.timeout_ms',
    '300000',
    'Give up on a Netlify digest deploy after this long'
  )
ON CONFLICT (key) DO NOTHING;
