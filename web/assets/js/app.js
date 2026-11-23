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

// Signed in from the Business side, but this login has no business yet
function noBusiness(user) {
  main.innerHTML = `<div class="auth-wrap"><div class="auth"><h2>Finish setting up your business</h2>
    <p>You're signed in as <b>${esc(user.email || user.phone || "")}</b>, but there's no business on this login yet. Choose a plan and add your business details to get your dashboard.</p>
    <div style="display:grid;gap:8px;margin-top:14px"><a class="btn primary" href="/#products" style="justify-content:center">Set up my business</a>
    <button class="btn" id="as-cust" style="justify-content:center">I'm a customer: show my loyalty cards</button>
    <button class="btn ghost sm" id="nb-out">Sign out</button></div>
    <p class="small muted" style="margin-top:12px">Staff of a business? Ask the owner to add this email under Team &amp; logins, then sign in again.</p></div></div>`;
  $("#as-cust").onclick = () => { try { sessionStorage.setItem("bgp_as_customer", "1"); sessionStorage.removeItem("bgp_login_as"); } catch {} location.reload(); };
  $("#nb-out").onclick = signOut;
}
// Created a staff login, but no business has invited this email
function noTeam(user) {
  main.innerHTML = `<div class="auth-wrap"><div class="auth"><h2>No team invite found</h2>
    <p>No business has added <b>${esc(user.email || "")}</b> to its team yet. Ask the owner to add this exact email under <b>Team &amp; logins</b>, then sign in again.</p>
    <div style="display:grid;gap:8px;margin-top:14px"><button class="btn primary" id="nt-retry" style="justify-content:center">I've been added: check again</button>
    <a class="btn" href="/#products" style="justify-content:center">Register my own business instead</a>
    <button class="btn ghost sm" id="nt-out">Sign out</button></div></div></div>`;
  $("#nt-retry").onclick = () => location.reload();
  $("#nt-out").onclick = signOut;
}

(async function boot() {
  if (!configured) return fail("Add your Supabase URL and anon key in assets/js/config.js.");
  const { data: s } = await sb.auth.getSession();
  if (!s?.session) { location.href = "login.html"; return; }
  const user = s.session.user;
  try {
    // Finish a business registration that was started before email confirmation
    const meta = user.user_metadata || {};
    const pending = (() => { try { return JSON.parse(localStorage.getItem("bgp_pending_registration") || "null"); } catch { return null; } })() || meta.pending_registration || null;
    const loginAs = (() => { try { return sessionStorage.getItem("bgp_login_as"); } catch { return null; } })();
    // Team invites for this email turn into access (owner/admin/staff of a business)
    try { await sb.rpc("claim_invites"); } catch {}
    let profile = await q(sb.from("profiles").select("*").eq("id", user.id).single());
    if (pending && profile.role === "customer") {
      try { await q(sb.rpc("register_business", { p: pending })); toast("Your business is registered. Complete payment to activate."); }
      catch (e) { toast(e.message, "error"); }
      try { localStorage.removeItem("bgp_pending_registration"); } catch {}
      if (meta.pending_registration) sb.auth.updateUser({ data: { pending_registration: null } }).catch(() => {});
      profile = await q(sb.from("profiles").select("*").eq("id", user.id).single());
      if (profile.role === "business" && !location.hash) location.hash = "plan";
    }
    const ctx = { user, profile, signOut };
    if (profile.role === "super_admin" || profile.role === "team") (await import("./admin.js")).mount(ctx);
    else if (profile.role === "business") (await import("./business.js")).mount(ctx);
    else { const me = await sb.rpc("agent_me").then((r) => r.data).catch(() => null);
      if (me) (await import("./agent.js")).mount(ctx, me);
      else if (meta.signup_as === "team") noTeam(user);
      else if ((meta.signup_as === "business" || loginAs === "business") && !sessionStorage.getItem("bgp_as_customer")) noBusiness(user);
      else (await import("./customer.js")).mount(ctx); }
  } catch (e) { fail(e.message || String(e)); }
})();
