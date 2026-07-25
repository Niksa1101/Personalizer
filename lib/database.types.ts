/**
 * Supabase Database types.
 *
 * Generated from the migration schema (docs/DB.md) because `supabase gen types
 * --linked` / `--project-id` require CLI auth not available in this environment.
 * Re-run `npx supabase gen types typescript --linked` when linked to refresh.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      campaigns: {
        Row: {
          id: string
          ref: string
          name: string
          slug: string
          description: string | null
          intro_video_id: string | null
          merge_layout: Database["public"]["Enums"]["merge_layout"]
          pip_scale: number
          landing_template: string
          cta_type: string | null
          cta_label: string | null
          cta_url: string | null
          viewport_width: number
          viewport_height: number
          nav_timeout_ms: number
          archived_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          ref?: string
          name: string
          slug: string
          description?: string | null
          intro_video_id?: string | null
          merge_layout?: Database["public"]["Enums"]["merge_layout"]
          pip_scale?: number
          landing_template: string
          cta_type?: string | null
          cta_label?: string | null
          cta_url?: string | null
          viewport_width?: number
          viewport_height?: number
          nav_timeout_ms?: number
          archived_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          ref?: string
          name?: string
          slug?: string
          description?: string | null
          intro_video_id?: string | null
          merge_layout?: Database["public"]["Enums"]["merge_layout"]
          pip_scale?: number
          landing_template?: string
          cta_type?: string | null
          cta_label?: string | null
          cta_url?: string | null
          viewport_width?: number
          viewport_height?: number
          nav_timeout_ms?: number
          archived_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_intro_video_id_fkey"
            columns: ["intro_video_id"]
            isOneToOne: false
            referencedRelation: "intro_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_leads: {
        Row: {
          id: string
          campaign_id: string
          lead_id: string
          batch_id: string | null
          status: Database["public"]["Enums"]["lead_status"]
          current_step: string
          slug: string
          netlify_url: string | null
          recording_id: string | null
          video_id: string | null
          landing_page_id: string | null
          merge_layout: Database["public"]["Enums"]["merge_layout"] | null
          pip_scale: number | null
          error_code: string | null
          error_bucket: string | null
          error_detail: string | null
          attempt_count: number
          queued_at: string | null
          started_at: string | null
          deployed_at: string | null
          promoted_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          campaign_id: string
          lead_id: string
          batch_id?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          current_step?: string
          slug: string
          netlify_url?: string | null
          recording_id?: string | null
          video_id?: string | null
          landing_page_id?: string | null
          merge_layout?: Database["public"]["Enums"]["merge_layout"] | null
          pip_scale?: number | null
          error_code?: string | null
          error_detail?: string | null
          attempt_count?: number
          queued_at?: string | null
          started_at?: string | null
          deployed_at?: string | null
          promoted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          campaign_id?: string
          lead_id?: string
          batch_id?: string | null
          status?: Database["public"]["Enums"]["lead_status"]
          current_step?: string
          slug?: string
          netlify_url?: string | null
          recording_id?: string | null
          video_id?: string | null
          landing_page_id?: string | null
          merge_layout?: Database["public"]["Enums"]["merge_layout"] | null
          pip_scale?: number | null
          error_code?: string | null
          error_detail?: string | null
          attempt_count?: number
          queued_at?: string | null
          started_at?: string | null
          deployed_at?: string | null
          promoted_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      import_batches: {
        Row: {
          id: string
          campaign_id: string
          filename: string
          slug: string
          row_count: number
          imported_count: number
          linked_count: number
          duplicate_count: number
          skipped_count: number
          rejected_rows: Json
          exists_list: Json
          delimiter: string | null
          had_bom: boolean
          created_at: string
        }
        Insert: {
          id?: string
          campaign_id: string
          filename: string
          slug: string
          row_count?: number
          imported_count?: number
          linked_count?: number
          duplicate_count?: number
          skipped_count?: number
          rejected_rows?: Json
          exists_list?: Json
          delimiter?: string | null
          had_bom?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          campaign_id?: string
          filename?: string
          slug?: string
          row_count?: number
          imported_count?: number
          linked_count?: number
          duplicate_count?: number
          skipped_count?: number
          rejected_rows?: Json
          exists_list?: Json
          delimiter?: string | null
          had_bom?: boolean
          created_at?: string
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
          id: string
          name: string
          local_path: string
          original_filename: string | null
          duration_ms: number
          width: number
          height: number
          fps: number
          file_size_bytes: number | null
          poster_path: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          local_path: string
          original_filename?: string | null
          duration_ms: number
          width?: number
          height?: number
          fps?: number
          file_size_bytes?: number | null
          poster_path?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          local_path?: string
          original_filename?: string | null
          duration_ms?: number
          width?: number
          height?: number
          fps?: number
          file_size_bytes?: number | null
          poster_path?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      videos: {
        Row: {
          id: string
          campaign_lead_id: string
          intro_video_id: string | null
          master_path: string | null
          web_path: string | null
          web_storage_key: string | null
          web_public_url: string | null
          duration_ms: number | null
          stretch_factor: number | null
          used_speed_floor: boolean
          master_size_bytes: number | null
          web_size_bytes: number | null
          poster_path: string | null
          encoded_at: string | null
          uploaded_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          campaign_lead_id: string
          intro_video_id?: string | null
          master_path?: string | null
          web_path?: string | null
          web_storage_key?: string | null
          web_public_url?: string | null
          duration_ms?: number | null
          stretch_factor?: number | null
          used_speed_floor?: boolean
          master_size_bytes?: number | null
          web_size_bytes?: number | null
          poster_path?: string | null
          encoded_at?: string | null
          uploaded_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          campaign_lead_id?: string
          intro_video_id?: string | null
          master_path?: string | null
          web_path?: string | null
          web_storage_key?: string | null
          web_public_url?: string | null
          duration_ms?: number | null
          stretch_factor?: number | null
          used_speed_floor?: boolean
          master_size_bytes?: number | null
          web_size_bytes?: number | null
          poster_path?: string | null
          encoded_at?: string | null
          uploaded_at?: string | null
          created_at?: string
          updated_at?: string
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
      leads: {
        Row: {
          id: string
          ref: string
          first_name: string | null
          last_name: string | null
          full_name: string | null
          company: string | null
          email: string | null
          phone: string | null
          website_url: string | null
          domain: string | null
          city: string | null
          state: string | null
          country: string | null
          industry: string | null
          source_batch_id: string | null
          raw: Json
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          ref?: string
          first_name?: string | null
          last_name?: string | null
          full_name?: string | null
          company?: string | null
          email?: string | null
          phone?: string | null
          website_url?: string | null
          domain?: string | null
          city?: string | null
          state?: string | null
          country?: string | null
          industry?: string | null
          source_batch_id?: string | null
          raw?: Json
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          ref?: string
          first_name?: string | null
          last_name?: string | null
          full_name?: string | null
          company?: string | null
          email?: string | null
          phone?: string | null
          website_url?: string | null
          domain?: string | null
          city?: string | null
          state?: string | null
          country?: string | null
          industry?: string | null
          source_batch_id?: string | null
          raw?: Json
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      job_runs: {
        Row: {
          id: string
          campaign_lead_id: string
          step: Database["public"]["Enums"]["pipeline_step"]
          state: Database["public"]["Enums"]["job_state"]
          attempt: number
          queue_job_id: string | null
          worker_id: string | null
          error_code: Database["public"]["Enums"]["error_code"] | null
          error_detail: string | null
          started_at: string
          finished_at: string | null
          duration_ms: number | null
        }
        Insert: {
          id?: string
          campaign_lead_id: string
          step: Database["public"]["Enums"]["pipeline_step"]
          state?: Database["public"]["Enums"]["job_state"]
          attempt?: number
          queue_job_id?: string | null
          worker_id?: string | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          error_detail?: string | null
          started_at?: string
          finished_at?: string | null
        }
        Update: {
          id?: string
          campaign_lead_id?: string
          step?: Database["public"]["Enums"]["pipeline_step"]
          state?: Database["public"]["Enums"]["job_state"]
          attempt?: number
          queue_job_id?: string | null
          worker_id?: string | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          error_detail?: string | null
          started_at?: string
          finished_at?: string | null
        }
        Relationships: []
      }
      recordings: {
        Row: {
          id: string
          lead_id: string
          local_path: string | null
          duration_ms: number | null
          width: number | null
          height: number | null
          page_height_px: number | null
          file_size_bytes: number | null
          screenshot_before_path: string | null
          screenshot_after_path: string | null
          recorded_at: string | null
          purged_at: string | null
          error_code: Database["public"]["Enums"]["error_code"] | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          lead_id: string
          local_path?: string | null
          duration_ms?: number | null
          width?: number | null
          height?: number | null
          page_height_px?: number | null
          file_size_bytes?: number | null
          screenshot_before_path?: string | null
          screenshot_after_path?: string | null
          recorded_at?: string | null
          purged_at?: string | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          lead_id?: string
          local_path?: string | null
          duration_ms?: number | null
          width?: number | null
          height?: number | null
          page_height_px?: number | null
          file_size_bytes?: number | null
          screenshot_before_path?: string | null
          screenshot_after_path?: string | null
          recorded_at?: string | null
          purged_at?: string | null
          error_code?: Database["public"]["Enums"]["error_code"] | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      logs: {
        Row: {
          id: number
          level: Database["public"]["Enums"]["log_level"]
          scope: string
          message: string
          campaign_lead_id: string | null
          job_run_id: string | null
          meta: Json
          created_at: string
        }
        Insert: {
          id?: never
          level?: Database["public"]["Enums"]["log_level"]
          scope: string
          message: string
          campaign_lead_id?: string | null
          job_run_id?: string | null
          meta?: Json
          created_at?: string
        }
        Update: {
          id?: never
          level?: Database["public"]["Enums"]["log_level"]
          scope?: string
          message?: string
          campaign_lead_id?: string | null
          job_run_id?: string | null
          meta?: Json
          created_at?: string
        }
        Relationships: []
      }
      pipeline_events: {
        Row: {
          id: number
          campaign_lead_id: string
          kind: Database["public"]["Enums"]["event_kind"]
          step: Database["public"]["Enums"]["pipeline_step"] | null
          message: string
          error_code: Database["public"]["Enums"]["error_code"] | null
          meta: Json
          created_at: string
        }
        Insert: {
          id?: never
          campaign_lead_id: string
          kind: Database["public"]["Enums"]["event_kind"]
          step?: Database["public"]["Enums"]["pipeline_step"] | null
          message: string
          error_code?: Database["public"]["Enums"]["error_code"] | null
          meta?: Json
          created_at?: string
        }
        Update: {
          id?: never
          campaign_lead_id?: string
          kind?: Database["public"]["Enums"]["event_kind"]
          step?: Database["public"]["Enums"]["pipeline_step"] | null
          message?: string
          error_code?: Database["public"]["Enums"]["error_code"] | null
          meta?: Json
          created_at?: string
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
      settings: {
        Row: {
          key: string
          value: Json
          description: string | null
          updated_at: string
        }
        Insert: {
          key: string
          value: Json
          description?: string | null
          updated_at?: string
        }
        Update: {
          key?: string
          value?: Json
          description?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      import_commit: {
        Args: {
          p_campaign_id: string
          p_batch: Json
          p_rows: Json
          p_dry_run?: boolean
        }
        Returns: Json
      }
    }
    Enums: {
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
      log_level: "debug" | "info" | "warn" | "error"
      job_state: "running" | "succeeded" | "failed" | "interrupted"
      pipeline_step: "recording" | "merge" | "page" | "deploy"
      lead_status:
        | "queued"
        | "processing"
        | "paused"
        | "deployed"
        | "ready"
        | "failed"
        | "skipped"
      merge_layout:
        | "bubble_br"
        | "bubble_bl"
        | "bubble_tr"
        | "bubble_tl"
        | "rect_br"
        | "fullscreen_intro"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
