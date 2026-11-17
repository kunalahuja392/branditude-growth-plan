// Supabase Edge Function: a gaming club sends one WhatsApp message now — the bill after billing, a payment
// follow-up, or a "time is ending" reminder from the popup.
// POST { business_id, kind: "bill" | "due" | "reminder" | "booking", ref }   Authorization: Bearer <business user token>
// Needs the "WhatsApp bills, follow-ups & reports" add-on; 1 utility credit per message. When it can't send
// (no add-on, no credits, template not approved) it answers { skipped } and the app offers a free wa.me link
// from the club's own phone instead.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendGamingWA, type Kind } from "../_shared/gc-wa.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json({ error: "Please sign in again." }, 401);
  let body: { business_id?: string; kind?: Kind; ref?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const { business_id, kind, ref } = body;
  if (!business_id || !ref || !["bill", "due", "reminder", "booking"].includes(kind ?? "")) return json({ error: "Invalid request" }, 400);
  const { data: ok } = await admin.rpc("member_has_perm", { b: business_id, u: u.user.id, area: "gaming" });
  if (ok !== true) return json({ error: "Not allowed" }, 403);
  // the bill / session must belong to this club
  const table = kind === "reminder" ? "gc_sessions" : kind === "booking" ? "gc_bookings" : "gc_bills";
  const { data: row } = await admin.from(table).select("id").eq("id", ref).eq("business_id", business_id).maybeSingle();
  if (!row) return json({ error: "Not found" }, 404);
  const r = await sendGamingWA(admin, business_id, kind as Kind, ref, { manual: kind === "due" || kind === "reminder" });
  return json(r, r.error ? 502 : 200);
});
