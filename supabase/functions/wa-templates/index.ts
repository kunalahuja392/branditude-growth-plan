// Supabase Edge Function: Branditude team sends a business's WhatsApp template to Meta for approval, and checks its status.
// POST { action:"submit"|"status"|"test"|"register"|"spend"|"profile"|"profile_get"|"auth_template"|"auth_template_status", template_id?, to?, since?, about?… }   Authorization: Bearer <super_admin/team token>
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
  // Admin: create the WhatsApp authentication template used for login codes (copy-code button, 10-minute expiry)
  if (body.action === "auth_template") {
    const r = await fetch(`https://graph.facebook.com/${v}/${waba}/message_templates`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "login_code", language: "en", category: "AUTHENTICATION", components: [
        { type: "BODY", add_security_recommendation: true }, { type: "FOOTER", code_expiration_minutes: 10 },
        { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] }] }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.error_user_msg || j?.error?.message || "Meta refused it", code: j?.error?.code }, 400);
    return json({ ok: true, id: j.id, status: j.status });
  }
  if (body.action === "auth_template_status") {
    const r = await fetch(`https://graph.facebook.com/${v}/${waba}/message_templates?name=login_code&fields=name,status,rejected_reason,category`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json(); return r.ok ? json({ ok: true, templates: j.data ?? [] }) : json({ error: j?.error?.message }, 502);
  }
  // Admin: what Meta actually charged (pricing analytics), by category, since a date
  if (body.action === "spend") {
    const from = Math.floor(new Date(String(body.since || "2026-11-01") + "T00:00:00+05:30").getTime() / 1000), to = Math.floor(Date.now() / 1000);
    const f = `pricing_analytics.start(${from}).end(${to}).granularity(DAILY).dimensions(["PRICING_CATEGORY"])`;
    const r = await fetch(`https://graph.facebook.com/${v}/${waba}?fields=${encodeURIComponent(f)}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message || "Couldn't read Meta spend", code: j?.error?.code }, 502);
    const by: Record<string, { cost: number; volume: number }> = {};
    for (const blk of j?.pricing_analytics?.data ?? []) for (const d of blk.data_points ?? []) {
      const k = String(d.pricing_category || "OTHER").toLowerCase(); by[k] = by[k] || { cost: 0, volume: 0 };
      by[k].cost += Number(d.cost || 0); by[k].volume += Number(d.volume || 0);
    }
    return json({ ok: true, since: body.since || "2026-11-01", by, total: Object.values(by).reduce((a, x) => a + x.cost, 0) });
  }
  // Admin: set the sender's WhatsApp profile (about, description, address, email, websites, category, photo)
  if (body.action === "profile" || body.action === "profile_get") {
    const phoneId = Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID");
    if (!phoneId) return json({ error: "Add the WA_DEFAULT_PHONE_NUMBER_ID secret first." }, 503);
    if (body.action === "profile") {
      const p = body as unknown as Record<string, unknown>;
      const payload: Record<string, unknown> = { messaging_product: "whatsapp" };
      for (const k of ["about", "address", "description", "email", "vertical"]) if (typeof p[k] === "string") payload[k] = p[k];
      if (Array.isArray(p.websites)) payload.websites = (p.websites as string[]).slice(0, 2);
      if (typeof p.photo_url === "string" && (p.photo_url as string).startsWith("https://scale.branditudeglobal.com/")) {
        const img = await fetch(p.photo_url as string); if (!img.ok) return json({ error: "Couldn't load the photo" }, 400);
        const bytes = new Uint8Array(await img.arrayBuffer()), type = img.headers.get("content-type")?.split(";")[0] || "image/png";
        const appId = Deno.env.get("WA_APP_ID") ?? "1585387223625489";
        const up = await fetch(`https://graph.facebook.com/${v}/${appId}/uploads?file_name=profile.${type.endsWith("png") ? "png" : "jpg"}&file_length=${bytes.length}&file_type=${encodeURIComponent(type)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        const uj = await up.json(); if (!up.ok || !uj.id) return json({ error: uj?.error?.message || "Couldn't start the photo upload" }, 502);
        const put = await fetch(`https://graph.facebook.com/${v}/${uj.id}`, { method: "POST", headers: { Authorization: `OAuth ${token}`, file_offset: "0" }, body: bytes });
        const pj = await put.json(); if (!put.ok || !pj.h) return json({ error: pj?.error?.message || "Couldn't upload the photo" }, 502);
        payload.profile_picture_handle = pj.h;
      }
      const r = await fetch(`https://graph.facebook.com/${v}/${phoneId}/whatsapp_business_profile`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json(); if (!r.ok) return json({ error: j?.error?.error_data?.details || j?.error?.message || "Meta refused the profile" }, 502);
    }
    const g = await fetch(`https://graph.facebook.com/${v}/${phoneId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`, { headers: { Authorization: `Bearer ${token}` } });
    const gj = await g.json(); if (!g.ok) return json({ error: gj?.error?.message || "Couldn't read the profile" }, 502);
    return json({ ok: true, profile: gj?.data?.[0] ?? gj });
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
