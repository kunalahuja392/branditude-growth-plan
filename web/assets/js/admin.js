// Agency portal: super admin + team
import { sb, q } from "./sb.js";
import { $, $$, esc, inr, inr2, nfmt, fmtDate, fmtDT, ago, toast, openModal, closeModal, confirmBox, formModal, ico, shell, barChart, hbars, statusPill, prettyPhone, copy, todayISO } from "./ui.js";

let C, D = {};
const isSuper = () => C.profile.role === "super_admin";
const ROUTES = () => [
  { label: "", items: [["overview", "Overview", "dash"], ["leads", "Leads", "inbox", D.stats?.leads_open || ""], ["businesses", "Businesses", "store"], ["payments", "Payments", "rupee", D.stats?.payments_pending || ""]] },
  { label: "Catalogue", items: [["packages", "Packages", "box"], ["promos", "Package discounts", "tag"], ["categories", "Categories", "grid"], ["products", "Category services", "spark"], ["keywords", "Keyword suggestions", "star"], ["whatsapp", "WhatsApp", "wa"]] },
  { label: "Agency", items: [...(isSuper() ? [["team", "Team", "shield"], ["settings", "Settings", "cog"]] : []), ["signout", "Sign out", "out"]] },
];
const route = () => { const h = location.hash.slice(1); return ROUTES().flatMap((g) => g.items).some((r) => r[0] === h) ? h : "overview"; };

export async function mount(ctx) {
  C = ctx;
  window.addEventListener("hashchange", () => { if (location.hash === "#signout") return C.signOut(); render(); });
  await loadStats(); render();
}
async function loadStats() { try { D.stats = await q(sb.rpc("admin_stats")); } catch (e) { toast(e.message, "error"); D.stats = {}; } }
const cats = async (force) => (D.cats && !force ? D.cats : (D.cats = await q(sb.from("categories").select("*").order("sort"))));
const pkgs = async (force) => (D.pkgs && !force ? D.pkgs : (D.pkgs = await q(sb.from("packages").select("*").order("sort"))));

