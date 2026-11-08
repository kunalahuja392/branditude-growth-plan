// Supabase Edge Function: Google sends the owner back here after consent (verify_jwt off — it's a browser redirect).
// Exchanges the code, finds the owner's Business Profile locations, stores the refresh token (service role only),
// then redirects to the portal: app.html#replies?gbp=ok|error
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, optional SITE_URL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SITE = Deno.env.get("SITE_URL") ?? "https://kunalahuja392.github.io/branditude-growth-plan";
const back = (status: string, msg = "") => Response.redirect(`${SITE}/app.html#replies?gbp=${status}${msg ? "&msg=" + encodeURIComponent(msg) : ""}`, 302);

async function gget(u: string, token: string) {
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.status === "RESOURCE_EXHAUSTED" || r.status === 429
    ? "Google hasn't approved API access for Branditude yet (quota 0). We'll let you know when it's live."
    : j?.error?.message || `Google error ${r.status}`);
  return j;
}

Deno.serve(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  if (q.get("error")) return back("error", "Google connection was cancelled.");
  const code = q.get("code"), state = q.get("state");
  if (!code || !state) return back("error", "Missing details from Google.");
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: st } = await admin.from("oauth_states").select("*").eq("state", state).maybeSingle();
  await admin.from("oauth_states").delete().eq("state", state);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60e3) return back("error", "That link expired. Please try connecting again.");

  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, redirect_uri: `${url}/functions/v1/gbp-callback`, grant_type: "authorization_code" }),
  });
  const tok = await tr.json();
  if (!tr.ok || !tok.refresh_token) return back("error", "Google didn't give us access. Please try again and allow access.");

  let locations: { name: string; title: string; address: string }[] = [], accountName = "", err = "";
  try {
    const acc = await gget("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", tok.access_token);
    for (const a of acc.accounts ?? []) {
      const ls = await gget(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`, tok.access_token);
      for (const l of ls.locations ?? []) {
        if (!accountName) accountName = a.name;
        locations.push({ name: `${a.name}/${l.name}`, title: l.title ?? "", address: [l.storefrontAddress?.addressLines?.join(", "), l.storefrontAddress?.locality].filter(Boolean).join(", ") });
      }
    }
  } catch (e) { err = (e as Error).message; }

  const { data: biz } = await admin.from("businesses").select("name").eq("id", st.business_id).single();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pick = locations.find((l) => norm(l.title) === norm(biz?.name ?? "")) ?? locations.find((l) => norm(l.title).includes(norm(biz?.name ?? "").slice(0, 6))) ?? locations[0];

  await admin.from("gbp_connections").upsert({
    business_id: st.business_id, refresh_token: tok.refresh_token, account_name: pick ? pick.name.split("/locations/")[0] : accountName || null,
    location_name: pick?.name ?? null, location_title: pick?.title ?? null, locations, connected_by: st.user_id, connected_at: new Date().toISOString(),
    last_error: err || (locations.length ? null : "No Business Profile found on this Google account. Sign in with the account that owns your profile."),
  });
  return err ? back("error", err) : back("ok");
});
