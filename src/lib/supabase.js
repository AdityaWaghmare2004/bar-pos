import { createClient } from '@supabase/supabase-js';

// Fill these in from your Supabase project settings (Settings -> API).
// Using Vite env vars so they're not hardcoded in source.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
