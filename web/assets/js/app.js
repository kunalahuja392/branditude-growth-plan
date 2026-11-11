// Entry point for signed-in users: picks the portal by role.
import { sb, q, configured, friendly } from "./sb.js";
import { $, esc, openModal, closeModal, toast } from "./ui.js";

const main = $("#main");
const fail = (m) => (main.innerHTML = `<div class="auth-wrap"><div class="auth"><h2>Something went wrong</h2><p>${esc(m)}</p><a class="btn primary" href="login.html">Back to sign in</a></div></div>`);

export async function signOut() { await sb.auth.signOut(); location.href = "login.html"; }

sb.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    const m = openModal(`<div class="modal-head"><h2>Set a new password</h2></div>
      <form id="pw"><div class="field"><label for="pw1">New password (8+ characters)</label><input id="pw1" type="password" minlength="8" required autocomplete="new-password"></div>
      <p class="err" id="pw-err"></p><div class="modal-foot"><button class="btn primary">Save password</button></div></form>`);
    m.querySelector("#pw").onsubmit = async (e) => { e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: m.querySelector("#pw1").value });
      if (error) m.querySelector("#pw-err").textContent = friendly(error); else { closeModal(); toast("Password updated"); } };
  }
  if (event === "SIGNED_OUT") location.href = "login.html";
});

(async function boot() {
  if (!configured) return fail("Add your Supabase URL and anon key in assets/js/config.js.");
  const { data: s } = await sb.auth.getSession();
  if (!s?.session) { location.href = "login.html"; return; }
  const user = s.session.user;
  try {
    // Finish a business registration that was started before email confirmation
    const pending = (() => { try { return JSON.parse(localStorage.getItem("bgp_pending_registration") || "null"); } catch { return null; } })();
    // Team invites for this email turn into access (owner/admin/staff of a business)
    try { await sb.rpc("claim_invites"); } catch {}
    let profile = await q(sb.from("profiles").select("*").eq("id", user.id).single());
    if (pending && profile.role === "customer") {
      try { await q(sb.rpc("register_business", { p: pending })); toast("Your business is registered. Complete payment to activate."); }
      catch (e) { toast(e.message, "error"); }
      try { localStorage.removeItem("bgp_pending_registration"); } catch {}
      profile = await q(sb.from("profiles").select("*").eq("id", user.id).single());
      if (profile.role === "business" && !location.hash) location.hash = "plan";
    }
    const ctx = { user, profile, signOut };
    if (profile.role === "super_admin" || profile.role === "team") (await import("./admin.js")).mount(ctx);
    else if (profile.role === "business") (await import("./business.js")).mount(ctx);
    else { const me = await sb.rpc("agent_me").then((r) => r.data).catch(() => null);
      if (me) (await import("./agent.js")).mount(ctx, me); else (await import("./customer.js")).mount(ctx); }
  } catch (e) { fail(e.message || String(e)); }
})();
