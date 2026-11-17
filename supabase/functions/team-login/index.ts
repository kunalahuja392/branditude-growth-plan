// Supabase Edge Function: the owner (or an admin) creates a staff login with a password, or sets a new password for one.
// POST { action: "create", business_id, login, password, name, role: "staff" | "admin", perms: string[] }
// POST { action: "password", business_id, user_id, password }
// Authorization: Bearer <owner / admin token>
// "login" is an email, or just a name like "ravi" which becomes ravi@<club>.staff. Passwords can only be set on logins
// that belong to this business alone, never on someone's own account elsewhere.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const clean = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: me } = await admin.auth.getUser(jwt);
  if (!me?.user) return json({ error: "Please sign in again." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const bid = String(body.business_id ?? ""), password = String(body.password ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(bid)) return json({ error: "Invalid request" }, 400);
  if (password.length < 8) return json({ error: "The password needs at least 8 characters." }, 400);
  if (password.length > 72) return json({ error: "The password is too long." }, 400);
  const fail = (e: { message?: string } | null) => json({ error: (e?.message ?? "Something went wrong").replace(/^.*?ERROR:\s*/, "") }, 400);

  if (body.action === "password") {
    const uid = String(body.user_id ?? "");
    const chk = await admin.rpc("team_manage_check", { p_business: bid, p_actor: me.user.id, p_target: uid, p_role: null });
    if (chk.error) return fail(chk.error);
    const { data: member } = await admin.from("business_members").select("role").eq("business_id", bid).eq("user_id", uid).maybeSingle();
    if (!member) return json({ error: "This person isn't in your team." }, 404);
    const { data: ok } = await admin.rpc("team_login_resettable", { p_business: bid, p_user: uid });
    if (ok !== true) return json({ error: "This person uses their own Branditude login, so only they can change its password (Forgot password on the sign-in page)." }, 403);
    const r = await admin.auth.admin.updateUserById(uid, { password });
    if (r.error) return fail(r.error);
    return json({ ok: true });
  }

  if (body.action === "create") {
    const role = body.role === "admin" ? "admin" : "staff", perms = Array.isArray(body.perms) ? body.perms.map(String) : [], name = String(body.name ?? "").trim().slice(0, 80);
    const chk = await admin.rpc("team_manage_check", { p_business: bid, p_actor: me.user.id, p_target: null, p_role: role });
    if (chk.error) return fail(chk.error);
    let login = String(body.login ?? "").trim().toLowerCase();
    if (!login) return json({ error: "Enter a login ID or email." }, 400);
    if (!login.includes("@")) {
      const { data: b } = await admin.from("businesses").select("name").eq("id", bid).single();
      const user = clean(login), club = clean(b?.name ?? "") || "club";
      if (!user) return json({ error: "Use letters or numbers for the login ID." }, 400);
      login = `${user}@${club}.staff`;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login)) return json({ error: "Enter a valid login ID or email." }, 400);
    // already a login with this email?
    const { data: existing } = await admin.rpc("auth_user_id_by_email", { p_email: login });
    let uid = existing as string | null;
    if (uid) {
      const { data: ok } = await admin.rpc("team_login_resettable", { p_business: bid, p_user: uid });
      if (ok !== true) return json({ error: "This email already has its own Branditude login. Add them without a password and they sign in with their own." }, 409);
      const r = await admin.auth.admin.updateUserById(uid, { password, email_confirm: true });
      if (r.error) return fail(r.error);
    } else {
      const r = await admin.auth.admin.createUser({ email: login, password, email_confirm: true, user_metadata: { full_name: name } });
      if (r.error || !r.data.user) return fail(r.error);
      uid = r.data.user.id;
    }
    const at = await admin.rpc("team_attach", { p_business: bid, p_actor: me.user.id, p_user: uid, p_role: role, p_perms: perms, p_name: name });
    if (at.error) return fail(at.error);
    return json({ ok: true, login });
  }
  return json({ error: "Unknown action" }, 400);
});
