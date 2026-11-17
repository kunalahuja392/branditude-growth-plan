// Business portal: Team & logins (#team). Owner and admins add people by email and choose what each can do.
import { sb, q } from "./sb.js";
import { $, $$, esc, toast, copy, openModal, closeModal, confirmBox, fmtDate } from "./ui.js";

// Area each page belongs to (shared with business.js for the menu)
export const AREA_OF = {
  dashboard: "customers", customers: "customers", feedback: "customers", offers: "customers", loyalty: "customers", alerts: "customers",
  reviews: "reviews", seo: "reviews", replies: "reviews", whatsapp: "whatsapp", templates: "whatsapp",
  orders: "menu", menu: "menu", staff: "attendance", salary: "attendance", accounts: "accounts",
  plan: "settings", profile: "settings", team: "settings",
  gboard: "gaming", gbookings: "gaming", gbills: "gaming", gstock: "gaming", gmembers: "gaming", gcash: "gaming", greports: "g_reports", gsetup: "settings",
};
export const AREAS = [
  ["customers", "Customers & visits", "Log visits, scan loyalty cards, customers, offers, feedback"],
  ["reviews", "Google reviews & SEO", "Review links, keywords, Google replies"],
  ["whatsapp", "WhatsApp", "Send messages, reminders and templates"],
  ["menu", "QR menu & orders", "Take orders, edit the menu"],
  ["attendance", "Staff & salary", "Attendance, salaries and advances (sees pay)"],
  ["accounts", "Accounts", "Income, expenses, P&L, GST reports"],
  ["settings", "Business settings", "Business profile, plan and billing"],
  ["gaming", "Gaming front desk", "Start sessions, LP splits, snacks, bills and bookings"],
];
// Extra front-desk permissions (only when "Gaming front desk" is ticked)
export const GAMING_PERMS = [
  ["g_sales", "See sales totals", "Today's sales on the live board and sales on the bills page"],
  ["g_reports", "Gaming reports", "Sales per station, busy hours, top snacks"],
  ["g_stock", "Add items & stock", "Add or edit snacks, prices and stock, and snack categories"],
  ["g_discount", "Give discounts", "Discount in ₹ or % on bills"],
];
const PERM_LABEL = Object.fromEntries([...AREAS, ...GAMING_PERMS].map(([k, l]) => [k, l]));
const ROLE = { owner: ["Owner", "acc"], admin: ["Admin", "good"], staff: ["Staff", ""] };

let A, T = null;
const ctx = () => A.ctx();
const joinLink = (email) => new URL(`login.html?join=1&email=${encodeURIComponent(email)}`, location.href).href;
const inviteMsg = (email) => `Hi! I've added you to ${ctx().D.biz.name} on Branditude Growth Plan. Create your login with this email (${email}) here: ${joinLink(email)}`;

const gamingBiz = () => ctx().D.biz?.categories?.slug === "gaming-club";
async function callLogin(body) {
  const { data, error } = await sb.functions.invoke("team-login", { body });
  if (error) { let msg = error.message; try { msg = (await error.context.json()).error || msg; } catch {} throw new Error(msg); }
  if (data?.error) throw new Error(data.error); return data;
}
function loginCard(login, pass) {
  const url = new URL("login.html", location.href).href, msg = `Your login for ${ctx().D.biz.name}:\nOpen ${url}\nLogin ID: ${login}\nPassword: ${pass}`;
  const m = openModal(`<div class="modal-head"><h2>✅ Login ready</h2><button class="btn ghost" data-close>Close</button></div>
    <p>They sign in at <b>${esc(url)}</b> (Business tab) with:</p>
    <div class="card" style="padding:12px 14px"><div>Login ID: <b>${esc(login)}</b></div><div>Password: <b>${esc(pass)}</b></div></div>
    <p class="muted small">Share it with them now. You can set a new password any time from Team & logins.</p>
    <div class="modal-foot"><button class="btn" id="lc-copy">Copy</button><a class="btn primary wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">Send on WhatsApp</a></div>`);
  m.querySelector("#lc-copy").onclick = () => copy(msg, "Login details");
}
function pwModal(mem) {
  const m = openModal(`<div class="modal-head"><h2>🔑 New password · ${esc(mem.name || mem.email)}</h2><button class="btn ghost" data-close>Close</button></div>
    <p class="muted small">Login ID: <b>${esc(mem.email)}</b>. They'll use the new password from their next sign-in.</p>
    <div class="field"><label for="pw-new">New password</label><input id="pw-new" type="text" autocomplete="new-password" placeholder="At least 8 characters"></div><p class="err" id="pw-err"></p>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pw-go">Set password</button></div>`);
  m.querySelector("#pw-go").onclick = async () => { const b = m.querySelector("#pw-go"), pass = m.querySelector("#pw-new").value; b.disabled = true;
    try { if (pass.length < 8) throw new Error("The password needs at least 8 characters"); await callLogin({ action: "password", business_id: ctx().BID, user_id: mem.user_id, password: pass }); loginCard(mem.email, pass); }
    catch (e) { m.querySelector("#pw-err").textContent = e.message; b.disabled = false; } };
}
async function load() { T = await q(sb.rpc("team_list", { p_business: ctx().BID })); }

