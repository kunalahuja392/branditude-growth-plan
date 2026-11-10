// Supabase Edge Function: AI writing for a business's OWN Google content
// (profile description, Google posts, FAQ, replies to reviews) and keyword suggestions.
// It never writes reviews for customers (Google forbids directing review content).
//
// POST /functions/v1/ai-content   Authorization: Bearer <business user's token>
// Body: { business_id, kind: "suggest_keywords"|"description"|"post"|"faq"|"reply", input?: {...} }
// Secret: ANTHROPIC_API_KEY (optional AI_MODEL, default claude-haiku-5-5). Without the key → 503 and the app uses templates.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const DAILY_LIMIT = 40;

const RULES = `Rules:
- Write in simple, warm Indian English for local customers.
- Use the keywords only where they read naturally. Never list or repeat them, never stuff them.
- Do not invent facts, prices, awards, ratings, years in business, or claims like "No. 1" or "best in city".
- No hashtags, no emojis unless asked, no markdown.`;

function prompt(kind: string, b: Record<string, string>, kws: string[], input: Record<string, string>) {
  const ctx = `Business: ${b.name}\nCategory: ${b.category || "local business"}\nCity: ${b.city || "India"}\nKeywords the owner chose: ${kws.join("; ") || "(none)"}`;
  switch (kind) {
    case "suggest_keywords":
      return `${ctx}\n\nSuggest 12 local search phrases real customers in ${b.city || "this city"} type into Google or ask AI assistants when looking for a business like this. Mix: service + city, "near me", specific products/services, occasions. Lower case, 2–6 words each. Reply with ONLY a JSON array of strings.`;
    case "description":
      return `${ctx}\nExtra details from the owner: ${input.details || "(none)"}\n\nWrite a Google Business Profile description (max 700 characters): what the business offers, who it is for, what makes it worth visiting, and an invitation to visit. Use 2–4 of the keywords naturally. ${RULES}`;
    case "post":
      return `${ctx}\nPost topic from the owner: ${input.topic || "a general update"}\n\nWrite a Google Business Profile post (max 900 characters) about this topic, ending with a clear call to action. Use 1–3 keywords naturally. ${RULES}`;
    case "faq":
      return `${ctx}\nExtra details from the owner: ${input.details || "(none)"}\n\nWrite 6 short FAQs customers ask about a business like this (location, timings, services, booking, parking, payments etc.). Where you don't know a fact, write a placeholder in square brackets like [timings]. Use keywords naturally in a few answers. Format each as "Q: ...\\nA: ..." separated by a blank line. ${RULES}`;
    case "reply":
      return `${ctx}\nCustomer name: ${input.reviewer || "(not given)"}\nStars: ${input.stars || "?"}\nTheir review: """${(input.review || "").slice(0, 2000)}"""\n\nWrite the owner's public reply (max 450 characters). Thank them by first name if given. If 4–5 stars: warm thanks and mention something specific they liked; you may use ONE keyword if it fits naturally. If 1–3 stars: apologise sincerely, don't argue or reveal private details, invite them to contact the owner directly, and use NO keywords. ${RULES}`;
  }
  return "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "AI writing isn't switched on yet.", fallback: true }, 503);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "Please sign in again." }, 401);

  let body: { business_id?: string; kind?: string; input?: Record<string, string> };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const { business_id, kind } = body; const input = body.input ?? {};
  if (!business_id || !["suggest_keywords", "description", "post", "faq", "reply"].includes(kind ?? "")) return json({ error: "Invalid request" }, 400);

  const { data: m } = await admin.from("business_members").select("role").eq("business_id", business_id).eq("user_id", u.user.id).maybeSingle();
  if (!m) return json({ error: "Not allowed" }, 403);
  const { data: open } = await admin.rpc("biz_open", { b: business_id });
  if (!open) return json({ error: "Your plan isn't active. Pay for your plan to use AI writing." }, 403);
  const mod = kind === "reply" ? ["seo", "google_replies"] : ["seo"];
  const ok = await Promise.all(mod.map((k) => admin.rpc("has_module", { b: business_id, m: k }).then((r) => !!r.data)));
  if (!ok.some(Boolean)) return json({ error: "Keywords & SEO isn't in your plan. Add it from Plan & services.", module: "seo" }, 403);

  const since = new Date(Date.now() - 864e5).toISOString();
  const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true }).eq("business_id", business_id).gte("created_at", since);
  if ((count ?? 0) >= DAILY_LIMIT) return json({ error: `You've used today's ${DAILY_LIMIT} AI drafts. Try again tomorrow.` }, 429);

  const { data: b } = await admin.from("businesses").select("name, city, categories(name)").eq("id", business_id).single();
  const { data: kw } = await admin.from("business_keywords").select("keyword").eq("business_id", business_id).limit(30);
  const biz = { name: b?.name ?? "", city: b?.city ?? "", category: (b as any)?.categories?.name ?? "" };
  const text = prompt(kind!, biz, (kw ?? []).map((k) => k.keyword), input);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("AI_MODEL") ?? "claude-haiku-5-5", max_tokens: 900, messages: [{ role: "user", content: text }] }),
  });
  const out = await r.json();
  if (!r.ok) return json({ error: "AI is busy right now. Try again in a minute.", fallback: true }, 502);
  const reply = (out.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").trim();
  await admin.from("ai_usage").insert({ business_id, kind });

  if (kind === "suggest_keywords") {
    let list: string[] = [];
    try { list = JSON.parse(reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1)); } catch { list = reply.split("\n").map((s) => s.replace(/^[-*\d.\s"]+|[",]+$/g, "").trim()).filter(Boolean); }
    return json({ keywords: list.filter((s) => typeof s === "string" && s.length >= 2 && s.length <= 80).slice(0, 15) });
  }
  return json({ text: reply });
});
