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

/**
 * The filter methods our query helpers apply. `PostgrestFilterBuilder` takes
 * eight type parameters and differs between a `head: true` count query and a
 * paged read, so helpers take the builder generically and cast to this shape
 * internally — deriving it with `ReturnType<…["from"]>` silently resolves to
 * `PostgrestQueryBuilder`, which has none of these methods.
 */
export type PostgrestFilterable = {
  eq(column: string, value: unknown): PostgrestFilterable
  in(column: string, values: readonly unknown[]): PostgrestFilterable
  is(column: string, value: null): PostgrestFilterable
  or(filters: string, options?: { referencedTable?: string }): PostgrestFilterable
}
