// Supabase Edge Function: runs every 5 minutes (pg_cron job "gc-wa-5min", internal cron secret; verify_jwt off).
// For clubs with the "WhatsApp bills, follow-ups & reports" add-on:
//   * time-up reminder to the customer N minutes before their booked time ends
//   * pending-payment follow-ups (every N days, up to N times, 10 am – 8 pm only)
//   * daily sales report to the owner at the hour they chose
// Each message uses 1 utility credit from the club's WhatsApp wallet; failures are refunded.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { sendGamingWA, type Kind } from "../_shared/gc-wa.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: s } = await admin.from("internal_secrets").select("value").eq("key", "cron_secret").single();
  if (!s || req.headers.get("x-cron-secret") !== s.value) return json({ error: "Not allowed" }, 403);

  const { data: jobs, error } = await admin.rpc("gc_wa_jobs");
  if (error) return json({ error: error.message }, 500);
  const out: Record<string, number> = { sent: 0, skipped: 0, failed: 0 };
  for (const j of (jobs ?? []).slice(0, 300) as { business_id: string; kind: Kind; ref: string }[]) {
    if (j.kind === "reminder") {
      // exact check: only inside the reminder window
      const { data: v } = await admin.rpc("gc_calc", { p_session: j.ref });
      const { data: cf } = await admin.from("gc_settings").select("reminder_minutes").eq("business_id", j.business_id).single();
      if (v?.remaining_ms == null || v.remaining_ms > (cf?.reminder_minutes ?? 15) * 60000) continue;
    }
    const r = await sendGamingWA(admin, j.business_id, j.kind, j.ref);
    out[r.ok ? "sent" : r.error ? "failed" : "skipped"]++;
  }
  return json(out);
});
