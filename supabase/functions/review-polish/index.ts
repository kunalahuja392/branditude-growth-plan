// Supabase Edge Function: tidy a customer's OWN review before they post it on Google.
// Public (called from the feedback page with no login), so verify_jwt is off and we validate + rate-limit here.
//
// POST /functions/v1/review-polish   Body: { slug, text }
// Returns { short, detailed } — both keep the customer's meaning and words. No keywords, no new claims.
// The page always also offers the customer's original text, and the customer chooses.
// Secret: GROQ_API_KEY (free) or ANTHROPIC_API_KEY. Without it → 503 {fallback:true} and the page tidies locally.

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
const PER_IP_DAY = 8, PER_BIZ_DAY = 300;

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const PROMPT = (text: string) => `A customer wrote this review of a local business in their own words:
"""${text}"""

Make two lightly edited versions of THEIR review:
1. "short": 1–2 sentences.
2. "detailed": a fuller version of what they said, at most a little longer than the original.

Strict rules:
- Fix spelling, grammar and punctuation only. Keep their meaning, their opinions and their voice (first person).
- Use ONLY things the customer actually said. Do not add any dish, service, staff name, price, place, city, comparison or claim they didn't mention.
- Do not add keywords, SEO phrases, superlatives ("best in town") or hashtags. Do not make it more positive or negative than they wrote it.
- Keep their language: if they wrote in Hinglish or Hindi, keep it.
Reply with ONLY JSON: {"short":"...","detailed":"..."}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!aiOn()) return json({ error: "AI is off", fallback: true }, 503);

  let body: { slug?: string; text?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const slug = String(body.slug ?? "").slice(0, 80), text = String(body.text ?? "").trim();
  if (!slug || text.length < 8) return json({ error: "Write a few words first." }, 400);
  if (text.length > 1500) return json({ error: "That's a bit long. Keep it under 1500 characters." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: b } = await admin.from("businesses").select("id").eq("slug", slug).maybeSingle();
  if (!b) return json({ error: "Business not found" }, 404);
  const { data: open } = await admin.rpc("biz_open", { b: b.id });
  if (!open) return json({ error: "Unavailable", fallback: true }, 403);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipHash = await sha(ip + ":" + new Date().toISOString().slice(0, 10));
  const since = new Date(Date.now() - 864e5).toISOString();
  const [{ count: ipCount }, { count: bizCount }] = await Promise.all([
    admin.from("review_polish_usage").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", since),
    admin.from("review_polish_usage").select("id", { count: "exact", head: true }).eq("business_id", b.id).gte("created_at", since),
  ]);
  if ((ipCount ?? 0) >= PER_IP_DAY || (bizCount ?? 0) >= PER_BIZ_DAY) return json({ error: "Limit reached", fallback: true }, 429);
  await admin.from("review_polish_usage").insert({ business_id: b.id, ip_hash: ipHash });

  const reply = await ai(PROMPT(text), 700, 0.3);
  if (!reply) return json({ error: "AI busy", fallback: true }, 502);
  try {
    const j = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
    const clean = (s: unknown) => String(s ?? "").replace(/#\w+/g, "").trim().slice(0, 1800);
    const short = clean(j.short), detailed = clean(j.detailed);
    if (!short && !detailed) throw new Error("empty");
    return json({ short, detailed });
  } catch { return json({ error: "AI reply unreadable", fallback: true }, 502); }
});
