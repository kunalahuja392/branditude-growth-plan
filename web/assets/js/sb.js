import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// Tests can inject a fake client via window.__BGP_FAKE_SB__
export const sb = window.__BGP_FAKE_SB__ || createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
export const configured = !!window.__BGP_FAKE_SB__ || !SUPABASE_URL.includes("YOUR-PROJECT");

// Unwrap { data, error } and throw a readable error
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(friendly(error));
  return data;
}
export function friendly(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  if (/JWT|token/i.test(m)) return "Your session has expired. Please sign in again.";
  if (/violates row-level security|permission denied/i.test(m)) return "You don't have permission to do that.";
  if (/duplicate key/i.test(m)) return "That already exists.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Can't reach the server. Check your internet connection.";
  return m;
}
