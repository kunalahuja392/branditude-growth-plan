// Supabase Edge Function: start "Connect Google Business Profile" for a business.
// POST { business_id }  (Authorization: business user's token) → { url } to send the owner to Google's consent screen.
// Secrets: GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET for the callback). Missing → 503 {setup:true}.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!clientId || !Deno.env.get("GOOGLE_CLIENT_SECRET")) return json({ error: "Branditude is still finishing the Google connection setup. We'll switch this on for you soon.", setup: true }, 503);
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  let body: { business_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const bid = body.business_id;
  if (!bid) return json({ error: "Invalid request" }, 400);
  const { data: m } = await admin.from("business_members").select("role").eq("business_id", bid).eq("user_id", u.user.id).maybeSingle();
  if (!m) return json({ error: "Not allowed" }, 403);
  const { data: open } = await admin.rpc("biz_open", { b: bid });
  if (!open) return json({ error: "Your plan isn't active." }, 403);
  const { data: modOn } = await admin.rpc("has_module", { b: bid, m: "google_replies" });
  if (!modOn) return json({ error: "Google auto-replies aren't in your plan. Add them from Plan & services.", module: "google_replies" }, 403);

  const state = crypto.randomUUID() + crypto.randomUUID();
  await admin.from("oauth_states").delete().lt("created_at", new Date(Date.now() - 3600e3).toISOString());
  await admin.from("oauth_states").insert({ state, business_id: bid, user_id: u.user.id });

  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: `${url}/functions/v1/gbp-callback`, response_type: "code",
    scope: "https://www.googleapis.com/auth/business.manage", access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return json({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString() });
});
