// Supabase Edge Function: Meta WhatsApp webhook. Records delivery status (sent / delivered / read / failed) per message id.
// GET  = Meta's verification (hub.verify_token must equal internal_secrets 'wa_webhook_verify').
// POST = status events. If the WA_APP_SECRET secret is set, the X-Hub-Signature-256 header is checked.
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
  return new Response("ok");
});
