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
