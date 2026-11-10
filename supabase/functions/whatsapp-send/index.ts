// Supabase Edge Function: send WhatsApp template messages for a business, charged per message.
//
// POST /functions/v1/whatsapp-send
// Headers: Authorization: Bearer <business user's access token>
// Body: { business_id, template_id, customer_ids: string[], params: string[], title?, audience? }
//   params fill {{2}}, {{3}}… of the template. {{1}} is always the customer's first name.
//
// Secrets (supabase secrets set …):
//   WA_TOKEN                   permanent access token for the WhatsApp Business Account (Meta)
//   WA_DEFAULT_PHONE_NUMBER_ID the agency's WhatsApp sender number id (used when a business has none)
//   WA_API_VERSION             optional, defaults to v21.0
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_RECIPIENTS = 1000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const waToken = Deno.env.get("WA_TOKEN");
  const defaultPhoneId = Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID");
  const apiVersion = Deno.env.get("WA_API_VERSION") ?? "v21.0";
  if (!waToken) return json({ error: "WhatsApp is not configured yet. Ask Branditude to add the WhatsApp token." }, 503);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 1. Who is calling?
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "Please sign in again." }, 401);
  const userId = userData.user.id;

  let body: { business_id?: string; template_id?: string; customer_ids?: string[]; params?: string[]; title?: string; audience?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const { business_id, template_id } = body;
  const customerIds = Array.from(new Set(body.customer_ids ?? [])).slice(0, MAX_RECIPIENTS);
  const params = (body.params ?? []).map((p) => String(p ?? "").slice(0, 500));
  if (!business_id || !template_id || customerIds.length === 0) return json({ error: "Choose a template and at least one customer." }, 400);

  // 2. Caller must be a member of an active business with WhatsApp switched on
  const { data: member } = await admin.from("business_members").select("role").eq("business_id", business_id).eq("user_id", userId).maybeSingle();
  if (!member) return json({ error: "Not allowed" }, 403);
  const { data: biz } = await admin.from("businesses").select("id,name,status,wa_enabled,wa_phone_number_id").eq("id", business_id).single();
  if (!biz || biz.status !== "active") return json({ error: "Your account isn't active yet." }, 403);
  // One customer at a time: every plan (charged per message). Many customers at once: Pro (bulk messaging).
  if (customerIds.length > 1) {
    const { data: bulkOn } = await admin.rpc("has_module", { b: business_id, m: "bulk_whatsapp" });
    if (!bulkOn) return json({ error: "Bulk messaging is part of the Pro plan. Upgrade to Pro to message many customers at once.", module: "bulk_whatsapp" }, 403);
  }
  if (!biz.wa_enabled) return json({ error: "The WhatsApp add-on is off for your account. Buy a credit pack to switch it on." }, 403);
  const phoneNumberId = biz.wa_phone_number_id || defaultPhoneId;
  if (!phoneNumberId) return json({ error: "No WhatsApp sender number is set up." }, 503);

  const { data: tpl } = await admin.from("wa_templates").select("*").eq("id", template_id).eq("active", true).eq("status", "approved").maybeSingle();
  if (!tpl || (tpl.business_id && tpl.business_id !== business_id)) return json({ error: "Template not available" }, 400);
  const expectedParams = (tpl.params as string[]).length;
  if (params.length < expectedParams || params.slice(0, expectedParams).some((p) => !p.trim()))
    return json({ error: `Fill in all ${expectedParams} message fields.` }, 400);

  const { data: customers } = await admin.from("customers").select("id,name,phone").eq("business_id", business_id).in("id", customerIds);
  const recipients = (customers ?? []).filter((c) => /^\d{11,15}$/.test(c.phone));
  if (recipients.length === 0) return json({ error: "None of the selected customers has a valid number." }, 400);

  // 3. Reserve credits up front (atomic, can't overdraw)
  const cost = recipients.length * tpl.credits_per_message;
  const { data: bc, error: bcErr } = await admin.from("broadcasts").insert({
    business_id, template_id, title: body.title || tpl.title, audience: body.audience || "selected",
    params, recipients: recipients.length, created_by: userId,
  }).select("id").single();
  if (bcErr) return json({ error: "Couldn't start the broadcast." }, 500);
  const { data: reserved } = await admin.rpc("wa_reserve", { p_business: business_id, p_credits: cost, p_ref: bc.id });
  if (!reserved) {
    await admin.from("broadcasts").delete().eq("id", bc.id);
    const { data: wallet } = await admin.from("wa_wallets").select("balance").eq("business_id", business_id).maybeSingle();
    return json({ error: `Not enough credits. This needs ${cost}, you have ${wallet?.balance ?? 0}.`, needed: cost, balance: wallet?.balance ?? 0 }, 402);
  }

  // 4. Send, a few at a time
  let sent = 0, failed = 0;
  const logs: Record<string, unknown>[] = [];
  const sendOne = async (c: { id: string; name: string; phone: string }) => {
    const first = (c.name || "there").split(" ")[0];
    const payload = {
      messaging_product: "whatsapp", to: c.phone, type: "template",
      template: {
        name: tpl.name, language: { code: tpl.language },
        components: [{ type: "body", parameters: [first, ...params.slice(0, expectedParams)].map((text) => ({ type: "text", text })) }],
      },
    };
    try {
      const r = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const out = await r.json();
      if (r.ok && out?.messages?.[0]?.id) {
        sent++; logs.push({ business_id, broadcast_id: bc.id, customer_id: c.id, phone: c.phone, template_name: tpl.name, status: "sent", wa_message_id: out.messages[0].id, credits: tpl.credits_per_message });
      } else {
        failed++; logs.push({ business_id, broadcast_id: bc.id, customer_id: c.id, phone: c.phone, template_name: tpl.name, status: "failed", error: out?.error?.message ?? `HTTP ${r.status}`, credits: 0 });
      }
    } catch (e) {
      failed++; logs.push({ business_id, broadcast_id: bc.id, customer_id: c.id, phone: c.phone, template_name: tpl.name, status: "failed", error: String(e), credits: 0 });
    }
  };
  const BATCH = 10;
  for (let i = 0; i < recipients.length; i += BATCH) await Promise.all(recipients.slice(i, i + BATCH).map(sendOne));

  // 5. Log, refund failures, finish
  for (let i = 0; i < logs.length; i += 500) await admin.from("wa_messages").insert(logs.slice(i, i + 500));
  const refund = failed * tpl.credits_per_message;
  if (refund > 0) await admin.rpc("wa_refund", { p_business: business_id, p_credits: refund, p_ref: bc.id });
  await admin.from("broadcasts").update({ sent, failed, credits_used: cost - refund }).eq("id", bc.id);
  const { data: wallet } = await admin.from("wa_wallets").select("balance").eq("business_id", business_id).maybeSingle();

  return json({ broadcast_id: bc.id, sent, failed, credits_used: cost - refund, balance: wallet?.balance ?? 0 });
});
