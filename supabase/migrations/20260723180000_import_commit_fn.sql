-- Personalizer — 13 · import_commit() — atomic CSV batch commit
-- Spec: docs/DB.md §5.2–5.3, §6.1; docs/Tech.md §5.3–5.4; Phase 6 plan Step 1.
--
-- One transaction per batch: insert import_batches, loop rows, dedupe against
-- live DB + intra-file keys, insert leads/campaign_leads/events, tally counts.
-- Dry-run mode computes the same outcomes without writing.

CREATE OR REPLACE FUNCTION public.import_commit(
  p_campaign_id uuid,
  p_batch       jsonb,
  p_rows        jsonb,
  p_dry_run     boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_batch_id            uuid;
  v_imported            integer := 0;
  v_linked              integer := 0;
  v_duplicate           integer := 0;
  v_skipped             integer := 0;
  v_exists_list         jsonb := '[]'::jsonb;
  v_created_ids         uuid[] := ARRAY[]::uuid[];
  v_per_row_outcomes    jsonb := '[]'::jsonb;
  v_row                 jsonb;
  v_website_url         text;
  v_email               text;
  v_domain              text;
  v_skip                text;
  v_existing_lead_id    uuid;
  v_in_campaign         boolean;
  v_new_lead_id         uuid;
  v_new_cl_id           uuid;
  v_cl_slug             text;
  v_cl_status           public.lead_status;
  v_outcome             text;
  v_seen_domains        text[] := ARRAY[]::text[];
  v_seen_emails         text[] := ARRAY[]::text[];
  v_other_campaigns     jsonb;
  v_exists_entry        jsonb;
  v_exists_company      text;
  v_exists_domain       text;
  v_exists_email        text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.campaigns WHERE id = p_campaign_id) THEN
    RAISE EXCEPTION 'campaign not found: %', p_campaign_id;
  END IF;

  IF NOT p_dry_run THEN
    INSERT INTO public.import_batches (
      campaign_id,
      filename,
      slug,
      row_count,
      imported_count,
      linked_count,
      duplicate_count,
      skipped_count,
      rejected_rows,
      delimiter,
      had_bom
    ) VALUES (
      p_campaign_id,
      p_batch->>'filename',
      p_batch->>'slug',
      COALESCE((p_batch->>'row_count')::integer, 0),
      0,
      0,
      0,
      0,
      COALESCE(p_batch->'rejected_rows', '[]'::jsonb),
      p_batch->>'delimiter',
      COALESCE((p_batch->>'had_bom')::boolean, false)
    )
    RETURNING id INTO v_batch_id;
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    v_website_url := nullif(btrim(v_row->>'website_url'), '');
    v_email := nullif(btrim(v_row->>'email'), '');
    v_skip := nullif(v_row->>'skip', '');
    v_outcome := NULL;
    v_existing_lead_id := NULL;

    IF v_skip = 'not_a_website' THEN
      v_domain := NULL;
    ELSIF v_website_url IS NOT NULL THEN
      v_domain := public.normalize_domain(v_website_url);
    ELSE
      v_domain := NULL;
    END IF;

    -- Intra-file dedupe: first row wins (D25).
    IF v_domain IS NOT NULL AND v_domain = ANY(v_seen_domains) THEN
      v_outcome := 'duplicate';
      v_duplicate := v_duplicate + 1;
      IF p_dry_run THEN
        v_per_row_outcomes := v_per_row_outcomes || jsonb_build_object('outcome', v_outcome);
      END IF;
      CONTINUE;
    END IF;

    IF v_email IS NOT NULL AND v_email = ANY(v_seen_emails) THEN
      v_outcome := 'duplicate';
      v_duplicate := v_duplicate + 1;
      IF p_dry_run THEN
        v_per_row_outcomes := v_per_row_outcomes || jsonb_build_object('outcome', v_outcome);
      END IF;
      CONTINUE;
    END IF;

    IF v_domain IS NOT NULL THEN
      v_seen_domains := array_append(v_seen_domains, v_domain);
    END IF;
    IF v_email IS NOT NULL THEN
      v_seen_emails := array_append(v_seen_emails, v_email);
    END IF;

    -- DB dedupe: domain first, then email (D26).
    IF v_domain IS NOT NULL THEN
      SELECT l.id INTO v_existing_lead_id
      FROM public.leads l
      WHERE l.domain = v_domain
      LIMIT 1;
    END IF;

    IF v_existing_lead_id IS NULL AND v_email IS NOT NULL THEN
      SELECT l.id INTO v_existing_lead_id
      FROM public.leads l
      WHERE l.email = v_email
      LIMIT 1;
    END IF;

    IF v_existing_lead_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.campaign_leads cl
        WHERE cl.campaign_id = p_campaign_id AND cl.lead_id = v_existing_lead_id
      ) INTO v_in_campaign;

      -- Other campaigns this lead belongs to (D35).
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)), '[]'::jsonb)
      INTO v_other_campaigns
      FROM public.campaign_leads cl
      JOIN public.campaigns c ON c.id = cl.campaign_id
      WHERE cl.lead_id = v_existing_lead_id
        AND cl.campaign_id <> p_campaign_id;

      IF jsonb_array_length(v_other_campaigns) > 0 THEN
        SELECT l.company, l.domain, l.email::text
        INTO v_exists_company, v_exists_domain, v_exists_email
        FROM public.leads l WHERE l.id = v_existing_lead_id;

        v_exists_entry := jsonb_build_object(
          'company', v_exists_company,
          'domain', v_exists_domain,
          'email', v_exists_email,
          'campaigns', v_other_campaigns
        );
        v_exists_list := v_exists_list || v_exists_entry;
      END IF;

      IF v_in_campaign THEN
        v_outcome := 'duplicate';
        v_duplicate := v_duplicate + 1;
      ELSE
        v_outcome := 'linked';
        v_linked := v_linked + 1;

        IF NOT p_dry_run THEN
          v_new_cl_id := gen_random_uuid();
          v_cl_slug := public.import_commit_lead_slug(
            v_row, v_new_cl_id, p_campaign_id, NULL
          );

          INSERT INTO public.campaign_leads (
            id, campaign_id, lead_id, batch_id, status, current_step, slug, queued_at
          ) VALUES (
            v_new_cl_id,
            p_campaign_id,
            v_existing_lead_id,
            v_batch_id,
            'queued',
            'recording',
            v_cl_slug,
            now()
          );

          INSERT INTO public.pipeline_events (campaign_lead_id, kind, message)
          VALUES
            (v_new_cl_id, 'imported', 'Linked from CSV import.'),
            (v_new_cl_id, 'queued',   'Queued for processing.');

          v_created_ids := array_append(v_created_ids, v_new_cl_id);
        END IF;
      END IF;
    ELSE
      -- No existing lead — new row (or skipped social).
      IF v_skip = 'not_a_website' THEN
        v_outcome := 'skipped';
        v_skipped := v_skipped + 1;
        v_cl_status := 'skipped';
      ELSE
        v_outcome := 'imported';
        v_imported := v_imported + 1;
        v_cl_status := 'queued';
      END IF;

      IF NOT p_dry_run THEN
        v_new_lead_id := gen_random_uuid();
        v_new_cl_id := gen_random_uuid();

        INSERT INTO public.leads (
          id,
          first_name,
          last_name,
          full_name,
          company,
          email,
          phone,
          website_url,
          domain,
          city,
          state,
          country,
          industry,
          source_batch_id,
          raw
        ) VALUES (
          v_new_lead_id,
          nullif(v_row->>'first_name', ''),
          nullif(v_row->>'last_name', ''),
          nullif(v_row->>'full_name', ''),
          nullif(v_row->>'company', ''),
          v_email,
          nullif(v_row->>'phone', ''),
          v_website_url,
          v_domain,
          nullif(v_row->>'city', ''),
          nullif(v_row->>'state', ''),
          nullif(v_row->>'country', ''),
          nullif(v_row->>'industry', ''),
          v_batch_id,
          COALESCE(v_row->'raw', '{}'::jsonb)
        );

        v_cl_slug := public.import_commit_lead_slug(
          v_row, v_new_cl_id, p_campaign_id, v_new_lead_id
        );

        INSERT INTO public.campaign_leads (
          id,
          campaign_id,
          lead_id,
          batch_id,
          status,
          current_step,
          slug,
          error_code,
          error_detail,
          queued_at
        ) VALUES (
          v_new_cl_id,
          p_campaign_id,
          v_new_lead_id,
          v_batch_id,
          v_cl_status,
          'recording',
          v_cl_slug,
          CASE WHEN v_cl_status = 'skipped' THEN 'not_a_website'::public.error_code ELSE NULL END,
          CASE WHEN v_cl_status = 'skipped' THEN 'Social profile or directory listing only.' ELSE NULL END,
          CASE WHEN v_cl_status = 'queued' THEN now() ELSE NULL END
        );

        INSERT INTO public.pipeline_events (campaign_lead_id, kind, message)
        VALUES (v_new_cl_id, 'imported', 'Imported from CSV.');

        IF v_cl_status = 'queued' THEN
          INSERT INTO public.pipeline_events (campaign_lead_id, kind, message)
          VALUES (v_new_cl_id, 'queued', 'Queued for processing.');
        END IF;

        IF v_cl_status = 'queued' THEN
          v_created_ids := array_append(v_created_ids, v_new_cl_id);
        END IF;
      END IF;
    END IF;

    IF p_dry_run THEN
      v_per_row_outcomes := v_per_row_outcomes || jsonb_build_object('outcome', v_outcome);
    END IF;
  END LOOP;

  IF NOT p_dry_run THEN
    UPDATE public.import_batches
    SET
      imported_count  = v_imported,
      linked_count    = v_linked,
      duplicate_count = v_duplicate,
      skipped_count   = v_skipped
    WHERE id = v_batch_id;
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'counts', jsonb_build_object(
        'imported',  v_imported,
        'linked',    v_linked,
        'duplicate', v_duplicate,
        'skipped',   v_skipped
      ),
      'exists_list', v_exists_list,
      'per_row_outcomes', v_per_row_outcomes
    );
  END IF;

  RETURN jsonb_build_object(
    'batch_id', v_batch_id,
    'counts', jsonb_build_object(
      'imported',  v_imported,
      'linked',    v_linked,
      'duplicate', v_duplicate,
      'skipped',   v_skipped
    ),
    'exists_list', v_exists_list,
    'created_campaign_lead_ids', to_jsonb(v_created_ids)
  );