function draw() {
  const el = $("#team-view"); if (!el) return;
  const me = ctx().D.me?.role, areaChips = (perms, role) => role === "staff"
    ? (perms || []).map((p) => `<span class="tag">${esc(PERM_LABEL[p] || p)}</span>`).join("") : `<span class="tag">Everything</span>`;
  el.innerHTML = A.head("Team & logins", "Give your manager and staff their own login. Admins can do everything. Staff only see what you tick, so a cashier can log visits without seeing your accounts or salaries.",
    `<button class="btn primary" data-t="add">+ Add a person</button>`) + `
  <div class="card"><div class="list">
    ${T.members.map((m) => `<div class="item"><div class="grow"><b>${esc(m.name || m.email || "—")}${m.me ? ' <span class="muted small">(you)</span>' : ""}</b>
      <span class="muted small">${esc(m.email || "")}${m.since ? " · added " + fmtDate(m.since) : ""}</span><div class="chips" style="margin-top:6px">${areaChips(m.perms, m.role)}</div></div>
      <span class="pill ${ROLE[m.role][1]}">${ROLE[m.role][0]}</span>
      ${m.role !== "owner" && !m.me && (m.role === "staff" || me === "owner") ? `<button class="btn sm" data-t="edit" data-id="${m.user_id}">Change</button><button class="btn sm" data-t="pw" data-id="${m.user_id}">🔑 Password</button><button class="btn sm ghost danger" data-t="rm" data-id="${m.user_id}">Remove</button>` : ""}</div>`).join("")}
    ${T.invites.map((i) => `<div class="item"><div class="grow"><b>${esc(i.email)}</b><span class="muted small">Invited ${fmtDate(i.created_at)} · hasn't created a login yet</span><div class="chips" style="margin-top:6px">${areaChips(i.perms, i.role)}</div></div>
      <span class="pill warn">${ROLE[i.role][0]} · invited</span>
      <a class="btn sm wa" href="https://wa.me/?text=${encodeURIComponent(inviteMsg(i.email))}" target="_blank" rel="noopener">Send invite</a>
      <button class="btn sm ghost" data-t="copy" data-id="${esc(i.email)}">Copy link</button><button class="btn sm ghost danger" data-t="rm-inv" data-id="${i.id}">Cancel</button></div>`).join("")}
  </div></div>
  <div class="note" style="margin-top:14px"><b>How they get in:</b> they open the invite link (or the Sign in page → <i>Create your login</i>), enter the same email and choose a password. They land straight in your business with only the access you gave.</div>`;
}

