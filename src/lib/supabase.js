import { createClient } from '@supabase/supabase-js';

// Fill these in from your Supabase project settings (Settings -> API).
// Using Vite env vars so they're not hardcoded in source.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

let supabase = null;

function createSafeSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.info('[bar-pos] Supabase is not configured; continuing in offline mode.');
    return null;
  }

  try {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (error) {
    console.warn('[bar-pos] Supabase client could not be initialized:', error);
    return null;
  }
}

supabase = createSafeSupabaseClient();

export { supabase };
export function hasSupabaseConfig() {
  return Boolean(supabase);
}