function nav() {
  $("#nav").innerHTML = shell({ brandSub: isSuper() ? "Super admin" : "Team", groups: ROUTES(), current: route(),
    footer: `<div class="who-box"><b>${esc(C.profile.full_name || C.profile.email)}</b><span>${esc(C.profile.email || "")}</span></div>` });
}
async function render() {
  nav(); const r = route(), m = $("#main");
  m.innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
  try { m.innerHTML = await VIEWS[r](); after[r] && after[r](); } catch (e) { m.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
  m.scrollTop = 0;
}
const head = (t, p, actions = "") => `<div class="page-head"><div><h1>${t}</h1>${p ? `<p>${p}</p>` : ""}</div><div class="row">${actions}</div></div>`;
const kpi = (label, value, sub = "") => `<div class="card kpi"><div class="label">${label}</div><div class="value num">${value}</div><div class="sub">${sub}</div></div>`;
const after = {};

/* ---------------- Overview ---------------- */
const VIEWS = {
  async overview() {
    await loadStats(); nav(); const s = D.stats;
    const months = (s.revenue_by_month || []).map((x) => ({ label: new Date(x.month + "-01").toLocaleDateString("en-IN", { month: "short" }), value: +x.total }));
    const ls = s.leads_by_status || {};
    return head("Agency overview", "How the Growth Plan business is doing across every client.", `<a class="btn" href="#leads">${ico("inbox")} Leads</a><a class="btn primary" href="#payments">${ico("rupee")} Confirm payments</a>`) + `
    <div class="grid g4">
      ${kpi("Active businesses", nfmt(s.businesses_active), `${s.businesses_pending} waiting for payment · ${s.businesses_total} total`)}
      ${kpi("Monthly recurring revenue", inr(s.mrr), "from active plans, before GST")}
      ${kpi("Revenue · 30 days", inr(s.revenue_30d), "confirmed payments incl. GST")}
      ${kpi("Payments to confirm", nfmt(s.payments_pending), inr(s.payments_pending_amount) + " waiting")}
    </div>
    <div class="grid g4" style="margin-top:16px">
      ${kpi("New leads · 7 days", nfmt(s.leads_new_7d), `${s.leads_open} open in total`)}
      ${kpi("WhatsApp credits sold · 30 days", nfmt(s.wa_credits_sold_30d), "")}
      ${kpi("WhatsApp messages sent · 30 days", nfmt(s.wa_messages_30d), "")}
      ${kpi("On free trial", nfmt(s.businesses_trial || 0), `${s.trials_ending_48h || 0} ending in 48h · ${s.trials_expired || 0} expired unpaid`)}
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Revenue by month</h2><span class="muted small">confirmed payments</span></div>${months.length ? barChart(months) : `<div class="empty">No confirmed payments yet.</div>`}</div>
      <div class="card"><div class="card-head"><h2>Businesses by category</h2></div>${hbars((s.by_category || []).map((x) => ({ label: x.name, value: x.count })))}</div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="card-head"><h2>Lead funnel</h2></div>${hbars(["new", "contacted", "payment_pending", "won", "lost"].map((k) => ({ label: k.replace("_", " "), value: ls[k] || 0 })))}</div>
      <div class="card"><div class="card-head"><h2>Active businesses by package</h2></div>${hbars((s.by_package || []).map((x) => ({ label: x.name, value: x.count })))}</div>
    </div>`;
  },

  /* ---------------- Leads ---------------- */
  async leads() {
    await cats(); await pkgs();
    D.leads = await q(sb.from("leads").select("*, categories(name), packages(name)").order("created_at", { ascending: false }).limit(500));
    return head("Leads", "Every enquiry, store order and sign-up. Work them from new to won.", `<button class="btn primary" data-a="lead-new">${ico("plus")} Add lead</button>`) + `
    <div class="row" style="margin-bottom:12px"><input id="lf-q" type="search" placeholder="Search name, phone, city or ref" style="flex:2;min-width:200px" aria-label="Search leads">
      <select id="lf-cat" style="flex:1;min-width:160px" aria-label="Category"><option value="">All categories</option>${D.cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
    <div class="chips" id="lf-status" style="margin-bottom:14px">${["all", "new", "contacted", "payment_pending", "won", "lost"].map((s, i) => `<button class="chip" data-s="${s}" aria-pressed="${i === 0}">${s.replace("_", " ")} <span class="num">${s === "all" ? D.leads.length : D.leads.filter((l) => l.status === s).length}</span></button>`).join("")}</div>
    <div class="table-wrap"><table><thead><tr><th>Lead</th><th>Category</th><th>Interested in</th><th>Value</th><th>Source</th><th>Status</th><th>Received</th></tr></thead><tbody id="lead-rows"></tbody></table></div>`;
  },
};
after.leads = () => {
  const draw = () => {
    const qv = $("#lf-q").value.trim().toLowerCase(), cat = $("#lf-cat").value, st = $('#lf-status .chip[aria-pressed="true"]').dataset.s;
    const rows = D.leads.filter((l) => (st === "all" || l.status === st) && (!cat || l.category_id === cat) &&
      (!qv || [l.business_name, l.contact_name, l.phone, l.city, l.ref].join(" ").toLowerCase().includes(qv)));
    $("#lead-rows").innerHTML = rows.length ? rows.map((l) => `<tr class="sel-row" data-a="lead-open" data-id="${l.id}"><td><div class="who"><b>${esc(l.business_name)}</b><span>${esc(l.contact_name || "")} · ${esc(prettyPhone(l.phone))}${l.city ? " · " + esc(l.city) : ""}</span></div></td>
      <td>${esc(l.categories?.name || "—")}</td><td>${esc(l.packages?.name || "—")}${l.product_ids?.length ? ` <span class="pill">+${l.product_ids.length} service${l.product_ids.length > 1 ? "s" : ""}</span>` : ""}</td>
      <td class="num">${l.total ? inr(l.total) : "—"}</td><td>${esc(l.source)}</td><td>${statusPill(l.status)}</td><td>${ago(l.created_at)}</td></tr>`).join("") : `<tr><td colspan="7"><div class="empty">No leads match.</div></td></tr>`;
  };
  $("#lf-q").oninput = draw; $("#lf-cat").onchange = draw;
  $$("#lf-status .chip").forEach((c) => (c.onclick = () => { $$("#lf-status .chip").forEach((x) => x.setAttribute("aria-pressed", x === c)); draw(); }));
  draw();
};
async function openLead(id) {
  const l = D.leads.find((x) => x.id === id); if (!l) return;
  const team = await q(sb.from("profiles").select("id,full_name,email").in("role", ["super_admin", "team"]));
  const prods = l.product_ids?.length ? await q(sb.from("products").select("name,price").in("id", l.product_ids)) : [];
  const m = openModal(`<div class="modal-head"><h2>${esc(l.business_name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <dl class="kv"><dt>Ref</dt><dd>${esc(l.ref)}</dd><dt>Contact</dt><dd>${esc(l.contact_name || "—")}</dd><dt>Phone</dt><dd>${esc(prettyPhone(l.phone))}</dd><dt>Email</dt><dd>${esc(l.email || "—")}</dd>
      <dt>City</dt><dd>${esc(l.city || "—")}</dd><dt>Category</dt><dd>${esc(l.categories?.name || "—")}</dd><dt>Package</dt><dd>${esc(l.packages?.name || "—")} (${esc(l.billing || "")})</dd>
      <dt>Services</dt><dd>${prods.length ? prods.map((p) => esc(p.name)).join(", ") : "—"}</dd><dt>Promo</dt><dd>${esc(l.promo_code || "—")}</dd>
      <dt>Value</dt><dd class="num">${inr2(l.amount)} + GST ${inr2(l.gst)} = <b>${inr2(l.total)}</b></dd><dt>Message</dt><dd>${esc(l.message || "—")}</dd><dt>Received</dt><dd>${fmtDT(l.created_at)} via ${esc(l.source)}</dd></dl>
    <div class="fields" style="margin-top:16px">
      <div class="field"><label for="ld-status">Status</label><select id="ld-status">${["new", "contacted", "payment_pending", "won", "lost"].map((s) => `<option ${l.status === s ? "selected" : ""} value="${s}">${s.replace("_", " ")}</option>`).join("")}</select></div>
      <div class="field"><label for="ld-assign">Assigned to</label><select id="ld-assign"><option value="">Nobody</option>${team.map((t) => `<option value="${t.id}" ${l.assigned_to === t.id ? "selected" : ""}>${esc(t.full_name || t.email)}</option>`).join("")}</select></div>
      <div class="field" style="grid-column:1/-1"><label for="ld-notes">Notes</label><textarea id="ld-notes">${esc(l.notes || "")}</textarea></div></div>
    <div class="modal-foot"><a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/${esc(l.phone)}?text=${encodeURIComponent(`Hi ${(l.contact_name || "").split(" ")[0] || "there"}, this is Branditude about the Growth Plan for ${l.business_name}.`)}">${ico("wa")} WhatsApp</a>
      ${l.business_id ? `<a class="btn" href="#businesses" data-close>View business</a>` : ""}<button class="btn primary" id="ld-save">Save</button></div>`, { wide: true });
  m.querySelector("#ld-save").onclick = async () => {
    try { await q(sb.from("leads").update({ status: $("#ld-status").value, assigned_to: $("#ld-assign").value || null, notes: $("#ld-notes").value, updated_at: new Date().toISOString() }).eq("id", l.id));
      closeModal(); toast("Lead updated"); render(); } catch (e) { toast(e.message, "error"); }
  };
}

/* ---------------- Businesses ---------------- */
VIEWS.businesses = async () => {
  await cats(); await pkgs();
  D.biz = await q(sb.from("businesses").select("*, categories(name), packages(name), wa_wallets(balance)").order("created_at", { ascending: false }));
  return head("Businesses", "All client accounts. Open one to see its report, change its plan, or switch WhatsApp on.") + `
  <div class="row" style="margin-bottom:12px"><input id="bf-q" type="search" placeholder="Search name, city or phone" style="flex:2;min-width:200px" aria-label="Search businesses">
    <select id="bf-cat" style="flex:1;min-width:150px" aria-label="Category"><option value="">All categories</option>${D.cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
    <select id="bf-st" style="flex:1;min-width:150px" aria-label="Status"><option value="">All statuses</option>${["trial", "active", "pending_payment", "paused", "cancelled"].map((s) => `<option value="${s}">${s.replace("_", " ")}</option>`).join("")}</select></div>
  <div class="table-wrap"><table><thead><tr><th>Business</th><th>Category</th><th>Package</th><th>Status</th><th>Renews</th><th>WhatsApp</th><th>Joined</th></tr></thead><tbody id="biz-rows"></tbody></table></div>`;
};
after.businesses = () => {
  const draw = () => {
    const qv = $("#bf-q").value.trim().toLowerCase(), cat = $("#bf-cat").value, st = $("#bf-st").value;
    const rows = D.biz.filter((b) => (!cat || b.category_id === cat) && (!st || b.status === st) && (!qv || [b.name, b.city, b.phone].join(" ").toLowerCase().includes(qv)));
    $("#biz-rows").innerHTML = rows.length ? rows.map((b) => `<tr class="sel-row" data-a="biz-open" data-id="${b.id}"><td><div class="who"><b>${esc(b.name)}</b><span>${esc(b.city || "")}${b.phone ? " · " + esc(prettyPhone(b.phone)) : ""}</span></div></td>
      <td>${esc(b.categories?.name || "—")}</td><td>${esc(b.packages?.name || "—")} <span class="muted small">${esc(b.billing)}</span></td><td>${statusPill(b.status)}</td>
      <td>${b.subscription_ends ? fmtDate(b.subscription_ends) + (new Date(b.subscription_ends) < new Date() ? ' <span class="pill bad">overdue</span>' : "") : "—"}</td>
      <td>${b.wa_enabled ? `<span class="pill good">On</span> <span class="num small">${nfmt(b.wa_wallets?.balance ?? 0)} cr</span>` : '<span class="pill">Off</span>'}</td><td>${fmtShort(b.created_at)}</td></tr>`).join("") : `<tr><td colspan="7"><div class="empty">No businesses match.</div></td></tr>`;
  };
  $("#bf-q").oninput = draw; $("#bf-cat").onchange = draw; $("#bf-st").onchange = draw; draw();
};
const fmtShort = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");
async function openBiz(id) {
  const b = D.biz.find((x) => x.id === id); if (!b) return;
  const [rep, pays, owner, ledger] = await Promise.all([
    q(sb.rpc("business_report", { p_business: id })),
    q(sb.from("payments").select("*").eq("business_id", id).order("created_at", { ascending: false }).limit(20)),
    b.owner_id ? q(sb.from("profiles").select("full_name,email,phone").eq("id", b.owner_id).maybeSingle()) : null,
    q(sb.from("wa_ledger").select("*").eq("business_id", id).order("created_at", { ascending: false }).limit(10)),
  ]);
  const m = openModal(`<div class="modal-head"><h2>${esc(b.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <div class="row" style="margin-bottom:14px">${statusPill(b.status)}<span class="pill">${esc(b.categories?.name || "No category")}</span><span class="pill acc">${esc(b.packages?.name || "No package")} · ${esc(b.billing)}</span></div>
    <dl class="kv"><dt>Owner</dt><dd>${esc(owner?.full_name || "—")} · ${esc(owner?.email || "")}</dd><dt>Phone</dt><dd>${esc(prettyPhone(b.phone))}</dd><dt>City</dt><dd>${esc(b.city || "—")}</dd>
      <dt>Feedback link</dt><dd><a href="f.html?b=${esc(b.slug)}" target="_blank" rel="noopener">f.html?b=${esc(b.slug)}</a></dd></dl>
    <h3 style="margin:18px 0 8px">Report · last 30 days</h3>
    <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:10px">
      ${[["Customers", nfmt(rep.customers)], ["New customers", nfmt(rep.new_customers_30d)], ["Visits", nfmt(rep.visits_30d)], ["Revenue logged", inr(rep.revenue_30d)], ["Reviews earned", `${rep.reviews_reviewed} of ${rep.reviews_asked} asked`], ["Avg rating", rep.avg_rating_30d ?? "–"], ["Open complaints", rep.complaints_open], ["Loyalty rewards", rep.loyalty_rewards_30d], ["WhatsApp", `${nfmt(rep.wa_balance ?? 0)} credits · ${rep.wa_sent_30d} sent`]].map(([k, v]) => `<div class="card" style="padding:12px"><div class="muted small">${k}</div><b class="num">${v}</b></div>`).join("")}
    </div>
    <h3 style="margin:18px 0 8px">Account</h3>
    <div class="fields">
      <div class="field"><label for="bz-status">Status</label><select id="bz-status">${["trial", "pending_payment", "active", "paused", "cancelled"].map((s) => `<option value="${s}" ${b.status === s ? "selected" : ""}>${s.replace("_", " ")}</option>`).join("")}</select></div>
      <div class="field"><label for="bz-pkg">Package</label><select id="bz-pkg">${D.pkgs.map((p) => `<option value="${p.id}" ${b.package_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="bz-bill">Billing</label><select id="bz-bill"><option ${b.billing === "monthly" ? "selected" : ""}>monthly</option><option ${b.billing === "yearly" ? "selected" : ""}>yearly</option></select></div>
      <div class="field"><label for="bz-ends">Paid / trial until</label><input id="bz-ends" type="date" value="${esc(b.subscription_ends || "")}"></div>
      <div class="field"><label for="bz-cat">Category</label><select id="bz-cat">${D.cats.map((c) => `<option value="${c.id}" ${b.category_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="bz-waid">WhatsApp sender id (optional)</label><input id="bz-waid" value="${esc(b.wa_phone_number_id || "")}" placeholder="Uses agency number if empty"></div>
      <label class="check" style="grid-column:1/-1"><input type="checkbox" id="bz-wa" ${b.wa_enabled ? "checked" : ""}> WhatsApp add-on on</label>
    </div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="bz-save">Save account</button></div>
    <h3 style="margin:18px 0 8px">WhatsApp credits · balance ${nfmt(rep.wa_balance ?? 0)}</h3>
    <div class="row"><input id="bz-cr" type="number" placeholder="+500 or -100" style="max-width:160px" aria-label="Credits to add or remove"><input id="bz-crr" placeholder="Reason" style="flex:1;min-width:160px" aria-label="Reason"><button class="btn" id="bz-crb">Adjust</button></div>
    ${ledger.length ? `<div class="list" style="margin-top:8px">${ledger.map((x) => `<div class="item small"><div class="grow">${esc(x.reason)} <span class="muted">${fmtDT(x.created_at)}</span></div><b class="num" style="color:${x.delta > 0 ? "var(--good)" : "var(--ink-2)"}">${x.delta > 0 ? "+" : ""}${x.delta}</b></div>`).join("")}</div>` : ""}
    <h3 style="margin:18px 0 8px">Payments</h3>
    ${pays.length ? `<div class="list">${pays.map((p) => `<div class="item small"><div class="grow"><b>${esc(p.description)}</b><span class="muted">${fmtDT(p.created_at)}${p.utr ? " · UTR " + esc(p.utr) : ""}</span></div><span class="num">${inr2(p.total)}</span>${statusPill(p.status)}</div>`).join("")}</div>` : `<div class="empty">No payments.</div>`}`, { wide: true });
  m.querySelector("#bz-save").onclick = async () => {
    try { await q(sb.rpc("admin_update_business", { p_business: id, p: { status: $("#bz-status").value, package_id: $("#bz-pkg").value, billing: $("#bz-bill").value, subscription_ends: $("#bz-ends").value, category_id: $("#bz-cat").value, wa_enabled: $("#bz-wa").checked, wa_phone_number_id: $("#bz-waid").value.trim() } }));
      toast("Business updated"); closeModal(); render(); } catch (e) { toast(e.message, "error"); }
  };
  m.querySelector("#bz-crb").onclick = async () => {
    const d = parseInt($("#bz-cr").value, 10); if (!d) return toast("Enter a number of credits", "error");
    try { const bal = await q(sb.rpc("admin_adjust_credits", { p_business: id, p_delta: d, p_reason: $("#bz-crr").value })); toast(`Balance is now ${bal}`); closeModal(); render(); } catch (e) { toast(e.message, "error"); }
  };
}

/* ---------------- Payments ---------------- */
VIEWS.payments = async () => {
  D.pay = await q(sb.from("payments").select("*, businesses(name, phone)").order("created_at", { ascending: false }).limit(300));
  const pend = D.pay.filter((p) => p.status === "pending");
  const row = (p) => `<tr><td><div class="who"><b>${esc(p.businesses?.name || "—")}</b><span>${esc(p.description)}</span></div></td><td>${esc(p.kind.replace("_", " "))}</td>
    <td class="num">${inr2(p.total)}<div class="muted small">${inr2(p.amount)} + ${inr2(p.gst)} GST</div></td><td>${p.utr ? `<b class="num">${esc(p.utr)}</b>` : '<span class="muted">Not given yet</span>'}</td><td>${fmtDT(p.created_at)}</td>
    <td>${p.status === "pending" ? `<div class="row" style="flex-wrap:nowrap"><button class="btn sm primary" data-a="pay-ok" data-id="${p.id}">Confirm</button><button class="btn sm ghost danger" data-a="pay-no" data-id="${p.id}">Reject</button></div>` : statusPill(p.status)}</td></tr>`;
  return head("Payments", "Match each UPI transaction ID with your bank statement, then confirm. Confirming a plan activates the business. Confirming credits adds them to the business's WhatsApp balance.") + `
  <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>Waiting for confirmation</h2><span class="pill ${pend.length ? "warn" : "good"} num">${pend.length}</span></div>
  ${pend.length ? `<div class="table-wrap"><table><thead><tr><th>Business</th><th>Type</th><th>Amount</th><th>UPI ref</th><th>Created</th><th></th></tr></thead><tbody>${pend.map(row).join("")}</tbody></table></div>` : `<div class="empty">Nothing to confirm.</div>`}</div>
  <div class="card"><div class="card-head"><h2>History</h2></div><div class="table-wrap"><table><thead><tr><th>Business</th><th>Type</th><th>Amount</th><th>UPI ref</th><th>Created</th><th>Status</th></tr></thead><tbody>${D.pay.filter((p) => p.status !== "pending").map(row).join("") || `<tr><td colspan="6"><div class="empty">No history yet.</div></td></tr>`}</tbody></table></div></div>`;
};

/* ---------------- Packages ---------------- */
VIEWS.packages = async () => {
  await pkgs(true);
  return head("Packages", "The plans businesses buy on the store. A discount here shows a sale price to everyone.", `<button class="btn primary" data-a="pkg-new">${ico("plus")} New package</button>`) + `
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${D.pkgs.map((p) => `<div class="coupon" style="border-style:solid">
    <div class="row" style="justify-content:space-between"><span class="code" style="font-size:20px">${esc(p.name)}</span>${p.active ? (p.is_popular ? '<span class="pill acc">Most popular</span>' : '<span class="pill good">Live</span>') : '<span class="pill">Hidden</span>'}</div>
    <div><b class="num" style="font-size:22px">${inr(p.monthly_price * (1 - p.discount_percent / 100))}</b><span class="muted">/month</span>${+p.discount_percent ? ` <s class="muted num">${inr(p.monthly_price)}</s> <span class="pill warn">${+p.discount_percent}% off${p.discount_label ? " · " + esc(p.discount_label) : ""}</span>` : ""}
      <div class="muted small num">${inr(p.yearly_price * (1 - p.discount_percent / 100))}/year · ${p.max_locations} location${p.max_locations > 1 ? "s" : ""}${p.includes_whatsapp ? " · WhatsApp on" : ""}</div></div>
    <ul class="small" style="margin:0;padding-left:18px">${p.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <div class="row"><button class="btn sm" data-a="pkg-edit" data-id="${p.id}">Edit</button></div></div>`).join("")}</div>`;
};
function pkgForm(p = { active: true, features: [], max_locations: 1, sort: 100, discount_percent: 0 }) {
  formModal({ title: p.id ? "Edit package" : "New package", values: p, submitLabel: "Save package",
    fields: [
      { key: "name", label: "Name", required: true }, { key: "slug", label: "Slug (URL)", placeholder: "growth", help: "Lower case, no spaces" },
      { key: "tagline", label: "Tagline", full: true },
      { key: "monthly_price", label: "Monthly price ₹", type: "number", required: true, min: 0 }, { key: "yearly_price", label: "Yearly price ₹", type: "number", required: true, min: 0 },
      { key: "discount_percent", label: "Discount %", type: "number", min: 0, help: "0 for no sale" }, { key: "discount_label", label: "Discount label", placeholder: "Diwali sale" },
      { key: "max_locations", label: "Locations included", type: "number", min: 1 }, { key: "sort", label: "Order on page", type: "number" },
      { key: "features", label: "Features (one per line)", type: "lines", full: true },
      { key: "includes_whatsapp", label: "Switch WhatsApp add-on on (credits still charged)", type: "checkbox", full: true },
      { key: "is_popular", label: "Highlight as most popular", type: "checkbox", full: true }, { key: "active", label: "Show on store", type: "checkbox", full: true },
    ],
    onSave: async (v) => { v.slug = (v.slug || v.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      v.discount_percent = v.discount_percent || 0; v.max_locations = v.max_locations || 1; v.sort = v.sort ?? 100;
      if (p.id) await q(sb.from("packages").update(v).eq("id", p.id)); else await q(sb.from("packages").insert(v));
      toast("Package saved"); D.pkgs = null; render(); },
  });
}

/* ---------------- Promo codes ---------------- */
VIEWS.promos = async () => {
  await pkgs(); D.promos = await q(sb.from("promo_codes").select("*").order("created_at", { ascending: false }));
  return head("Package discounts", "Promo codes buyers can enter at checkout. For a sale everyone sees, set a discount on the package instead.", `<button class="btn primary" data-a="promo-new">${ico("plus")} New code</button>`) + `
  <div class="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Packages</th><th>Valid until</th><th>Used</th><th>Status</th><th></th></tr></thead><tbody>
  ${D.promos.map((c) => `<tr><td><b>${esc(c.code)}</b></td><td>${c.type === "percent" ? +c.value + "% off plan" : inr(c.value) + " off plan"}</td>
    <td>${c.package_ids?.length ? c.package_ids.map((id) => esc(D.pkgs.find((p) => p.id === id)?.name || "?")).join(", ") : "All"}</td><td>${c.valid_until ? fmtDate(c.valid_until) : "No end"}</td>
    <td class="num">${c.used}${c.max_uses ? " / " + c.max_uses : ""}</td><td>${c.active ? '<span class="pill good">Active</span>' : '<span class="pill">Off</span>'}</td><td><button class="btn sm ghost" data-a="promo-edit" data-id="${c.id}">Edit</button></td></tr>`).join("") || `<tr><td colspan="7"><div class="empty">No promo codes yet.</div></td></tr>`}
  </tbody></table></div>`;
};
function promoForm(c = { type: "percent", active: true }) {
  formModal({ title: c.id ? "Edit promo code" : "New promo code", values: { ...c, package_ids: c.package_ids || [] },
    fields: [
      { key: "code", label: "Code", required: true, placeholder: "LAUNCH20" }, { key: "type", label: "Type", type: "select", options: [["percent", "Percent off plan"], ["flat", "₹ off plan"]] },
      { key: "value", label: "Value", type: "number", required: true, min: 1 }, { key: "valid_until", label: "Valid until", type: "date" },
      { key: "max_uses", label: "Max uses", type: "number", min: 1, help: "Empty = unlimited" },
      { key: "package_ids", label: "Applies to (none selected = all)", type: "multiselect", full: true, options: D.pkgs.map((p) => [p.id, p.name]) },
      { key: "active", label: "Active", type: "checkbox", full: true },
    ],
    onSave: async (v) => { v.code = v.code.toUpperCase().replace(/\s+/g, ""); v.package_ids = v.package_ids.length ? v.package_ids : null; v.valid_until = v.valid_until || null;
      if (c.id) await q(sb.from("promo_codes").update(v).eq("id", c.id)); else await q(sb.from("promo_codes").insert(v)); toast("Promo code saved"); render(); },
    extraFoot: c.id ? `<button type="button" class="btn danger" style="margin-right:auto" id="promo-del">Delete</button>` : "",
  });
  if (c.id) $("#promo-del").onclick = async () => { if (await confirmBox("Delete this code?", "Buyers won't be able to use it any more.", "Delete", { danger: true })) { await q(sb.from("promo_codes").delete().eq("id", c.id)); toast("Deleted"); render(); } };
}

/* ---------------- Categories ---------------- */
VIEWS.categories = async () => {
  await cats(true); const counts = await q(sb.from("businesses").select("category_id"));
  return head("Business categories", "Shown when a business registers. Category services are offered based on these.", `<button class="btn primary" data-a="cat-new">${ico("plus")} New category</button>`) + `
  <div class="table-wrap"><table><thead><tr><th>Category</th><th>Businesses</th><th>Order</th><th>Status</th><th></th></tr></thead><tbody>
  ${D.cats.map((c) => `<tr><td><b>${esc(c.icon || "")} ${esc(c.name)}</b> <span class="muted small">${esc(c.slug)}</span></td><td class="num">${counts.filter((x) => x.category_id === c.id).length}</td><td class="num">${c.sort}</td>
    <td>${c.active ? '<span class="pill good">Shown</span>' : '<span class="pill">Hidden</span>'}</td><td><button class="btn sm ghost" data-a="cat-edit" data-id="${c.id}">Edit</button></td></tr>`).join("")}
  </tbody></table></div>`;
};
function catForm(c = { active: true, icon: "🏪", sort: 100 }) {
  formModal({ title: c.id ? "Edit category" : "New category", values: c,
    fields: [{ key: "name", label: "Name", required: true, placeholder: "Pet grooming" }, { key: "icon", label: "Icon (emoji)" }, { key: "sort", label: "Order", type: "number" }, { key: "active", label: "Show at registration", type: "checkbox", full: true }],
    onSave: async (v) => { v.slug = c.slug || v.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); v.sort = v.sort ?? 100;
      if (c.id) await q(sb.from("categories").update(v).eq("id", c.id)); else await q(sb.from("categories").insert(v)); D.cats = null; toast("Category saved"); render(); } });
}

/* ---------------- Category services ---------------- */
VIEWS.products = async () => {
  await cats(); D.prods = await q(sb.from("products").select("*, product_categories(category_id)").order("sort"));
  return head("Category services", "Extra services offered to businesses in specific categories, e.g. Zomato optimisation for cafés. Leave categories empty to offer a service to everyone.", `<button class="btn primary" data-a="prod-new">${ico("plus")} New service</button>`) + `
  <div class="table-wrap"><table><thead><tr><th>Service</th><th>Price</th><th>Offered to</th><th>Status</th><th></th></tr></thead><tbody>
  ${D.prods.map((p) => { const cs = p.product_categories.map((x) => D.cats.find((c) => c.id === x.category_id)).filter(Boolean);
    return `<tr><td><div class="who"><b>${esc(p.name)}</b><span>${esc(p.description || "")}</span></div></td><td class="num">${inr(p.price)}${p.billing === "monthly" ? "/mo" : ""}</td>
    <td>${cs.length ? `<div class="chips">${cs.map((c) => `<span class="tag">${esc(c.icon)} ${esc(c.name)}</span>`).join("")}</div>` : '<span class="pill info">All categories</span>'}</td>
    <td>${p.active ? '<span class="pill good">Live</span>' : '<span class="pill">Hidden</span>'}</td><td><button class="btn sm ghost" data-a="prod-edit" data-id="${p.id}">Edit</button></td></tr>`; }).join("")}
  </tbody></table></div>`;
};
function prodForm(p = { active: true, billing: "one_time", sort: 100, product_categories: [] }) {
  formModal({ title: p.id ? "Edit service" : "New service", values: { ...p, cats: (p.product_categories || []).map((x) => x.category_id) },
    fields: [
      { key: "name", label: "Name", required: true, full: true, placeholder: "Zomato & Swiggy listing optimisation" }, { key: "description", label: "Description", type: "textarea", full: true },
      { key: "price", label: "Price ₹", type: "number", required: true, min: 0 }, { key: "billing", label: "Billing", type: "select", options: [["one_time", "One-time"], ["monthly", "Monthly"]] },
      { key: "sort", label: "Order", type: "number" },
      { key: "cats", label: "Offered to these categories (none = all)", type: "multiselect", full: true, options: D.cats.map((c) => [c.id, `${c.icon} ${c.name}`]) },
      { key: "active", label: "Show to businesses", type: "checkbox", full: true },
    ],
    onSave: async (v) => { const cs = v.cats; delete v.cats; v.sort = v.sort ?? 100;
      let id = p.id;
      if (id) await q(sb.from("products").update(v).eq("id", id)); else id = (await q(sb.from("products").insert(v).select("id").single())).id;
      await q(sb.from("product_categories").delete().eq("product_id", id));
      if (cs.length) await q(sb.from("product_categories").insert(cs.map((c) => ({ product_id: id, category_id: c }))));
      toast("Service saved"); render(); } });
}

/* ---------------- Keyword suggestions ---------------- */
let KW_CAT = null;
VIEWS.keywords = async () => {
  await cats(); if (!KW_CAT || !D.cats.some((c) => c.id === KW_CAT)) KW_CAT = D.cats[0]?.id;
  const all = await q(sb.from("category_keywords").select("*").order("sort"));
  D.ckw = all; const list = all.filter((k) => k.category_id === KW_CAT);
  return head("Keyword suggestions", "Search phrases suggested to businesses in each category on their Keywords & SEO page. Write <b>{city}</b> where the business's city should go. Businesses use these in their own Google profile content, never in customer reviews.") + `
  <div class="chips" style="margin-bottom:16px">${D.cats.map((c) => `<button class="chip" data-a="kw-cat" data-id="${c.id}" aria-pressed="${c.id === KW_CAT}">${esc(c.icon)} ${esc(c.name)} <span class="num">${all.filter((k) => k.category_id === c.id).length}</span></button>`).join("")}</div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h2>${esc(D.cats.find((c) => c.id === KW_CAT)?.name || "")}</h2><span class="pill num">${list.length}</span></div>
      ${list.length ? `<div class="list">${list.map((k) => `<div class="item"><div class="grow">${esc(k.keyword)}<span class="muted small" style="display:block">e.g. ${esc(k.keyword.replace(/\{city\}/g, "Pune"))}</span></div><button class="btn sm ghost danger" data-a="ckw-del" data-id="${k.id}">Remove</button></div>`).join("")}</div>` : `<div class="empty">No suggestions for this category yet.</div>`}</div>
    <div class="card"><div class="card-head"><h2>Add suggestions</h2></div>
      <form id="ckw-form"><div class="field"><label for="ckw-new">One per line</label><textarea id="ckw-new" placeholder="best café in {city}&#10;cafe near me&#10;filter coffee {city}"></textarea></div>
      <div class="modal-foot" style="justify-content:flex-start"><button class="btn primary">Add to this category</button></div></form></div>
  </div>`;
};
after.keywords = () => { const f = $("#ckw-form"); if (!f) return;
  f.onsubmit = async (e) => { e.preventDefault();
    const lines = [...new Set($("#ckw-new").value.split("\n").map((x) => x.trim().replace(/\s+/g, " ")).filter((x) => x.length >= 2 && x.length <= 80))];
    if (!lines.length) return toast("Type at least one keyword", "error");
    const start = (D.ckw.filter((k) => k.category_id === KW_CAT).reduce((m, k) => Math.max(m, k.sort), 0) || 0) + 1;
    try { await q(sb.from("category_keywords").upsert(lines.map((kw, i) => ({ category_id: KW_CAT, keyword: kw, sort: start + i })), { onConflict: "category_id,keyword", ignoreDuplicates: true })); toast(`Added ${lines.length}`); render(); }
    catch (err) { toast(err.message, "error"); } }; };

/* ---------------- WhatsApp ---------------- */
VIEWS.whatsapp = async () => {
  const [packs, tpls, wallets, settings] = await Promise.all([
    q(sb.from("wa_credit_packs").select("*").order("sort")), q(sb.from("wa_templates").select("*").order("created_at")),
    q(sb.from("wa_wallets").select("balance, businesses(name, wa_enabled)").order("balance", { ascending: false }).limit(50)),
    q(sb.from("settings").select("*").eq("key", "whatsapp").maybeSingle()),
  ]);
  D.packs = packs; D.tpls = tpls;
  return head("WhatsApp add-on", "Optional for businesses. They prepay for credit packs and each message uses credits. Templates must also be approved in Meta's WhatsApp Manager with the same name.") + `
  <div class="grid g2">
    <div class="card"><div class="card-head"><h2>Credit packs</h2><button class="btn sm" data-a="pack-new">${ico("plus")} New pack</button></div>
      <div class="list">${packs.map((p) => `<div class="item"><div class="grow"><b>${esc(p.name)}</b><span class="muted small num">${nfmt(p.credits)} messages · ${inr2(p.price / p.credits)} per message</span></div><b class="num">${inr(p.price)}</b>${p.active ? "" : '<span class="pill">Hidden</span>'}<button class="btn sm ghost" data-a="pack-edit" data-id="${p.id}">Edit</button></div>`).join("") || `<div class="empty">No packs.</div>`}</div>
      <p class="small muted" style="margin-top:10px">${esc(settings?.value?.price_note || "")}</p></div>
    <div class="card"><div class="card-head"><h2>Credit balances</h2></div>
      <div class="list">${wallets.map((w) => `<div class="item"><div class="grow"><b>${esc(w.businesses?.name || "")}</b></div>${w.businesses?.wa_enabled ? '<span class="pill good">On</span>' : '<span class="pill">Off</span>'}<b class="num">${nfmt(w.balance)}</b></div>`).join("") || `<div class="empty">No balances yet.</div>`}</div></div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Message templates</h2><button class="btn sm" data-a="tpl-new">${ico("plus")} New template</button></div>
    <div class="table-wrap"><table><thead><tr><th>Template</th><th>Message</th><th>Meta category</th><th>Credits</th><th></th></tr></thead><tbody>
    ${tpls.map((t) => `<tr><td><div class="who"><b>${esc(t.title)}</b><span>${esc(t.name)} · ${esc(t.language)}</span></div></td><td class="small" style="max-width:380px">${esc(t.body_preview)}</td><td>${esc(t.category)}</td><td class="num">${t.credits_per_message}</td><td><button class="btn sm ghost" data-a="tpl-edit" data-id="${t.id}">Edit</button></td></tr>`).join("")}
    </tbody></table></div></div>`;
};
function packForm(p = { active: true, sort: 100 }) {
  formModal({ title: p.id ? "Edit credit pack" : "New credit pack", values: p,
    fields: [{ key: "name", label: "Name", required: true }, { key: "credits", label: "Credits (messages)", type: "number", required: true, min: 1 }, { key: "price", label: "Price ₹ (before GST)", type: "number", required: true, min: 0 }, { key: "sort", label: "Order", type: "number" }, { key: "active", label: "Show to businesses", type: "checkbox", full: true }],
    onSave: async (v) => { v.sort = v.sort ?? 100; if (p.id) await q(sb.from("wa_credit_packs").update(v).eq("id", p.id)); else await q(sb.from("wa_credit_packs").insert(v)); toast("Pack saved"); render(); } });
}
function tplForm(t = { language: "en", category: "marketing", credits_per_message: 1, active: true, params: [] }) {
  formModal({ title: t.id ? "Edit template" : "New template", values: t,
    fields: [
      { key: "title", label: "Title shown to businesses", required: true }, { key: "name", label: "Meta template name", required: true, placeholder: "festival_offer" },
      { key: "body_preview", label: "Message text, exactly as approved. {{1}} is always the customer's first name.", type: "textarea", full: true, required: true },
      { key: "params", label: "Labels for {{2}}, {{3}}… (one per line)", type: "lines", full: true },
      { key: "language", label: "Language code", placeholder: "en" }, { key: "category", label: "Meta category", type: "select", options: [["marketing", "Marketing"], ["utility", "Utility"]] },
      { key: "credits_per_message", label: "Credits per message", type: "number", min: 1 }, { key: "active", label: "Available to businesses", type: "checkbox", full: true },
    ],
    onSave: async (v) => { if (t.id) await q(sb.from("wa_templates").update(v).eq("id", t.id)); else await q(sb.from("wa_templates").insert(v)); toast("Template saved"); render(); } });
}

/* ---------------- Team ---------------- */
VIEWS.team = async () => {
  if (!isSuper()) return `<div class="card empty">Only a super admin can manage the team.</div>`;
  const team = await q(sb.from("profiles").select("*").in("role", ["super_admin", "team"]).order("created_at"));
  return head("Team", "People at Branditude who can sign in to this portal. Team members can do everything except manage the team and settings.", `<button class="btn primary" data-a="team-add">${ico("plus")} Add team member</button>`) + `
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Since</th><th></th></tr></thead><tbody>
  ${team.map((t) => `<tr><td><b>${esc(t.full_name || "—")}</b></td><td>${esc(t.email || "")}</td><td>${t.role === "super_admin" ? '<span class="pill acc">Super admin</span>' : '<span class="pill info">Team</span>'}</td><td>${fmtDate(t.created_at)}</td>
    <td>${t.id !== C.user.id ? `<div class="row" style="flex-wrap:nowrap">${t.role === "team" ? `<button class="btn sm ghost" data-a="team-role" data-email="${esc(t.email)}" data-role="super_admin">Make super admin</button>` : `<button class="btn sm ghost" data-a="team-role" data-email="${esc(t.email)}" data-role="team">Make team</button>`}<button class="btn sm ghost danger" data-a="team-role" data-email="${esc(t.email)}" data-role="customer">Remove</button></div>` : '<span class="muted small">You</span>'}</td></tr>`).join("")}
  </tbody></table></div>
  <div class="note" style="margin-top:14px">To add someone: ask them to create an account on the sign-in page (Business tab → they can sign up from the store, or you can invite them from Supabase → Authentication → Users). Then add their email here.</div>`;
};

/* ---------------- Settings ---------------- */
VIEWS.settings = async () => {
  if (!isSuper()) return `<div class="card empty">Only a super admin can change settings.</div>`;
  const rows = await q(sb.from("settings").select("*")); const g = (k) => rows.find((r) => r.key === k)?.value || {};
  D.settings = { agency: g("agency"), payment: g("payment"), gst: g("gst"), whatsapp: g("whatsapp"), trial: g("trial") };
  const a = D.settings.agency, p = D.settings.payment;
  const f = (id, label, val, ph = "") => `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(val || "")}" placeholder="${esc(ph)}"></div>`;
  return head("Settings", "Agency details shown on the store and in emails, and how businesses pay you.") + `
  <form id="set-form" class="card" style="max-width:860px">
    <h2 style="margin-bottom:12px">Agency details</h2>
    <div class="fields">${f("s-name", "Brand name", a.name)}${f("s-legal", "Legal name", a.legal_name)}${f("s-web", "Website", a.website, "branditudeglobal.com")}${f("s-wa", "WhatsApp number (with country code)", a.whatsapp, "919800000000")}
      ${f("s-phone", "Phone", a.phone)}${f("s-email", "Email", a.email)}${f("s-hours", "Working hours", a.hours)}</div>
    <div class="field" style="margin-top:14px"><label for="s-addr">Office address</label><input id="s-addr" value="${esc(a.address || "")}"></div>
    <h2 style="margin:22px 0 12px">Payments</h2>
    <div class="fields">${f("s-upi", "UPI ID", p.upi_id, "branditude@okicici")}${f("s-upiname", "UPI payee name", p.upi_name)}${f("s-gstin", "GSTIN", p.gstin)}
      <div class="field"><label for="s-gst">GST rate %</label><input id="s-gst" type="number" min="0" max="28" value="${Math.round((D.settings.gst.rate ?? 0.18) * 100)}"></div></div>
    <h2 style="margin:22px 0 12px">Free trial</h2>
    <div class="fields"><div class="field"><label for="s-trial">Free trial for new businesses (days, 0 = no trial)</label><input id="s-trial" type="number" min="0" max="60" value="${D.settings.trial.days ?? 3}"></div></div>
    <h2 style="margin:22px 0 12px">WhatsApp</h2>
    <div class="field"><label for="s-wanote">Pricing note shown to businesses</label><input id="s-wanote" value="${esc(D.settings.whatsapp.price_note || "")}"></div>
    <div class="modal-foot" style="justify-content:flex-start"><button class="btn primary">Save settings</button></div>
  </form>`;
};
after.settings = () => {
  const f = $("#set-form"); if (!f) return;
  f.onsubmit = async (e) => { e.preventDefault(); const v = (id) => $("#" + id).value.trim();
    const up = [
      { key: "agency", public: true, value: { name: v("s-name"), legal_name: v("s-legal"), website: v("s-web"), whatsapp: v("s-wa").replace(/\D/g, ""), phone: v("s-phone"), email: v("s-email"), hours: v("s-hours"), address: v("s-addr") } },
      { key: "payment", public: true, value: { upi_id: v("s-upi"), upi_name: v("s-upiname"), gstin: v("s-gstin") } },
      { key: "gst", public: true, value: { rate: (+v("s-gst") || 0) / 100 } },
      { key: "whatsapp", public: true, value: { price_note: v("s-wanote") } },
      { key: "trial", public: true, value: { days: Math.max(0, Math.min(60, parseInt(v("s-trial"), 10) || 0)) } },
    ].map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    try { await q(sb.from("settings").upsert(up)); toast("Settings saved"); } catch (err) { toast(err.message, "error"); } };
};

/* ---------------- actions ---------------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-a]"); if (!el || !C) return;
  const a = el.dataset.a, id = el.dataset.id;
  try {
    switch (a) {
      case "lead-open": openLead(id); break;
      case "lead-new": await cats(); await pkgs(); formModal({ title: "Add a lead", fields: [
          { key: "business_name", label: "Business name", required: true }, { key: "contact_name", label: "Contact name" }, { key: "phone", label: "Phone", required: true }, { key: "city", label: "City" },
          { key: "category_id", label: "Category", type: "select", options: [["", "—"], ...D.cats.map((c) => [c.id, c.name])] }, { key: "package_id", label: "Interested in", type: "select", options: [["", "—"], ...D.pkgs.map((p) => [p.id, p.name])] },
          { key: "message", label: "Notes", type: "textarea", full: true }],
          onSave: async (v) => { await q(sb.rpc("submit_lead", { p: { ...v, source: "manual" } })); toast("Lead added"); render(); } }); break;
      case "biz-open": openBiz(id); break;
      case "pay-ok": if (await confirmBox("Confirm this payment?", "Only confirm after you've seen the money in your bank account.", "Confirm payment")) { await q(sb.rpc("admin_confirm_payment", { p_payment: id, p_approve: true })); toast("Payment confirmed"); await loadStats(); render(); } break;
      case "pay-no": if (await confirmBox("Reject this payment?", "The business will see it as rejected and can pay again.", "Reject", { danger: true })) { await q(sb.rpc("admin_confirm_payment", { p_payment: id, p_approve: false })); toast("Payment rejected"); await loadStats(); render(); } break;
      case "pkg-new": pkgForm(); break;
      case "pkg-edit": pkgForm(D.pkgs.find((p) => p.id === id)); break;
      case "promo-new": promoForm(); break;
      case "promo-edit": promoForm(D.promos.find((p) => p.id === id)); break;
      case "cat-new": catForm(); break;
      case "cat-edit": catForm(D.cats.find((c) => c.id === id)); break;
      case "prod-new": prodForm(); break;
      case "prod-edit": prodForm(D.prods.find((p) => p.id === id)); break;
      case "kw-cat": KW_CAT = id; render(); break;
      case "ckw-del": await q(sb.from("category_keywords").delete().eq("id", id)); render(); break;
      case "pack-new": packForm(); break;
      case "pack-edit": packForm(D.packs.find((p) => p.id === id)); break;
      case "tpl-new": tplForm(); break;
      case "tpl-edit": tplForm(D.tpls.find((t) => t.id === id)); break;
      case "team-add": formModal({ title: "Add team member", fields: [{ key: "email", label: "Their account email", type: "email", required: true, full: true }, { key: "role", label: "Role", type: "select", options: [["team", "Team"], ["super_admin", "Super admin"]] }],
          onSave: async (v) => { await q(sb.rpc("set_user_role", { p_email: v.email, p_role: v.role })); toast("Team updated"); render(); } }); break;
      case "team-role": if (await confirmBox("Change role?", `${el.dataset.email} will become: ${el.dataset.role.replace("_", " ")}.`, "Change role", { danger: el.dataset.role === "customer" })) {
          await q(sb.rpc("set_user_role", { p_email: el.dataset.email, p_role: el.dataset.role })); toast("Role changed"); render(); } break;
    }
  } catch (err) { toast(err.message, "error"); }
});
