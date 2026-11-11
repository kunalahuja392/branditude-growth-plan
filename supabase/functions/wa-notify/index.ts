// Supabase Edge Function: instant WhatsApp update to a customer right after their visit is saved.
// POST { business_id, customer_id }   Authorization: Bearer <business user token>
// Picks "visit_update" or "reward_used" (both utility, 1 utility credit) from the latest visit, naming the business.
// Sent only when the business has switched that update on, has WhatsApp on and has utility credits. Never sent twice for one visit.
// Secrets: WA_TOKEN, WA_DEFAULT_PHONE_NUMBER_ID (optional WA_API_VERSION).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const waToken = Deno.env.get("WA_TOKEN"), defaultPhoneId = Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID"), v = Deno.env.get("WA_API_VERSION") ?? "v21.0";
  if (!waToken) return json({ skipped: "WhatsApp not configured" });

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  let body: { business_id?: string; customer_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const { business_id, customer_id } = body;
  if (!business_id || !customer_id) return json({ error: "Invalid request" }, 400);
  const { data: ok } = await admin.rpc("member_has_perm", { b: business_id, u: u.user.id, area: "customers" });
  if (ok !== true) return json({ error: "Not allowed" }, 403);

  const { data: biz } = await admin.from("businesses").select("status,wa_enabled,wa_phone_number_id").eq("id", business_id).single();
  if (biz?.status !== "active" || !biz.wa_enabled) return json({ skipped: "WhatsApp is off" });
  const { data: m } = await admin.rpc("visit_message", { p_business: business_id, p_customer: customer_id });
  if (!m || m.skip) return json({ skipped: m?.skip ?? "Nothing to send" });
  const { data: rule } = await admin.from("auto_msgs").select("enabled").eq("business_id", business_id).eq("kind", m.kind).maybeSingle();
  if (!rule?.enabled) return json({ skipped: "Update is switched off" });
  if (!/^\d{11,15}$/.test(m.phone || "")) return json({ skipped: "No valid mobile number" });
  if ((await admin.from("wa_optout").select("phone").eq("phone", m.phone).maybeSingle()).data) return json({ skipped: "Customer replied STOP" });
  const { data: dup } = await admin.from("auto_msg_log").select("id").eq("business_id", business_id).eq("kind", m.kind).eq("ref", m.visit_id).limit(1);
  if (dup?.length) return json({ skipped: "Already sent" });
  const { data: tpl } = await admin.from("wa_templates").select("*").is("business_id", null).eq("name", m.template).eq("status", "approved").eq("active", true).maybeSingle();
  if (!tpl) return json({ skipped: "Message is waiting for WhatsApp approval" });

  const cost = tpl.credits_per_message, ref = `visit:${m.visit_id}`;
  const { data: reserved } = await admin.rpc("wa_reserve", { p_business: business_id, p_credits: cost, p_ref: ref, p_kind: "utility" });
  if (!reserved) { await admin.from("auto_msgs").update({ last_run_at: new Date().toISOString(), last_note: "Skipped: no utility credits left." }).eq("business_id", business_id).eq("kind", m.kind); return json({ skipped: "No utility credits left" }); }

  const first = String(m.name || "there").split(" ")[0];
  let status = "failed", err: string | null = null, wamid: string | null = null;
  try {
    const r = await fetch(`https://graph.facebook.com/${v}/${biz.wa_phone_number_id || defaultPhoneId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: m.phone, type: "template",
        template: { name: tpl.name, language: { code: tpl.language }, components: [{ type: "body", parameters: [first, ...m.params].map((t: string) => ({ type: "text", text: String(t).slice(0, 500) })) }] } }),
    });
    const j = await r.json();
    if (r.ok && j?.messages?.[0]?.id) { status = "sent"; wamid = j.messages[0].id; } else err = j?.error?.error_data?.details || j?.error?.message || `HTTP ${r.status}`;
  } catch (e) { err = String(e); }
  await admin.from("auto_msg_log").insert({ business_id, kind: m.kind, customer_id, ref: m.visit_id, n: 1, status, credits: status === "sent" ? cost : 0, error: err, wa_message_id: wamid });
  if (status !== "sent") await admin.rpc("wa_refund", { p_business: business_id, p_credits: cost, p_ref: ref, p_kind: "utility" });
  await admin.from("auto_msgs").update({ last_run_at: new Date().toISOString(), last_note: status === "sent" ? "Last update sent." : `Last update failed: ${err}` }).eq("business_id", business_id).eq("kind", m.kind);
  return status === "sent" ? json({ ok: true, kind: m.kind }) : json({ error: err }, 502);
});