function editor(cur = {}) {
  const isNew = !cur.email, me = ctx().D.me?.role;
  const m = openModal(`<div class="modal-head"><h2>${isNew ? "Add a person" : "Change access"}</h2><button class="btn ghost" data-close>Close</button></div>
    <form id="tm-f">
      ${isNew ? `<div class="field"><label>How will they sign in?</label>
        <label class="check"><input type="radio" name="tm-how" value="pw" checked> <span><b>I'll set a password now</b>: give them a login ID and password, they can start right away</span></label>
        <label class="check"><input type="radio" name="tm-how" value="invite"> <span><b>Send an invite link</b>: they use their own email and choose a password</span></label></div>
      <div id="tm-pw" class="fields" style="margin-top:10px"><div class="field"><label for="tm-name">Name</label><input id="tm-name" placeholder="Ravi"></div>
        <div class="field"><label for="tm-login">Login ID or email</label><input id="tm-login" autocomplete="off" placeholder="ravi" autocapitalize="none"><span class="muted small" id="tm-lhint">A name like ravi becomes the login ID shown after saving.</span></div>
        <div class="field"><label for="tm-pass">Password</label><input id="tm-pass" type="text" autocomplete="new-password" placeholder="At least 8 characters"></div></div>` : ""}
      <div class="field" id="tm-emailf" ${isNew ? "hidden" : ""}><label for="tm-email">Their email</label><input id="tm-email" type="email" value="${esc(cur.email || "")}" ${isNew ? "" : "readonly"} placeholder="name@gmail.com"></div>
      <div class="field" style="margin-top:12px"><label>Role</label>
        <label class="check"><input type="radio" name="tm-role" value="staff" ${cur.role !== "admin" ? "checked" : ""}> <span><b>Staff</b>: only the things you tick below</span></label>
        <label class="check"><input type="radio" name="tm-role" value="admin" ${cur.role === "admin" ? "checked" : ""} ${me === "owner" ? "" : "disabled"}> <span><b>Admin</b>: everything, including accounts, salaries and the team${me === "owner" ? "" : " (only the owner can add admins)"}</span></label></div>
      <fieldset id="tm-areas" style="border:0;padding:0;margin:14px 0 0"><legend class="small" style="font-weight:600;margin-bottom:6px">What can they do?</legend>
        ${AREAS.map(([k, l, d]) => `<label class="check" style="align-items:flex-start"><input type="checkbox" value="${k}" ${(cur.perms || (gamingBiz() ? ["gaming"] : ["customers"])).includes(k) ? "checked" : ""}> <span><b>${esc(l)}</b><br><span class="muted small">${esc(d)}</span></span></label>
          ${k === "gaming" ? `<div id="tm-gsub" style="margin:0 0 8px 28px;padding:8px 10px;border-left:3px solid var(--line)">${GAMING_PERMS.map(([gk, gl, gd]) => `<label class="check" style="align-items:flex-start"><input type="checkbox" value="${gk}" ${(cur.perms || []).includes(gk) ? "checked" : ""}> <span><b>${esc(gl)}</b><br><span class="muted small">${esc(gd)}</span></span></label>`).join("")}</div>` : ""}`).join("")}
      </fieldset>
      <p class="err" id="tm-err"></p>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${isNew ? "Add" : "Save"}</button></div></form>`);
  const sync = () => { m.querySelector("#tm-areas").hidden = m.querySelector("input[name=tm-role]:checked").value === "admin";
    const g = m.querySelector('#tm-areas input[value="gaming"]'), gs = m.querySelector("#tm-gsub"); if (g && gs) { gs.hidden = !g.checked; if (!g.checked) $$("input", gs).forEach((x) => (x.checked = false)); }
    const how = m.querySelector("input[name=tm-how]:checked")?.value; if (how) { m.querySelector("#tm-pw").hidden = how !== "pw"; m.querySelector("#tm-emailf").hidden = how === "pw"; } };
  $$("input[name=tm-role], input[name=tm-how], #tm-areas input", m).forEach((r) => (r.onchange = sync)); sync();
  m.querySelector("#tm-f").onsubmit = async (e) => {
    e.preventDefault(); const btn = m.querySelector("button.primary"); btn.disabled = true;
    const email = m.querySelector("#tm-email").value.trim().toLowerCase(), role = m.querySelector("input[name=tm-role]:checked").value;
    const perms = $$("#tm-areas input:checked", m).map((i) => i.value);
    try {
      if (isNew && m.querySelector("input[name=tm-how]:checked").value === "pw") {
        const login = m.querySelector("#tm-login").value.trim(), pass = m.querySelector("#tm-pass").value;
        if (!login) throw new Error("Enter a login ID or email"); if (pass.length < 8) throw new Error("The password needs at least 8 characters");
        if (role === "staff" && !perms.some((x) => !x.startsWith("g_"))) throw new Error("Choose at least one thing this person can do");
        const r = await callLogin({ action: "create", business_id: ctx().BID, login, password: pass, name: m.querySelector("#tm-name").value.trim(), role, perms });
        await load(); draw(); loginCard(r.login, pass); return;
      }
      if (!email) throw new Error("Enter their email");
      const r = await q(sb.rpc("team_save", { p_business: ctx().BID, p_email: email, p_role: role, p_perms: perms }));
      await load(); draw();
      if (r.status === "invited") {
        openModal(`<div class="modal-head"><h2>Invite ready</h2><button class="btn ghost" data-close>Close</button></div>
          <p><b>${esc(email)}</b> doesn't have a login yet. Send them this link to create one. They'll get exactly the access you chose.</p>
          <div class="note" style="margin-top:10px;word-break:break-all">${esc(joinLink(email))}</div>
          <div class="modal-foot"><button class="btn" data-t="copy" data-id="${esc(email)}">Copy link</button><a class="btn primary wa" href="https://wa.me/?text=${encodeURIComponent(inviteMsg(email))}" target="_blank" rel="noopener">Send on WhatsApp</a></div>`);
      } else { closeModal(); toast(isNew ? "Added. They can sign in now." : "Access updated"); }
    } catch (err) { m.querySelector("#tm-err").textContent = err.message; btn.disabled = false; }
  };
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-t]"); if (!el || !A || !A.isRoute("team")) return;
  const a = el.dataset.t, id = el.dataset.id;
  try {
    if (a === "add") editor();
    if (a === "edit") { const m = T.members.find((x) => x.user_id === id); editor(m); }
    if (a === "pw") pwModal(T.members.find((x) => x.user_id === id));
    if (a === "copy") copy(joinLink(id), "Invite link");
    if (a === "rm") { const m = T.members.find((x) => x.user_id === id);
      if (!(await confirmBox(`Remove ${m.email}?`, "They won't be able to open your business any more.", "Remove", { danger: true }))) return;
      await q(sb.rpc("team_remove", { p_business: ctx().BID, p_user: id })); await load(); draw(); toast("Removed"); }
    if (a === "rm-inv") { await q(sb.rpc("team_remove", { p_business: ctx().BID, p_invite: id })); await load(); draw(); }
  } catch (err) { toast(err.message, "error"); }
});

export function registerTeam(api) {
  A = api;
  api.VIEWS.team = () => `<div id="team-view"><div class="loading"><span class="spinner"></span></div></div>`;
  api.after.team = async () => { try { await load(); draw(); } catch (e) { $("#team-view").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; } };
}
