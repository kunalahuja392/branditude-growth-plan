// Supabase Edge Function: AI review suggestions for a happy customer (4–5★), built from what THEY said they liked.
// Public (feedback page, no login): verify_jwt off, validated and rate-limited here (shares review_polish_usage).
// POST { slug, picks: string[], rating }  →  { suggestions: [{label, text}] }   (3 varied, natural, SEO-friendly)
// Some suggestions mention the city or locality naturally; never all three, never stuffed. The customer edits before posting.
// Secret: GROQ_API_KEY (free) or ANTHROPIC_API_KEY. Without it → 503 {fallback:true} and the page uses its built-in suggestions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// AI provider: Groq (free tier) when GROQ_API_KEY is set (optional GROQ_MODEL), otherwise Anthropic (ANTHROPIC_API_KEY, optional AI_MODEL).
const aiOn = () => !!(Deno.env.get("GROQ_API_KEY") || Deno.env.get("ANTHROPIC_API_KEY"));
async function ai(prompt: string, maxTokens: number, temperature = 0.7): Promise<string | null> {
  try {
    const groq = Deno.env.get("GROQ_API_KEY");
    if (groq) {
      // models open to free Groq accounts; tries the next one if a model is missing or busy
      const models = [Deno.env.get("GROQ_MODEL"), "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"].filter(Boolean) as string[];
      for (const model of models) {
        const oss = model.startsWith("openai/gpt-oss");
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST", headers: { Authorization: `Bearer ${groq}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, max_tokens: maxTokens + (oss ? 1500 : 0), temperature, ...(oss ? { reasoning_effort: "low" } : {}), messages: [{ role: "user", content: prompt }] }),
        });
        if (!r.ok) { console.error("groq", model, r.status, (await r.text()).slice(0, 200)); if ([404, 429, 503, 400].includes(r.status)) continue; return null; }
        const j = await r.json(); const t = String(j?.choices?.[0]?.message?.content ?? "").trim();
        if (t) return t;
      }
      return null;
    }
    const key = Deno.env.get("ANTHROPIC_API_KEY"); if (!key) return null;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("AI_MODEL") ?? "claude-haiku-5-5", max_tokens: maxTokens, temperature, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) return null;
    const j = await r.json(); return (j.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").trim() || null;
  } catch (e) { console.error("ai", String(e)); return null; }
}
const PER_IP_DAY = 10, PER_BIZ_DAY = 400;
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");

const PROMPT = (o: { name: string; category: string; city: string; locality: string; picks: string[]; rating: number }) => `Write 3 short Google review drafts that a real, happy customer could post about a local business. The customer will read and edit the one they choose.

Business: ${o.name}${o.category ? ` (${o.category})` : ""}
Area: ${[o.locality, o.city].filter(Boolean).join(", ") || "not given"}
Stars the customer gave: ${o.rating} of 5
What the customer said they liked: ${o.picks.join("; ")}

Rules:
- Mention only the things the customer said they liked. Don't invent dishes, services, staff names, prices or events.
- Each draft sounds like a different real person: vary the opening, length and wording. First person, simple everyday English, warm but not over the top. ${o.rating >= 5 ? "Very positive." : "Positive, a little more measured."}
- Work the liked things in naturally as plain phrases (good for search), e.g. "the cold coffee here is great".
- Location: in exactly ONE or TWO of the three drafts, mention the area once, naturally (e.g. "in ${o.locality || o.city || "the area"}" or "one of my go-to places in ${o.city || "town"}"). Use the locality in one and the city in another if both are given. At least one draft must have no location. Never "near me", never repeat the business name more than once per draft.
- No hashtags, no emojis, no "best in the world" style superlatives, no ALL CAPS, no lists.
- Lengths: one draft 1 sentence, one 2 sentences, one 3 sentences.
Reply with ONLY JSON: {"suggestions":["...","...","..."]}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!aiOn()) return json({ error: "AI is off", fallback: true }, 503);
  let body: { slug?: string; picks?: string[]; rating?: number };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const slug = String(body.slug ?? "").slice(0, 80), rating = Math.min(5, Math.max(4, Number(body.rating) || 5));
  const picks = (Array.isArray(body.picks) ? body.picks : []).map((p) => String(p).replace(/[^\p{L}\p{N} &'\-]/gu, "").trim().slice(0, 40)).filter(Boolean).slice(0, 8);
  if (!slug || !picks.length) return json({ error: "Pick at least one thing you liked." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: info } = await admin.rpc("review_chips", { p_slug: slug });
  const { data: b } = await admin.from("businesses").select("id,name").eq("slug", slug).maybeSingle();
  if (!b || !info) return json({ error: "Business not found" }, 404);
  const { data: open } = await admin.rpc("biz_open", { b: b.id });
  if (!open) return json({ error: "Unavailable", fallback: true }, 403);

  const ipHash = await sha(((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown") + ":" + new Date().toISOString().slice(0, 10));
  const since = new Date(Date.now() - 864e5).toISOString();
  const [{ count: ipCount }, { count: bizCount }] = await Promise.all([
    admin.from("review_polish_usage").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", since),
    admin.from("review_polish_usage").select("id", { count: "exact", head: true }).eq("business_id", b.id).gte("created_at", since),
  ]);
  if ((ipCount ?? 0) >= PER_IP_DAY || (bizCount ?? 0) >= PER_BIZ_DAY) return json({ error: "Limit reached", fallback: true }, 429);
  await admin.from("review_polish_usage").insert({ business_id: b.id, ip_hash: ipHash });

  const reply = await ai(PROMPT({ name: b.name, category: info.category ?? "", city: info.city ?? "", locality: info.locality ?? "", picks, rating }), 700, 1);
  if (!reply) return json({ error: "AI busy", fallback: true }, 502);
  try {
    const j = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
    const list = (j.suggestions ?? []).map((s: unknown) => String(s ?? "").replace(/#\w+/g, "").replace(/\bnear me\b/gi, "").trim().slice(0, 600)).filter((s: string) => s.length > 10).slice(0, 3);
    if (!list.length) throw new Error("empty");
    return json({ suggestions: list.map((text: string, i: number) => ({ label: `Suggestion ${i + 1}`, text })) });
  } catch { return json({ error: "AI reply unreadable", fallback: true }, 502); }
});
