// Supabase Edge Function: Branditude team sends a business's WhatsApp template to Meta for approval, and checks its status.
// POST { action:"submit"|"status"|"test"|"register", template_id, to? }   Authorization: Bearer <super_admin/team token>
// Secrets: WA_TOKEN, WA_WABA_ID (WhatsApp Business Account id), optional WA_API_VERSION.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = Deno.env.get("WA_TOKEN"), waba = Deno.env.get("WA_WABA_ID"), v = Deno.env.get("WA_API_VERSION") ?? "v21.0";
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
  if (!["super_admin", "team"].includes(prof?.role ?? "")) return json({ error: "Not allowed" }, 403);
  if (!token || !waba) return json({ error: "Add the WA_TOKEN and WA_WABA_ID secrets in Supabase first. Until then, create the template in Meta WhatsApp Manager and mark it approved here.", setup: true }, 503);
  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  // Admin: register the sender number with the Cloud API. The server picks the 6-digit two-step PIN and keeps it in internal_secrets.
  if (body.action === "register") {
    const phoneId = Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID");
    if (!phoneId) return json({ error: "Add the WA_DEFAULT_PHONE_NUMBER_ID secret first." }, 503);
    const key = `wa_pin_${phoneId}`;
    let { data: row } = await admin.from("internal_secrets").select("value").eq("key", key).maybeSingle();
    if (!row) { const pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0"); await admin.from("internal_secrets").insert({ key, value: pin }); row = { value: pin }; }
    const r = await fetch(`https://graph.facebook.com/${v}/${phoneId}/register`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin: row.value }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.error_data?.details || j?.error?.message || "Meta refused it", code: j?.error?.code }, 502);
    return json({ ok: true, registered: true, pin_saved_as: key });
  }
  const { data: t } = await admin.from("wa_templates").select("*").eq("id", body.template_id ?? "").maybeSingle();
  if (!t) return json({ error: "Template not found" }, 404);

  if (body.action === "submit") {
    const n = (t.body_preview.match(/\{\{\d+\}\}/g) ?? []).length;
    const sample = ["Priya", ...(t.sample?.length ? t.sample : t.params.map((p: string) => p))].slice(0, n);
    const r = await fetch(`https://graph.facebook.com/${v}/${waba}/message_templates`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: t.name, language: t.language, category: t.category.toUpperCase(),
        components: [{ type: "BODY", text: t.body_preview, ...(n ? { example: { body_text: [sample] } } : {}) }] }),
    });
    const j = await r.json();
    if (!r.ok) { await admin.from("wa_templates").update({ status: "rejected", reject_reason: j?.error?.error_user_msg || j?.error?.message || "Meta refused it" }).eq("id", t.id); return json({ error: j?.error?.error_user_msg || j?.error?.message || "Meta refused the template" }, 400); }
    const st = String(j.status || "PENDING").toUpperCase();
    await admin.from("wa_templates").update({ meta_id: j.id, status: st === "APPROVED" ? "approved" : "submitted", active: st === "APPROVED", reject_reason: null }).eq("id", t.id);
    return json({ ok: true, status: st });
  }
  if (body.action === "status") {
    const r = await fetch(`https://graph.facebook.com/${v}/${waba}/message_templates?name=${encodeURIComponent(t.name)}&fields=name,status,rejected_reason`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message || "Couldn't reach Meta" }, 502);
    const m = (j.data ?? []).find((x: { name: string }) => x.name === t.name);
    if (!m) return json({ status: "not found at Meta" });
    const st = String(m.status).toUpperCase();
    const upd = st === "APPROVED" ? { status: "approved", active: true, reject_reason: null } : st === "REJECTED" ? { status: "rejected", active: false, reject_reason: m.rejected_reason || "Rejected by Meta" } : { status: "submitted" };
    await admin.from("wa_templates").update(upd).eq("id", t.id);
    return json({ ok: true, status: st });
  }
  // Admin test: send this approved template (with its sample values) to one number. Branditude's own sender, no business credits used.
  if (body.action === "test") {
    const phoneId = Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID");
    let to = String(body.to ?? "").replace(/\D/g, ""); if (to.length === 10) to = "91" + to;
    if (!phoneId) return json({ error: "Add the WA_DEFAULT_PHONE_NUMBER_ID secret first." }, 503);
    if (to.length < 11 || to.length > 15) return json({ error: "Enter a valid mobile number" }, 400);
    const n = (t.body_preview.match(/\{\{\d+\}\}/g) ?? []).length;
    const vals = ["Kunal", ...(t.sample?.length ? t.sample : t.params)].slice(0, n).map((x: string) => ({ type: "text", text: String(x) }));
    const r = await fetch(`https://graph.facebook.com/${v}/${phoneId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: t.name, language: { code: t.language }, components: n ? [{ type: "body", parameters: vals }] : [] } }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.error_data?.details || j?.error?.message || "Meta refused it", code: j?.error?.code }, 502);
    return json({ ok: true, to, message_id: j?.messages?.[0]?.id, status: j?.messages?.[0]?.message_status ?? "accepted" });
  }
  return json({ error: "Invalid request" }, 400);
});
