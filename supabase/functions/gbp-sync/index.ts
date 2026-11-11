// Supabase Edge Function: Google review auto-replies.
// verify_jwt is off because the hourly job calls it with an internal secret; user calls are checked here.
//
// Hourly job:   POST { action:"cron" }  header x-cron-secret: <internal_secrets.cron_secret>
// Owner (Authorization: Bearer <user token>):
//   { action:"sync", business_id }                    pull new reviews, draft/post replies per the owner's mode
//   { action:"post", business_id, review_id, text }    post (or edit) the owner's reply on Google
//   { action:"redraft", business_id, review_id }       new AI draft
//   { action:"skip", business_id, review_id }          don't reply to this one
//   { action:"set_location", business_id, location }   pick which Business Profile location to use
//   { action:"disconnect", business_id }
// Modes (businesses.gbp_reply_mode): off | drafts | positive (auto 4–5★, drafts for 1–3★) | all
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ANTHROPIC_API_KEY (optional; templates without it).

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const PER_SYNC = 10, AI_DAILY = 80;

type Biz = { id: string; name: string; city: string | null; gbp_reply_mode: string; categories?: { name: string } | null };

async function accessToken(refresh: string) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error === "invalid_grant" ? "Google access was removed. Please connect again." : "Couldn't refresh Google access.");
  return j.access_token as string;
}
async function google(method: string, url: string, token: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 429 ? "Google hasn't approved API access yet (quota 0), or the limit was hit. Try later." : j?.error?.message || `Google error ${r.status}`);
  return j;
}

