// Shared by gc-notify and gc-cron: send one gaming WhatsApp message (bill, payment follow-up, time-up reminder, daily report)
// from the Branditude number, charging 1 utility credit (reserved first, refunded if WhatsApp refuses it).
// Needs the "WhatsApp bills, follow-ups & reports" add-on (module wa_billing) and the club's WhatsApp switched on.
// Secrets: WA_TOKEN, WA_DEFAULT_PHONE_NUMBER_ID (optional WA_API_VERSION).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type Kind = "bill" | "due" | "reminder" | "booking" | "report" | "weekly" | "monthly" | "low_stock" | "dues";
export type Result = { ok?: true; skipped?: string; error?: string };
// Each club chooses which messages and reports it wants (Stations & pricing → WhatsApp bills)
const SWITCH: Record<Kind, string> = { bill: "wa_bill", due: "wa_followup", reminder: "wa_time_reminder", booking: "wa_booking",
  report: "wa_daily_report", weekly: "report_weekly", monthly: "report_monthly", low_stock: "report_low_stock", dues: "report_dues" };

export async function sendGamingWA(admin: SupabaseClient, businessId: string, kind: Kind, ref: string, opts: { manual?: boolean } = {}): Promise<Result> {
  const waToken = Deno.env.get("WA_TOKEN"), defaultPhoneId = Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID"), v = Deno.env.get("WA_API_VERSION") ?? "v21.0";
  const skip = async (why: string, phone = ""): Promise<Result> => {
    if (kind === "reminder") await admin.rpc("gc_wa_done", { p_business: businessId, p_kind: kind, p_ref: ref, p_phone: phone, p_status: "skipped", p_error: why, p_credits: 0, p_wamid: null });
    return { skipped: why };
  };
  if (!waToken) return skip("WhatsApp is not set up yet");

  const { data: biz } = await admin.from("businesses").select("status,wa_enabled,wa_phone_number_id").eq("id", businessId).single();
  const { data: open } = await admin.rpc("biz_open", { b: businessId });
  if (!open || biz?.status !== "active") return skip("Plan is not active");
  const { data: addon } = await admin.rpc("has_module", { b: businessId, m: "wa_billing" });
  if (addon !== true) return skip("WhatsApp bills add-on is not on this plan");
  if (!biz.wa_enabled) return skip("WhatsApp is off for this club");
  const { data: cf } = await admin.from("gc_settings").select("*").eq("business_id", businessId).maybeSingle();
  if (cf && cf[SWITCH[kind]] === false && !opts.manual) return skip("This message is switched off in settings");

  const { data: m } = await admin.rpc("gc_wa_payload", { p_business: businessId, p_kind: kind, p_ref: ref });
  if (!m || m.skip) return skip(m?.skip ?? "Nothing to send");
  if (!/^\d{11,15}$/.test(m.phone || "")) return skip("No valid mobile number", m.phone);
  if ((await admin.from("wa_optout").select("phone").eq("phone", m.phone).maybeSingle()).data) return skip("Customer replied STOP", m.phone);
  if (kind !== "due") {   // never twice for the same bill / session / booking / report period
    const { data: dup } = await admin.from("gc_wa_log").select("id").eq("business_id", businessId).eq("kind", kind).eq("ref", ref).eq("status", "sent").limit(1);
    if (dup?.length && !opts.manual) return { skipped: "Already sent" };
  }
  const { data: tpl } = await admin.from("wa_templates").select("*").is("business_id", null).eq("name", m.template).eq("status", "approved").eq("active", true).maybeSingle();
  if (!tpl) return skip("Message is waiting for WhatsApp approval", m.phone);

  const cost = tpl.credits_per_message, cref = `gc:${kind}:${ref}`;
  const { data: reserved } = await admin.rpc("wa_reserve", { p_business: businessId, p_credits: cost, p_ref: cref, p_kind: "utility" });
  if (!reserved) return skip("No utility credits left", m.phone);

  const first = String(m.name || "there").split(" ")[0] || "there";
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
  if (status !== "sent") await admin.rpc("wa_refund", { p_business: businessId, p_credits: cost, p_ref: cref, p_kind: "utility" });
  await admin.rpc("gc_wa_done", { p_business: businessId, p_kind: kind, p_ref: ref, p_phone: m.phone, p_status: status, p_error: err, p_credits: status === "sent" ? cost : 0, p_wamid: wamid });
  return status === "sent" ? { ok: true } : { error: err ?? "WhatsApp refused the message" };
}
