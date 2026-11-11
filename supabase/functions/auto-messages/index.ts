// Supabase Edge Function: daily automatic WhatsApp reminders (birthday, loyalty reward, offer ending, win-back).
// Called by the pg_cron job "auto-messages-daily" with the internal cron secret. verify_jwt is off for that reason.
// Each business turns reminders on itself; each message uses credits from its WhatsApp wallet (failed ones refunded).
// Secrets: WA_TOKEN, WA_DEFAULT_PHONE_NUMBER_ID (optional WA_API_VERSION).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const TEMPLATE: Record<string, string> = { birthday: "birthday_wish", loyalty: "loyalty_update", offer_expiry: "festival_offer", win_back: "we_miss_you" };

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: s } = await admin.from("internal_secrets").select("value").eq("key", "cron_secret").single();
  if (!s || req.headers.get("x-cron-secret") !== s.value) return json({ error: "Not allowed" }, 403);
  const waToken = Deno.env.get("WA_TOKEN"), defaultPhoneId = Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID"), apiVersion = Deno.env.get("WA_API_VERSION") ?? "v21.0";
  if (!waToken) return json({ skipped: "WhatsApp not configured" });

  const { data: rules } = await admin.from("auto_msgs").select("*").eq("enabled", true).in("kind", Object.keys(TEMPLATE));
  const { data: tpls } = await admin.from("wa_templates").select("*").is("business_id", null).eq("active", true).eq("status", "approved");
  const out: Record<string, unknown> = {};
  const note = (r: { business_id: string; kind: string }, text: string) =>
    admin.from("auto_msgs").update({ last_run_at: new Date().toISOString(), last_note: text }).eq("business_id", r.business_id).eq("kind", r.kind);

  for (const r of rules ?? []) {
    const key = `${r.business_id}:${r.kind}`;
    const { data: open } = await admin.rpc("biz_open", { b: r.business_id });
    const { data: biz } = await admin.from("businesses").select("status,wa_enabled,wa_phone_number_id").eq("id", r.business_id).single();
    if (!open || biz?.status !== "active") { await note(r, "Skipped: plan not active."); out[key] = "inactive"; continue; }
    if (!biz.wa_enabled) { await note(r, "Skipped: buy WhatsApp credits to switch sending on."); out[key] = "wa off"; continue; }
    const tpl = (tpls ?? []).find((t) => t.name === TEMPLATE[r.kind]);
    if (!tpl) { await note(r, "Skipped: message template not set up yet."); out[key] = "no template"; continue; }
    const { data: due, error } = await admin.rpc("due_auto_msgs", { p_business: r.business_id, p_kind: r.kind });
    if (error) { await note(r, "Error: " + error.message); out[key] = error.message; continue; }
    const { data: optout } = await admin.from("wa_optout").select("phone").limit(50000);
    const stopped = new Set((optout ?? []).map((o: { phone: string }) => o.phone));
    const list = (due ?? []).filter((c: { phone: string }) => /^\d{11,15}$/.test(c.phone) && !stopped.has(c.phone));
    if (!list.length) { await note(r, "Nobody due today."); out[key] = 0; continue; }
    const cost = list.length * tpl.credits_per_message, ref = `auto:${r.kind}:${new Date().toISOString().slice(0, 10)}`;
    const kind = tpl.category === "utility" ? "utility" : "marketing";
    const { data: ok } = await admin.rpc("wa_reserve", { p_business: r.business_id, p_credits: cost, p_ref: ref, p_kind: kind });
    if (!ok) { await note(r, `Skipped: ${list.length} message(s) due but not enough ${kind === "utility" ? "utility" : "promotional"} credits (needs ${cost}).`); out[key] = "no credits"; continue; }
    const phoneId = biz.wa_phone_number_id || defaultPhoneId;
    let sent = 0, failed = 0;
    for (const c of list) {
      const first = (c.name || "there").split(" ")[0];
      let status = "failed", err: string | null = null, wamid: string | null = null;
      try {
        const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneId}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: c.phone, type: "template",
            template: { name: tpl.name, language: { code: tpl.language }, components: [{ type: "body", parameters: [first, ...c.params].map((text: string) => ({ type: "text", text: String(text).slice(0, 500) })) }] } }),
        });
        const j = await res.json();
        if (res.ok && j?.messages?.[0]?.id) { status = "sent"; wamid = j.messages[0].id; } else err = j?.error?.message ?? `HTTP ${res.status}`;
      } catch (e) { err = String(e); }
      if (status === "sent") sent++; else failed++;
      await admin.from("auto_msg_log").insert({ business_id: r.business_id, kind: r.kind, customer_id: c.customer_id, ref: c.ref, n: c.n, status, credits: status === "sent" ? tpl.credits_per_message : 0, error: err, wa_message_id: wamid });
    }
    if (failed) await admin.rpc("wa_refund", { p_business: r.business_id, p_credits: failed * tpl.credits_per_message, p_ref: ref, p_kind: kind });
    await note(r, `Sent ${sent}${failed ? `, ${failed} failed (refunded)` : ""}.`);
    out[key] = { sent, failed };
  }
  return json({ ok: true, out });
});
