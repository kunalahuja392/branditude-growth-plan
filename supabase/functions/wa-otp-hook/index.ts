// Supabase Auth "Send SMS" hook: delivers login codes on WhatsApp (authentication template "login_code") instead of SMS.
// Supabase calls it for phone sign-in and phone change. verify_jwt is off; the request is checked with the hook secret.
// Secrets: SEND_SMS_HOOK_SECRETS ("v1,whsec_…" from Auth → Hooks), WA_TOKEN, WA_DEFAULT_PHONE_NUMBER_ID (optional WA_API_VERSION, WA_OTP_TEMPLATE).

const out = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (code: number, message: string) => out(code, { error: { http_code: code, message } });
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function verify(raw: string, h: Headers): Promise<boolean> {
  const secrets = (Deno.env.get("SEND_SMS_HOOK_SECRETS") ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  const id = h.get("webhook-id") ?? "", ts = h.get("webhook-timestamp") ?? "", sigs = (h.get("webhook-signature") ?? "").split(" ").map((s) => s.split(",")[1]).filter(Boolean);
  if (!secrets.length || !id || !ts || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  for (const sec of secrets) {
    const keyRaw = b64(sec.replace(/^v1,/, "").replace(/^whsec_/, ""));
    const key = await crypto.subtle.importKey("raw", keyRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${raw}`)));
    const expect = btoa(String.fromCharCode(...mac));
    if (sigs.includes(expect)) return true;
  }
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return fail(405, "Use POST");
  const raw = await req.text();
  if (!(await verify(raw, req.headers))) return fail(401, "Invalid signature");
  // deno-lint-ignore no-explicit-any
  let p: any;
  try { p = JSON.parse(raw); } catch { return fail(400, "Bad payload"); }
  // a phone change sends the code to the NEW number (new_phone / phone_change); sign-in uses phone
  const u = p.user ?? {}, to = String(u.new_phone || u.phone_change || u.phone || p.sms?.phone || "").replace(/\D/g, ""), otp = String(p.sms?.otp ?? "");
  if (to.length < 11 || !otp) { console.error("otp payload", JSON.stringify({ userKeys: Object.keys(u), smsKeys: Object.keys(p.sms ?? {}), phoneLen: String(u.phone ?? "").length })); return fail(400, "Missing phone or code"); }
  const token = Deno.env.get("WA_TOKEN"), phoneId = Deno.env.get("WA_DEFAULT_PHONE_NUMBER_ID"), v = Deno.env.get("WA_API_VERSION") ?? "v21.0";
  if (!token || !phoneId) return fail(500, "WhatsApp is not configured");
  const r = await fetch(`https://graph.facebook.com/${v}/${phoneId}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: Deno.env.get("WA_OTP_TEMPLATE") ?? "login_code", language: { code: "en" },
      components: [{ type: "body", parameters: [{ type: "text", text: otp }] }, { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: otp }] }] } }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); console.error("wa otp", r.status, JSON.stringify(j).slice(0, 300)); return fail(502, "Couldn't send the code on WhatsApp. Check the number has WhatsApp."); }
  return out(200, {});
});
