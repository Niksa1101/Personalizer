import "server-only"

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@/lib/database.types"
import { assertEnv } from "@/lib/env"

export type SupabaseAdmin = SupabaseClient<Database>

let client: SupabaseAdmin | null = null

/** Lazy singleton service-role client. Never import from a client component. */
export function getSupabaseAdmin(): SupabaseAdmin {
  if (client) return client

  const env = assertEnv()
  client = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  )

  return client
}
