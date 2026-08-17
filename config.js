// Fill these in with your own Supabase project's values.
// Settings -> API in your Supabase dashboard has both.
// This file is safe to commit: the anon key is meant to be public,
// access is controlled by Row Level Security policies in Supabase.

const SUPABASE_URL = 'https://supabase.com/dashboard/project/vkpwsaouzqpedvbdaxsz/settings/api-keys';
const SUPABASE_ANON_KEY = 'sb_publishable_q7ncCe6xS7icMoygmfBCfw_bPrI9gKi';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
