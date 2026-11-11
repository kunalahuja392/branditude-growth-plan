// Supabase Edge Function: Meta WhatsApp webhook. Records delivery status (sent / delivered / read / failed) per message id.
// GET  = Meta's verification (hub.verify_token must equal internal_secrets 'wa_webhook_verify').
// POST = status events + incoming messages. If the WA_APP_SECRET secret is set, the X-Hub-Signature-256 header is checked.
// Incoming: "STOP" opts the number out of all business messages ("START" undoes it). A business owner/admin/staff writing from
// their number gets the AI assistant (their numbers and how-to); anyone else gets one short auto-reply a day.
// verify_jwt is off (Meta calls it directly).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req: Request) => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const url = new URL(req.url);
  if (req.method === "GET") {
    const { data: s } = await admin.from("internal_secrets").select("value").eq("key", "wa_webhook_verify").single();
    if (url.searchParams.get("hub.mode") === "subscribe" && s && url.searchParams.get("hub.verify_token") === s.value)
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });
  const raw = await req.text();
  const secret = Deno.env.get("WA_APP_SECRET");
  if (secret) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = "sha256=" + hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
    if (sig !== (req.headers.get("x-hub-signature-256") ?? "")) return new Response("Bad signature", { status: 401 });
  }
  let body: any; try { body = JSON.parse(raw); } catch { return new Response("ok"); }
  const rows: Record<string, unknown>[] = [];
  for (const e of body?.entry ?? []) for (const c of e.changes ?? []) for (const s of c.value?.statuses ?? []) {
    if (!s?.id) continue;
    const er = s.errors?.[0];
    rows.push({ wa_message_id: String(s.id), status: String(s.status), recipient: s.recipient_id ?? null,
      error_code: er?.code ?? null, error: er ? (er.error_data?.details || er.message || er.title || null) : null, updated_at: new Date().toISOString() });
  }
  // keep the "best" status: failed always wins, otherwise later events (delivered, read) overwrite sent
  for (const r of rows) {
    const { data: cur } = await admin.from("wa_delivery").select("status").eq("wa_message_id", r.wa_message_id).maybeSingle();
    const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 9 };
    if (cur && (rank[cur.status] ?? 0) >= (rank[r.status as string] ?? 0)) continue;
    await admin.from("wa_delivery").upsert(r);
  }
  // ---- incoming messages (answered in the background so Meta gets its 200 straight away) ----
  const work = (async () => {
  const token = Deno.env.get("WA_TOKEN"), v = Deno.env.get("WA_API_VERSION") ?? "v21.0";
  const reply = async (phoneId: string, to: string, text: string) => {
    if (!token) return;
    await fetch(`https://graph.facebook.com/${v}/${phoneId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4000) } }) }).catch(() => {});
  };
  for (const e of body?.entry ?? []) for (const c of e.changes ?? []) for (const m of c.value?.messages ?? []) {
    const from = String(m.from ?? "").replace(/\D/g, ""), phoneId = String(c.value?.metadata?.phone_number_id ?? Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID") ?? "");
    if (!from || !phoneId) continue;
    const text = String(m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? "").trim();
    if (/^(stop|unsubscribe|band karo|बंद)\b/i.test(text)) {
      await admin.from("wa_optout").upsert({ phone: from });
      await reply(phoneId, from, "Done. You won't get offers or updates from businesses on this number any more. Reply START if you change your mind.");
      continue;
    }
    if (/^start\b/i.test(text)) { await admin.from("wa_optout").delete().eq("phone", from); await reply(phoneId, from, "Welcome back! You'll get updates from the businesses you visit again."); continue; }
    const { data: who } = await admin.rpc("wa_member_by_phone", { p_phone: from });
    const mem = Array.isArray(who) ? who[0] : who;
    if (!mem) {
      const since = new Date(Date.now() - 864e5).toISOString();
      const { count } = await admin.from("wa_chat").select("id", { count: "exact", head: true }).eq("phone", from).gte("created_at", since);
      if (!count) { await reply(phoneId, from, "Hi! This number sends updates on behalf of businesses that use Branditude. For anything about a visit, please contact the business directly. Reply STOP to stop these messages."); await admin.from("wa_chat").insert({ phone: from, role: "assistant", content: "auto-reply" }); }
      continue;
    }
    if (!text) { await reply(phoneId, from, "I can read text messages only. Ask me anything about your business, like \"sales in the last 5 days\"."); continue; }
    await admin.from("wa_chat").insert({ phone: from, role: "user", content: text.slice(0, 1500) });
    const { data: hist } = await admin.from("wa_chat").select("role,content").eq("phone", from).gte("created_at", new Date(Date.now() - 864e5).toISOString()).neq("content", "auto-reply").order("created_at", { ascending: false }).limit(10);
    const { data: sec } = await admin.from("internal_secrets").select("value").eq("key", "cron_secret").single();
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/assistant`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "x-internal-secret": sec?.value ?? "" },
      body: JSON.stringify({ business_id: mem.business_id, user_id: mem.user_id, channel: "whatsapp", messages: (hist ?? []).reverse() }) });
    const j = await r.json().catch(() => ({}));
    const answer = j.reply ? `${j.reply}\n\n— Branditude assistant for ${mem.business_name}` : (j.error || "Sorry, I couldn't answer that right now. Try again in a minute.");
    if (j.reply) await admin.from("wa_chat").insert({ phone: from, role: "assistant", content: String(j.reply).slice(0, 4000) });
    await reply(phoneId, from, answer);
  }
  })().catch((e) => console.error("inbox", String(e)));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime; if (rt?.waitUntil) rt.waitUntil(work); else await work;
  return new Response("ok");
});
