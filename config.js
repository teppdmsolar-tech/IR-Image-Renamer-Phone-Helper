// Fill these in with your own Supabase project's values.
// Settings -> API in your Supabase dashboard has both.
// This file is safe to commit: the anon key is meant to be public,
// access is controlled by Row Level Security policies in Supabase.

const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
