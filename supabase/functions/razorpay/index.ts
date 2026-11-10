// Supabase Edge Function: Razorpay online payments for Branditude payments (plans, add-ons, credits, services).
// verify_jwt is off because Razorpay's webhook calls it; user calls are checked here.
//
// Signed-in business user (Authorization: Bearer <token>):
//   { action:"order",  payment_id }  → { key_id, order_id, amount, currency, name, description, prefill }
//   { action:"verify", payment_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } → { ok }
// Razorpay webhook (events payment.captured / order.paid), header X-Razorpay-Signature.
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET (webhook only).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function hmacHex(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const keyId = Deno.env.get("RAZORPAY_KEY_ID"), keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const raw = await req.text();

  // 1. Webhook from Razorpay
  const whSig = req.headers.get("x-razorpay-signature");
  if (whSig && !req.headers.get("authorization")?.startsWith("Bearer ey")) {
    const whSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
    if (!whSecret || !same(await hmacHex(whSecret, raw), whSig)) return json({ error: "Bad signature" }, 401);
    const ev = JSON.parse(raw);
    if (!["payment.captured", "order.paid"].includes(ev.event)) return json({ ok: true, ignored: ev.event });
    const p = ev.payload?.payment?.entity; const o = ev.payload?.order?.entity;
    const orderId = p?.order_id ?? o?.id, payId = p?.id, paise = p?.amount ?? o?.amount_paid;
    const bgp = p?.notes?.payment_id ?? o?.notes?.payment_id;
    if (!orderId || !payId || !bgp) return json({ ok: true, skipped: "no notes" });
    const { error } = await admin.rpc("razorpay_paid", { p_payment: bgp, p_order: orderId, p_rzp_payment: payId, p_paise: paise });
    if (error && !/not pending/.test(error.message)) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // 2. Signed-in user
  if (!keyId || !keySecret) return json({ error: "Online payment isn't switched on yet. Please pay by UPI.", setup: true }, 503);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  let body: Record<string, string>;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid request" }, 400); }
  const { data: pay } = await admin.from("payments").select("*, businesses(name,email,phone)").eq("id", body.payment_id ?? "").maybeSingle();
  if (!pay) return json({ error: "Payment not found" }, 404);
  const { data: m } = await admin.from("business_members").select("role").eq("business_id", pay.business_id).eq("user_id", u.user.id).maybeSingle();
  if (!m) return json({ error: "Not allowed" }, 403);

  if (body.action === "order") {
    if (pay.status !== "pending") return json({ error: "This payment is already " + pay.status + "." }, 400);
    const paise = Math.round(Number(pay.total) * 100);
    if (paise < 100) return json({ error: "Amount too small for online payment." }, 400);
    let orderId = pay.meta?.rzp_order as string | undefined;
    if (!orderId || pay.meta?.rzp_paise !== paise) {
      const r = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST", headers: { Authorization: "Basic " + btoa(`${keyId}:${keySecret}`), "Content-Type": "application/json" },
        body: JSON.stringify({ amount: paise, currency: "INR", receipt: "BGP-" + pay.id.slice(0, 8).toUpperCase(), notes: { payment_id: pay.id, business_id: pay.business_id } }),
      });
      const o = await r.json();
      if (!r.ok) return json({ error: o?.error?.description || "Couldn't start the payment. Try again." }, 502);
      orderId = o.id;
      await admin.from("payments").update({ meta: { ...pay.meta, rzp_order: orderId, rzp_paise: paise } }).eq("id", pay.id);
    }
    const b = pay.businesses ?? {};
    return json({ key_id: keyId, order_id: orderId, amount: paise, currency: "INR", name: "Branditude", description: pay.description,
      prefill: { name: b.name ?? "", email: b.email ?? u.user.email ?? "", contact: b.phone ? "+" + b.phone : "" } });
  }

  if (body.action === "verify") {
    const ok = same(await hmacHex(keySecret, `${body.razorpay_order_id}|${body.razorpay_payment_id}`), String(body.razorpay_signature ?? ""));
    if (!ok) return json({ error: "We couldn't verify this payment. If money was taken, it will be confirmed automatically or refunded." }, 400);
    const { data, error } = await admin.rpc("razorpay_paid", { p_payment: pay.id, p_order: body.razorpay_order_id, p_rzp_payment: body.razorpay_payment_id, p_paise: Math.round(Number(pay.total) * 100) });
    if (error) return json({ error: error.message }, 400);
    return json(data);
  }
  return json({ error: "Invalid request" }, 400);
});
