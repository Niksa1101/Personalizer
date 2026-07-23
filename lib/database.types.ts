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
      [_ in never]: never
    }
    Enums: {
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
