export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      campaign_leads: {
        Row: {
          attempt_count: number
          batch_id: string | null
          campaign_id: string
          created_at: string
          current_step: Database["public"]["Enums"]["pipeline_step"]
          deployed_at: string | null
          deployed_dry_run: boolean
          error_bucket: Database["public"]["Enums"]["error_bucket"] | null
          error_code: Database["public"]["Enums"]["error_code"] | null
          error_detail: string | null
          id: string
          landing_page_id: string | null
          lead_id: string
          merge_layout: Database["public"]["Enums"]["merge_layout"] | null
          netlify_url: string | null
          pip_scale: number | null
          promoted_at: string | null
          queued_at: string | null
          recording_id: string | null
          slug: string
          started_at: string | null
          status: Database["public"]["Enums"]["lead_status"]
          updated_at: string
          video_id: string | null
        }
        Insert: {
          attempt_count?: number
          batch_id?: string | null
          campaign_id: string
          created_at?: string
          current_step?: Database["public"]["Enums"]["pipeline_step"]
          deployed_at?: string | null
          deployed_dry_run?: boolean
          error_bucket?: Database["public"]["Enums"]["error_bucket"] | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          error_detail?: string | null
          id?: string
          landing_page_id?: string | null
          lead_id: string
          merge_layout?: Database["public"]["Enums"]["merge_layout"] | null
          netlify_url?: string | null
          pip_scale?: number | null
          promoted_at?: string | null
          queued_at?: string | null
          recording_id?: string | null
          slug: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          updated_at?: string
          video_id?: string | null
        }
        Update: {
          attempt_count?: number
          batch_id?: string | null
          campaign_id?: string
          created_at?: string
          current_step?: Database["public"]["Enums"]["pipeline_step"]
          deployed_at?: string | null
          deployed_dry_run?: boolean
          error_bucket?: Database["public"]["Enums"]["error_bucket"] | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          error_detail?: string | null
          id?: string
          landing_page_id?: string | null
          lead_id?: string
          merge_layout?: Database["public"]["Enums"]["merge_layout"] | null
          netlify_url?: string | null
          pip_scale?: number | null
          promoted_at?: string | null
          queued_at?: string | null
          recording_id?: string | null
          slug?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          updated_at?: string
          video_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_leads_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_landing_page_fk"
            columns: ["landing_page_id"]
            isOneToOne: false
            referencedRelation: "landing_pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_recording_fk"
            columns: ["recording_id"]
            isOneToOne: false
            referencedRelation: "recordings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_video_fk"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "videos"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          archived_at: string | null
          created_at: string
          cta_label: string | null
          cta_type: string | null
          cta_url: string | null
          description: string | null
          id: string
          intro_video_id: string | null
          landing_template: string
          merge_layout: Database["public"]["Enums"]["merge_layout"]
          name: string
          nav_timeout_ms: number
          pip_scale: number
          ref: string
          slug: string
          updated_at: string
          viewport_height: number
          viewport_width: number
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          cta_label?: string | null
          cta_type?: string | null
          cta_url?: string | null
          description?: string | null
          id?: string
          intro_video_id?: string | null
          landing_template: string
          merge_layout?: Database["public"]["Enums"]["merge_layout"]
          name: string
          nav_timeout_ms?: number
          pip_scale?: number
          ref?: string
          slug: string
          updated_at?: string
          viewport_height?: number
          viewport_width?: number
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          cta_label?: string | null
          cta_type?: string | null
          cta_url?: string | null
          description?: string | null
          id?: string
          intro_video_id?: string | null
          landing_template?: string
          merge_layout?: Database["public"]["Enums"]["merge_layout"]
          name?: string
          nav_timeout_ms?: number
          pip_scale?: number
          ref?: string
          slug?: string
          updated_at?: string
          viewport_height?: number
          viewport_width?: number
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_intro_video_fk"
            columns: ["intro_video_id"]
            isOneToOne: false
            referencedRelation: "intro_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      heartbeat: {
        Row: {
          created_at: string
          id: number
          source: string
        }
        Insert: {
          created_at?: string
          id?: never
          source?: string
        }
        Update: {
          created_at?: string
          id?: never
          source?: string
        }
        Relationships: []
      }
      import_batches: {
        Row: {
          campaign_id: string
          created_at: string
          delimiter: string | null
          duplicate_count: number
          exists_list: Json
          filename: string
          had_bom: boolean
          id: string
          imported_count: number
          linked_count: number
          rejected_rows: Json
          row_count: number
          skipped_count: number
          slug: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          delimiter?: string | null
          duplicate_count?: number
          exists_list?: Json
          filename: string
          had_bom?: boolean
          id?: string
          imported_count?: number
          linked_count?: number
          rejected_rows?: Json
          row_count?: number
          skipped_count?: number
          slug: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          delimiter?: string | null
          duplicate_count?: number
          exists_list?: Json
          filename?: string
          had_bom?: boolean
          id?: string
          imported_count?: number
          linked_count?: number
          rejected_rows?: Json
          row_count?: number
          skipped_count?: number
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      intro_videos: {
        Row: {
          created_at: string
          duration_ms: number
          file_size_bytes: number | null
          fps: number
          height: number
          id: string
          local_path: string
          name: string
          original_filename: string | null
          poster_path: string | null
          updated_at: string
          width: number
        }
        Insert: {
          created_at?: string
          duration_ms: number
          file_size_bytes?: number | null
          fps?: number
          height?: number
          id?: string
          local_path: string
          name: string
          original_filename?: string | null
          poster_path?: string | null
          updated_at?: string
          width?: number
        }
        Update: {
          created_at?: string
          duration_ms?: number
          file_size_bytes?: number | null
          fps?: number
          height?: number
          id?: string
          local_path?: string
          name?: string
          original_filename?: string | null
          poster_path?: string | null
          updated_at?: string
          width?: number
        }
        Relationships: []
      }
      job_runs: {
        Row: {
          attempt: number
          campaign_lead_id: string
          duration_ms: number | null
          error_code: Database["public"]["Enums"]["error_code"] | null
          error_detail: string | null
          finished_at: string | null
          id: string
          queue_job_id: string | null
          started_at: string
          state: Database["public"]["Enums"]["job_state"]
          step: Database["public"]["Enums"]["pipeline_step"]
          worker_id: string | null
        }
        Insert: {
          attempt?: number
          campaign_lead_id: string
          duration_ms?: number | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          error_detail?: string | null
          finished_at?: string | null
          id?: string
          queue_job_id?: string | null
          started_at?: string
          state?: Database["public"]["Enums"]["job_state"]
          step: Database["public"]["Enums"]["pipeline_step"]
          worker_id?: string | null
        }
        Update: {
          attempt?: number
          campaign_lead_id?: string
          duration_ms?: number | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          error_detail?: string | null
          finished_at?: string | null
          id?: string
          queue_job_id?: string | null
          started_at?: string
          state?: Database["public"]["Enums"]["job_state"]
          step?: Database["public"]["Enums"]["pipeline_step"]
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_runs_campaign_lead_id_fkey"
            columns: ["campaign_lead_id"]
            isOneToOne: false
            referencedRelation: "campaign_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      landing_pages: {
        Row: {
          campaign_lead_id: string
          content_sha1: string | null
          created_at: string
          deploy_status: Database["public"]["Enums"]["deploy_status"]
          deployed_at: string | null
          error_detail: string | null
          html: string | null
          id: string
          netlify_deploy_id: string | null
          path: string
          unpublished_at: string | null
          updated_at: string
        }
        Insert: {
          campaign_lead_id: string
          content_sha1?: string | null
          created_at?: string
          deploy_status?: Database["public"]["Enums"]["deploy_status"]
          deployed_at?: string | null
          error_detail?: string | null
          html?: string | null
          id?: string
          netlify_deploy_id?: string | null
          path: string
          unpublished_at?: string | null
          updated_at?: string
        }
        Update: {
          campaign_lead_id?: string
          content_sha1?: string | null
          created_at?: string
          deploy_status?: Database["public"]["Enums"]["deploy_status"]
          deployed_at?: string | null
          error_detail?: string | null
          html?: string | null
          id?: string
          netlify_deploy_id?: string | null
          path?: string
          unpublished_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "landing_pages_campaign_lead_id_fkey"
            columns: ["campaign_lead_id"]
            isOneToOne: true
            referencedRelation: "campaign_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          city: string | null
          company: string | null
          country: string | null
          created_at: string
          domain: string | null
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string
          industry: string | null
          last_name: string | null
          phone: string | null
          raw: Json
          ref: string
          source_batch_id: string | null
          state: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          domain?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          industry?: string | null
          last_name?: string | null
          phone?: string | null
          raw?: Json
          ref?: string
          source_batch_id?: string | null
          state?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          domain?: string | null
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          industry?: string | null
          last_name?: string | null
          phone?: string | null
          raw?: Json
          ref?: string
          source_batch_id?: string | null
          state?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_source_batch_id_fkey"
            columns: ["source_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      logs: {
        Row: {
          campaign_lead_id: string | null
          created_at: string
          id: number
          job_run_id: string | null
          level: Database["public"]["Enums"]["log_level"]
          message: string
          meta: Json
          scope: string
        }
        Insert: {
          campaign_lead_id?: string | null
          created_at?: string
          id?: never
          job_run_id?: string | null
          level?: Database["public"]["Enums"]["log_level"]
          message: string
          meta?: Json
          scope: string
        }
        Update: {
          campaign_lead_id?: string | null
          created_at?: string
          id?: never
          job_run_id?: string | null
          level?: Database["public"]["Enums"]["log_level"]
          message?: string
          meta?: Json
          scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "logs_campaign_lead_id_fkey"
            columns: ["campaign_lead_id"]
            isOneToOne: false
            referencedRelation: "campaign_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "logs_job_run_id_fkey"
            columns: ["job_run_id"]
            isOneToOne: false
            referencedRelation: "job_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_events: {
        Row: {
          campaign_lead_id: string
          created_at: string
          error_code: Database["public"]["Enums"]["error_code"] | null
          id: number
          kind: Database["public"]["Enums"]["event_kind"]
          message: string
          meta: Json
          step: Database["public"]["Enums"]["pipeline_step"] | null
        }
        Insert: {
          campaign_lead_id: string
          created_at?: string
          error_code?: Database["public"]["Enums"]["error_code"] | null
          id?: never
          kind: Database["public"]["Enums"]["event_kind"]
          message: string
          meta?: Json
          step?: Database["public"]["Enums"]["pipeline_step"] | null
        }
        Update: {
          campaign_lead_id?: string
          created_at?: string
          error_code?: Database["public"]["Enums"]["error_code"] | null
          id?: never
          kind?: Database["public"]["Enums"]["event_kind"]
          message?: string
          meta?: Json
          step?: Database["public"]["Enums"]["pipeline_step"] | null
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_events_campaign_lead_id_fkey"
            columns: ["campaign_lead_id"]
            isOneToOne: false
            referencedRelation: "campaign_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      recordings: {
        Row: {
          created_at: string
          duration_ms: number | null
          error_code: Database["public"]["Enums"]["error_code"] | null
          file_size_bytes: number | null
          height: number | null
          id: string
          lead_id: string
          local_path: string | null
          page_height_px: number | null
          purged_at: string | null
          recorded_at: string | null
          screenshot_after_path: string | null
          screenshot_before_path: string | null
          updated_at: string
          width: number | null
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          file_size_bytes?: number | null
          height?: number | null
          id?: string
          lead_id: string
          local_path?: string | null
          page_height_px?: number | null
          purged_at?: string | null
          recorded_at?: string | null
          screenshot_after_path?: string | null
          screenshot_before_path?: string | null
          updated_at?: string
          width?: number | null
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          file_size_bytes?: number | null
          height?: number | null
          id?: string
          lead_id?: string
          local_path?: string | null
          page_height_px?: number | null
          purged_at?: string | null
          recorded_at?: string | null
          screenshot_after_path?: string | null
          screenshot_before_path?: string | null
          updated_at?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "recordings_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      retained_pages: {
        Row: {
          campaign_ref: string | null
          content_sha1: string
          html: string
          id: string
          lead_ref: string | null
          path: string
          reason: string | null
          retained_at: string
        }
        Insert: {
          campaign_ref?: string | null
          content_sha1: string
          html: string
          id?: string
          lead_ref?: string | null
          path: string
          reason?: string | null
          retained_at?: string
        }
        Update: {
          campaign_ref?: string | null
          content_sha1?: string
          html?: string
          id?: string
          lead_ref?: string | null
          path?: string
          reason?: string | null
          retained_at?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      videos: {
        Row: {
          campaign_lead_id: string
          created_at: string
          duration_ms: number | null
          encoded_at: string | null
          id: string
          intro_video_id: string | null
          master_path: string | null
          master_size_bytes: number | null
          poster_path: string | null
          poster_storage_key: string | null
          stretch_factor: number | null
          updated_at: string
          uploaded_at: string | null
          used_speed_floor: boolean
          web_path: string | null
          web_public_url: string | null
          web_size_bytes: number | null
          web_storage_key: string | null
        }
        Insert: {
          campaign_lead_id: string
          created_at?: string
          duration_ms?: number | null
          encoded_at?: string | null
          id?: string
          intro_video_id?: string | null
          master_path?: string | null
          master_size_bytes?: number | null
          poster_path?: string | null
          poster_storage_key?: string | null
          stretch_factor?: number | null
          updated_at?: string
          uploaded_at?: string | null
          used_speed_floor?: boolean
          web_path?: string | null
          web_public_url?: string | null
          web_size_bytes?: number | null
          web_storage_key?: string | null
        }
        Update: {
          campaign_lead_id?: string
          created_at?: string
          duration_ms?: number | null
          encoded_at?: string | null
          id?: string
          intro_video_id?: string | null
          master_path?: string | null
          master_size_bytes?: number | null
          poster_path?: string | null
          poster_storage_key?: string | null
          stretch_factor?: number | null
          updated_at?: string
          uploaded_at?: string | null
          used_speed_floor?: boolean
          web_path?: string | null
          web_public_url?: string | null
          web_size_bytes?: number | null
          web_storage_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "videos_campaign_lead_id_fkey"
            columns: ["campaign_lead_id"]
            isOneToOne: true
            referencedRelation: "campaign_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "videos_intro_video_id_fkey"
            columns: ["intro_video_id"]
            isOneToOne: false
            referencedRelation: "intro_videos"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      delete_campaign_retaining_pages: {
        Args: { p_campaign_id: string; p_retain: boolean }
        Returns: undefined
      }
      error_code_bucket: {
        Args: { code: Database["public"]["Enums"]["error_code"] }
        Returns: Database["public"]["Enums"]["error_bucket"]
      }
      import_commit: {
        Args: {
          p_batch: Json
          p_campaign_id: string
          p_dry_run?: boolean
          p_rows: Json
        }
        Returns: Json
      }
      import_commit_lead_slug: {
        Args: {
          p_campaign_id: string
          p_cl_id: string
          p_lead_id: string
          p_row: Json
        }
        Returns: string
      }
      next_campaign_ref: { Args: never; Returns: string }
      next_lead_ref: { Args: never; Returns: string }
      normalize_domain: { Args: { raw: string }; Returns: string }
      seed_demo_data: { Args: never; Returns: Json }
      snapshot_live_pages: {
        Args: { p_campaign_lead_ids: string[] }
        Returns: undefined
      }
      update_campaign_general: {
        Args: {
          p_campaign_id: string
          p_description: string
          p_name: string
          p_slug: string
        }
        Returns: undefined
      }
    }
    Enums: {
      deploy_status: "pending" | "uploading" | "live" | "failed" | "removed"
      error_bucket: "bad_website" | "blocked" | "system"
      error_code:
        | "dns_failure"
        | "connection_refused"
        | "ssl_error"
        | "http_4xx"
        | "http_5xx"
        | "parked_domain"
        | "empty_page"
        | "not_a_website"
        | "bot_detected"
        | "captcha"
        | "geo_blocked"
        | "login_required"
        | "nav_timeout"
        | "browser_crash"
        | "ffmpeg_failure"
        | "intro_missing"
        | "missing_asset"
        | "storage_upload_failed"
        | "netlify_failure"
        | "disk_full"
        | "unknown"
      event_kind:
        | "imported"
        | "queued"
        | "step_started"
        | "step_succeeded"
        | "step_failed"
        | "retry_scheduled"
        | "paused"
        | "resumed"
        | "interrupted"
        | "deployed"
        | "promoted"
        | "unpublished"
        | "note"
      job_state: "running" | "succeeded" | "failed" | "interrupted"
      lead_status:
        | "queued"
        | "processing"
        | "paused"
        | "deployed"
        | "ready"
        | "failed"
        | "skipped"
      log_level: "debug" | "info" | "warn" | "error"
      merge_layout:
        | "bubble_br"
        | "bubble_bl"
        | "bubble_tr"
        | "bubble_tl"
        | "rect_br"
        | "fullscreen_intro"
      pipeline_step: "recording" | "merge" | "page" | "deploy"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      deploy_status: ["pending", "uploading", "live", "failed", "removed"],
      error_bucket: ["bad_website", "blocked", "system"],
      error_code: [
        "dns_failure",
        "connection_refused",
        "ssl_error",
        "http_4xx",
        "http_5xx",
        "parked_domain",
        "empty_page",
        "not_a_website",
        "bot_detected",
        "captcha",
        "geo_blocked",
        "login_required",
        "nav_timeout",
        "browser_crash",
        "ffmpeg_failure",
        "intro_missing",
        "missing_asset",
        "storage_upload_failed",
        "netlify_failure",
        "disk_full",
        "unknown",
      ],
      event_kind: [
        "imported",
        "queued",
        "step_started",
        "step_succeeded",
        "step_failed",
        "retry_scheduled",
        "paused",
        "resumed",
        "interrupted",
        "deployed",
        "promoted",
        "unpublished",
        "note",
      ],
      job_state: ["running", "succeeded", "failed", "interrupted"],
      lead_status: [
        "queued",
        "processing",
        "paused",
        "deployed",
        "ready",
        "failed",
        "skipped",
      ],
      log_level: ["debug", "info", "warn", "error"],
      merge_layout: [
        "bubble_br",
        "bubble_bl",
        "bubble_tr",
        "bubble_tl",
        "rect_br",
        "fullscreen_intro",
      ],
      pipeline_step: ["recording", "merge", "page", "deploy"],
    },
  },
} as const
