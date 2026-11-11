// Business portal: Team & logins (#team). Owner and admins add people by email and choose what each can do.
import { sb, q } from "./sb.js";
import { $, $$, esc, toast, copy, openModal, closeModal, confirmBox, fmtDate } from "./ui.js";

// Area each page belongs to (shared with business.js for the menu)
export const AREA_OF = {
  dashboard: "customers", customers: "customers", feedback: "customers", offers: "customers", loyalty: "customers", alerts: "customers",
  reviews: "reviews", seo: "reviews", replies: "reviews", whatsapp: "whatsapp", templates: "whatsapp",
  orders: "menu", menu: "menu", staff: "attendance", salary: "attendance", accounts: "accounts",
  plan: "settings", profile: "settings", team: "settings",
};
export const AREAS = [
  ["customers", "Customers & visits", "Log visits, scan loyalty cards, customers, offers, feedback"],
  ["reviews", "Google reviews & SEO", "Review links, keywords, Google replies"],
  ["whatsapp", "WhatsApp", "Send messages, reminders and templates"],
  ["menu", "QR menu & orders", "Take orders, edit the menu"],
  ["attendance", "Staff & salary", "Attendance, salaries and advances (sees pay)"],
  ["accounts", "Accounts", "Income, expenses, P&L, GST reports"],
  ["settings", "Business settings", "Business profile, plan and billing"],
];
const ROLE = { owner: ["Owner", "acc"], admin: ["Admin", "good"], staff: ["Staff", ""] };

let A, T = null;
const ctx = () => A.ctx();
const joinLink = (email) => new URL(`login.html?join=1&email=${encodeURIComponent(email)}`, location.href).href;
const inviteMsg = (email) => `Hi! I've added you to ${ctx().D.biz.name} on Branditude Growth Plan. Create your login with this email (${email}) here: ${joinLink(email)}`;

async function load() { T = await q(sb.rpc("team_list", { p_business: ctx().BID })); }

function draw() {
  const el = $("#team-view"); if (!el) return;
  const me = ctx().D.me?.role, areaChips = (perms, role) => role === "staff"
    ? (perms || []).map((p) => `<span class="tag">${esc((AREAS.find((a) => a[0] === p) || [, p])[1])}</span>`).join("") : `<span class="tag">Everything</span>`;
  el.innerHTML = A.head("Team & logins", "Give your manager and staff their own login. Admins can do everything. Staff only see what you tick, so a cashier can log visits without seeing your accounts or salaries.",
    `<button class="btn primary" data-t="add">+ Add a person</button>`) + `
  <div class="card"><div class="list">
    ${T.members.map((m) => `<div class="item"><div class="grow"><b>${esc(m.name || m.email || "—")}${m.me ? ' <span class="muted small">(you)</span>' : ""}</b>
      <span class="muted small">${esc(m.email || "")}${m.since ? " · added " + fmtDate(m.since) : ""}</span><div class="chips" style="margin-top:6px">${areaChips(m.perms, m.role)}</div></div>
      <span class="pill ${ROLE[m.role][1]}">${ROLE[m.role][0]}</span>
      ${m.role !== "owner" && !m.me && (m.role === "staff" || me === "owner") ? `<button class="btn sm" data-t="edit" data-id="${m.user_id}">Change</button><button class="btn sm ghost danger" data-t="rm" data-id="${m.user_id}">Remove</button>` : ""}</div>`).join("")}
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
      <div class="field"><label for="tm-email">Their email</label><input id="tm-email" type="email" required value="${esc(cur.email || "")}" ${isNew ? "" : "readonly"} placeholder="name@gmail.com"></div>
      <div class="field" style="margin-top:12px"><label>Role</label>
        <label class="check"><input type="radio" name="tm-role" value="staff" ${cur.role !== "admin" ? "checked" : ""}> <span><b>Staff</b>: only the things you tick below</span></label>
        <label class="check"><input type="radio" name="tm-role" value="admin" ${cur.role === "admin" ? "checked" : ""} ${me === "owner" ? "" : "disabled"}> <span><b>Admin</b>: everything, including accounts, salaries and the team${me === "owner" ? "" : " (only the owner can add admins)"}</span></label></div>
      <fieldset id="tm-areas" style="border:0;padding:0;margin:14px 0 0"><legend class="small" style="font-weight:600;margin-bottom:6px">What can they do?</legend>
        ${AREAS.map(([k, l, d]) => `<label class="check" style="align-items:flex-start"><input type="checkbox" value="${k}" ${(cur.perms || ["customers"]).includes(k) ? "checked" : ""}> <span><b>${esc(l)}</b><br><span class="muted small">${esc(d)}</span></span></label>`).join("")}
      </fieldset>
      <p class="err" id="tm-err"></p>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${isNew ? "Add" : "Save"}</button></div></form>`);
  const sync = () => { m.querySelector("#tm-areas").hidden = m.querySelector("input[name=tm-role]:checked").value === "admin"; };
  $$("input[name=tm-role]", m).forEach((r) => (r.onchange = sync)); sync();
  m.querySelector("#tm-f").onsubmit = async (e) => {
    e.preventDefault(); const btn = m.querySelector("button.primary"); btn.disabled = true;
    const email = m.querySelector("#tm-email").value.trim().toLowerCase(), role = m.querySelector("input[name=tm-role]:checked").value;
    try {
      const r = await q(sb.rpc("team_save", { p_business: ctx().BID, p_email: email, p_role: role, p_perms: $$("#tm-areas input:checked", m).map((i) => i.value) }));
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