END $fn$;

-- Lead slug helper: company/full_name/name/email/ref + city, collision hash suffix.
CREATE OR REPLACE FUNCTION public.import_commit_lead_slug(
  p_row         jsonb,
  p_cl_id       uuid,
  p_campaign_id uuid,
  p_lead_id     uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $slug$
DECLARE
  v_name   text;
  v_city   text;
  v_base   text;
  v_slug   text;
  v_ref    text;
BEGIN
  v_city := nullif(btrim(p_row->>'city'), '');

  v_name := nullif(btrim(p_row->>'company'), '');
  IF v_name IS NULL THEN
    v_name := nullif(btrim(p_row->>'full_name'), '');
  END IF;
  IF v_name IS NULL THEN
    v_name := nullif(
      btrim(concat_ws(' ', nullif(p_row->>'first_name', ''), nullif(p_row->>'last_name', ''))),
      ''
    );
  END IF;
  IF v_name IS NULL AND nullif(p_row->>'email', '') IS NOT NULL THEN
    v_name := split_part(p_row->>'email', '@', 1);
  END IF;
  IF v_name IS NULL AND p_lead_id IS NOT NULL THEN
    SELECT ref INTO v_ref FROM public.leads WHERE id = p_lead_id;
    v_name := v_ref;
  END IF;
  IF v_name IS NULL THEN
    v_name := 'lead';
  END IF;

  v_base := btrim(regexp_replace(lower(v_name || COALESCE('-' || v_city, '')), '[^a-z0-9]+', '-', 'g'), '-');
  IF v_base = '' OR v_base IS NULL THEN
    v_base := 'lead';
  END IF;

  v_slug := v_base;

  IF EXISTS (
    SELECT 1 FROM public.campaign_leads cl
    WHERE cl.campaign_id = p_campaign_id AND cl.slug = v_slug
  ) THEN
    v_slug := v_base || '-' || left(replace(p_cl_id::text, '-', ''), 6);
  END IF;

  RETURN v_slug;
END $slug$;

REVOKE ALL ON FUNCTION public.import_commit(uuid, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_commit(uuid, jsonb, jsonb, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.import_commit_lead_slug(jsonb, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_commit_lead_slug(jsonb, uuid, uuid, uuid) TO service_role;