// Reply without AI. Happy reviews mention one of the owner's keywords (rotated per review) so replies still help local search;
// unhappy reviews never carry keywords.
function template(b: Biz, reviewer: string, stars: number, kws: string[] = [], seed = "") {
  const first = (reviewer || "").split(" ")[0];
  const usable = kws.map((k) => k.trim()).filter((k) => k.length >= 3 && !/near me|best|cheap|top \d|no\.? ?1/i.test(k));
  const kw = usable.length ? usable[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % usable.length] : "";
  if (stars >= 4) return kw
    ? `Thank you so much${first ? `, ${first}` : ""}! We're really glad you enjoyed your visit to ${b.name}. Whenever you need ${kw}${b.city && !kw.toLowerCase().includes(b.city.toLowerCase()) ? ` in ${b.city}` : ""}, we'd love to welcome you back!`
    : `Thank you so much${first ? `, ${first}` : ""}! We're really glad you enjoyed your visit to ${b.name}. Hope to see you again soon!`;
  return `Hi${first ? ` ${first}` : ""}, thank you for telling us, and we're sorry your visit wasn't up to the mark. This isn't the experience we want for anyone at ${b.name}. Please call or message us so we can understand what happened and make it right.`;
}
async function draftReply(admin: SupabaseClient, b: Biz, reviewer: string, stars: number, comment: string) {
  const { data: kwRows } = await admin.from("business_keywords").select("keyword").eq("business_id", b.id).limit(20);
  const kws = (kwRows ?? []).map((k) => k.keyword as string);
  const fallback = () => template(b, reviewer, stars, kws, reviewer + comment);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return fallback();
  const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true }).eq("business_id", b.id).eq("kind", "gbp_reply").gte("created_at", new Date(Date.now() - 864e5).toISOString());
  if ((count ?? 0) >= AI_DAILY) return fallback();
  const prompt = `Business: ${b.name}\nCategory: ${b.categories?.name || "local business"}\nCity: ${b.city || "India"}\nKeywords the owner chose: ${kws.join("; ") || "(none)"}
Customer name: ${reviewer || "(not given)"}\nStars: ${stars}\nTheir review: """${(comment || "(no text, star rating only)").slice(0, 2000)}"""

Write the owner's public reply on Google (max 450 characters). Thank them by first name if given.
If 4–5 stars: warm thanks, mention something specific they liked (only if they mentioned it); you may use ONE keyword only if it fits naturally.
If 1–3 stars: apologise sincerely, don't argue, don't reveal private details, invite them to contact the owner directly, use NO keywords.
Rules: simple warm Indian English (or the reviewer's language), no invented facts or offers, no hashtags, no emojis, no markdown. Reply with only the reply text.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("AI_MODEL") ?? "claude-haiku-5-5", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return fallback();
  const out = await r.json();
  await admin.from("ai_usage").insert({ business_id: b.id, kind: "gbp_reply" });
  return ((out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").trim() || fallback()).slice(0, 1000);
}

async function syncOne(admin: SupabaseClient, bid: string) {
  const { data: c } = await admin.from("gbp_connections").select("*").eq("business_id", bid).maybeSingle();
  if (!c?.location_name) return { synced: 0, note: "not connected" };
  const { data: b } = await admin.from("businesses").select("id,name,city,gbp_reply_mode,categories(name)").eq("id", bid).single();
  try {
    const token = await accessToken(c.refresh_token);
    const res = await google("GET", `https://mybusiness.googleapis.com/v4/${c.location_name}/reviews?pageSize=50&orderBy=updateTime%20desc`, token);
    const { data: known } = await admin.from("gbp_reviews").select("review_name,status").eq("business_id", bid);
    const prev = new Map((known ?? []).map((k) => [k.review_name, k.status]));
    const rows = (res.reviews ?? []).map((r: any) => {
      const replied = !!r.reviewReply?.comment, old = prev.get(r.name);
      return {
        business_id: bid, review_name: r.name, reviewer: r.reviewer?.displayName ?? "", stars: STARS[r.starRating] ?? null, comment: r.comment ?? "",
        review_time: r.createTime ?? null, reply_text: r.reviewReply?.comment ?? null, reply_time: r.reviewReply?.updateTime ?? null,
        status: replied ? "posted" : old && old !== "posted" ? old : "new", updated_at: new Date().toISOString(),
      };
    });
    if (rows.length) await admin.from("gbp_reviews").upsert(rows, { onConflict: "review_name" });

    let posted = 0, drafted = 0;
    if (b.gbp_reply_mode !== "off") {
      const { data: todo } = await admin.from("gbp_reviews").select("*").eq("business_id", bid).eq("status", "new").order("review_time", { ascending: false }).limit(PER_SYNC);
      for (const r of todo ?? []) {
        const text = await draftReply(admin, b as Biz, r.reviewer, r.stars ?? 5, r.comment);
        const auto = b.gbp_reply_mode === "all" || (b.gbp_reply_mode === "positive" && (r.stars ?? 0) >= 4);
        if (auto) {
          try {
            await google("PUT", `https://mybusiness.googleapis.com/v4/${r.review_name}/reply`, token, { comment: text });
            await admin.from("gbp_reviews").update({ status: "posted", reply_text: text, reply_time: new Date().toISOString(), draft: null, error: null }).eq("id", r.id); posted++;
          } catch (e) { await admin.from("gbp_reviews").update({ status: "error", draft: text, error: (e as Error).message }).eq("id", r.id); }
        } else { await admin.from("gbp_reviews").update({ status: "draft", draft: text }).eq("id", r.id); drafted++; }
      }
    }
    await admin.from("gbp_connections").update({ last_sync_at: new Date().toISOString(), last_error: null }).eq("business_id", bid);
    return { synced: rows.length, posted, drafted };
  } catch (e) {
    await admin.from("gbp_connections").update({ last_sync_at: new Date().toISOString(), last_error: (e as Error).message }).eq("business_id", bid);
    throw e;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const configured = !!(Deno.env.get("GOOGLE_CLIENT_ID") && Deno.env.get("GOOGLE_CLIENT_SECRET"));

  if (body.action === "cron") {
    const { data: s } = await admin.from("internal_secrets").select("value").eq("key", "cron_secret").single();
    if (!s || req.headers.get("x-cron-secret") !== s.value) return json({ error: "Not allowed" }, 403);
    if (!configured) return json({ skipped: "google not configured" });
    const { data: conns } = await admin.from("gbp_connections").select("business_id").not("location_name", "is", null);
    const out: Record<string, unknown> = {};
    for (const c of conns ?? []) {
      const { data: open } = await admin.rpc("module_open", { b: c.business_id, m: "google_replies" });
      if (!open) continue;
      try { out[c.business_id] = await syncOne(admin, c.business_id); } catch (e) { out[c.business_id] = { error: (e as Error).message }; }
    }
    return json({ ok: true, out });
  }

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  const bid = body.business_id;
  if (!bid) return json({ error: "Invalid request" }, 400);
  const { data: m } = await admin.from("business_members").select("role").eq("business_id", bid).eq("user_id", u.user.id).maybeSingle();
  const { data: prof } = await admin.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
  if (!m && !["super_admin", "team"].includes(prof?.role ?? "")) return json({ error: "Not allowed" }, 403);
  if (m) { const { data: okPerm } = await admin.rpc("member_has_perm", { b: bid, u: u.user.id, area: "reviews" }); if (!okPerm) return json({ error: "Your login isn't allowed to manage Google reviews. Ask the owner." }, 403); }
  const { data: open } = await admin.rpc("biz_open", { b: bid });
  if (!open) return json({ error: "Your plan isn't active." }, 403);
  if (body.action === "disconnect") { await admin.from("gbp_connections").delete().eq("business_id", bid); return json({ ok: true }); }
  const { data: modOn } = await admin.rpc("has_module", { b: bid, m: "google_replies" });
  if (!modOn) return json({ error: "Google auto-replies aren't in your plan. Add them from Plan & services.", module: "google_replies" }, 403);
  if (!configured) return json({ error: "Branditude is still finishing the Google connection setup.", setup: true }, 503);

  try {
    switch (body.action) {
      case "sync": return json(await syncOne(admin, bid));
      case "set_location": {
        const { data: c } = await admin.from("gbp_connections").select("locations").eq("business_id", bid).single();
        const l = (c?.locations ?? []).find((x: { name: string }) => x.name === body.location);
        if (!l) return json({ error: "Location not found" }, 400);
        await admin.from("gbp_connections").update({ location_name: l.name, location_title: l.title, account_name: l.name.split("/locations/")[0] }).eq("business_id", bid);
        await admin.from("gbp_reviews").delete().eq("business_id", bid);
        return json({ ok: true });
      }
    }
    const { data: r } = await admin.from("gbp_reviews").select("*").eq("id", body.review_id).eq("business_id", bid).maybeSingle();
    if (!r) return json({ error: "Review not found" }, 404);
    if (body.action === "skip") { await admin.from("gbp_reviews").update({ status: "skipped" }).eq("id", r.id); return json({ ok: true }); }
    if (body.action === "redraft") {
      const { data: b } = await admin.from("businesses").select("id,name,city,gbp_reply_mode,categories(name)").eq("id", bid).single();
      const draft = await draftReply(admin, b as Biz, r.reviewer, r.stars ?? 5, r.comment);
      await admin.from("gbp_reviews").update({ draft, status: r.status === "posted" ? "posted" : "draft" }).eq("id", r.id);
      return json({ draft });
    }
    if (body.action === "post") {
      const text = String(body.text ?? "").trim().slice(0, 4000);
      if (text.length < 2) return json({ error: "Write a reply first." }, 400);
      const { data: c } = await admin.from("gbp_connections").select("refresh_token").eq("business_id", bid).single();
      const token = await accessToken(c!.refresh_token);
      await google("PUT", `https://mybusiness.googleapis.com/v4/${r.review_name}/reply`, token, { comment: text });
      await admin.from("gbp_reviews").update({ status: "posted", reply_text: text, reply_time: new Date().toISOString(), draft: null, error: null }).eq("id", r.id);
      return json({ ok: true });
    }
    return json({ error: "Invalid request" }, 400);
  } catch (e) { return json({ error: (e as Error).message }, 502); }
});
