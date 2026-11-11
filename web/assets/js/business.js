// Business portal: everything a shop owner manages (customers, loyalty, reviews, offers, WhatsApp, billing)
import { sb, q } from "./sb.js";
import { $, $$, esc, inr, inr2, nfmt, fmtDate, fmtShort, fmtDT, ago, daysSince, daysToBirthday, todayISO, normPhone, prettyPhone, toast, copy,
  openModal, closeModal, modalOpen, confirmBox, formModal, ico, shell, barChart, statusPill, THEMES, rwLabel, rwShort, rewardAt, nextReward, loyaltyCard } from "./ui.js";
import { registerStaff } from "./staff.js";
import { registerMenu, newOrderCount } from "./menu-admin.js";
import { rzpOn, payOnline } from "./razorpay.js";
import { registerTeam, AREA_OF } from "./team.js";
import { registerAccounts } from "./accounts.js";
import { scanCard } from "./card-scan.js";

let C, D = {}, BID;
const gstOn = () => +(D.settings?.gst?.rate ?? 0) > 0;
const plusGst = () => (gstOn() ? " + GST" : "");
const trialLeft = () => (D.biz?.status === "trial" && D.biz.subscription_ends ? Math.round((new Date(D.biz.subscription_ends + "T23:59:59") - Date.now()) / 864e5) : null);
const trialOpen = () => D.biz?.status === "trial" && D.biz.subscription_ends >= todayISO();
const canWrite = () => D.biz?.status === "active" || trialOpen() || (["trial", "pending_payment"].includes(D.biz?.status) && D.payWaiting);
const waOn = () => !!D.biz?.wa_enabled;

// Which module each page belongs to. Pages without an entry are in every plan.
const ROUTE_MOD = { offers: "loyalty", loyalty: "loyalty", templates: "bulk_whatsapp", alerts: "campaigns", seo: "seo", replies: "google_replies", orders: "menu", menu: "menu", staff: "attendance", salary: "attendance", accounts: "accounting" };
// What this login may do: owner and admin everything, staff only the areas the owner ticked. The database checks the same.
const can = (area) => ["owner", "admin"].includes(D.me?.role) || (D.me?.perms || []).includes(area);
const allowed = (r) => r === "signout" || can(AREA_OF[r] || "customers");
const lockBadge = (r, badge) => (ROUTE_MOD[r] && !hasMod(ROUTE_MOD[r]) ? "🔒" : badge);
const item = (r, label, icon, badge = "") => [r, label, icon, lockBadge(r, badge)];
const ROUTES = () => [
  { label: "", items: [item("dashboard", "Dashboard", "dash"), item("customers", "Customers", "users"), item("feedback", "Reviews & feedback", "star", openComplaints() || ""), item("seo", "Keywords & SEO", "spark"),
    item("offers", "Offers & coupons", "tag"), item("loyalty", "Loyalty card", "card"), item("whatsapp", "WhatsApp & reminders", "wa"), item("templates", "Message templates", "send"), item("alerts", "Alerts", "bell", hasMod("campaigns") ? alerts().length || "" : "")] },
  { label: "Run the shop", items: [...(fitsBiz("menu") ? [item("orders", "Orders", "receipt", hasMod("menu") ? D.newOrders || "" : ""), item("menu", "QR menu", "food")] : []), item("staff", "Staff & attendance", "clock"), item("salary", "Salary", "rupee"), item("accounts", "Accounts & GST", "chart")] },
  { label: "Account", items: [["plan", "Plan & services", "box"], ["profile", "Business profile", "store"], ["team", "Team & logins", "shield"], ["signout", "Sign out", "out"]] },
].map((g) => ({ ...g, items: g.items.filter((i) => allowed(i[0])) })).filter((g) => g.items.length);
// On when: core module, in the plan, bought as an add-on, or on the free trial (everything unlocked). The database checks the same rule.
const hasMod = (m) => D.biz?.status === "trial" || !!(D.mods || []).find((x) => x.key === m && x.core) || (D.biz?.packages?.modules || []).includes(m) || (D.biz?.addon_modules || []).includes(m);
const modInfo = (k) => (D.mods || []).find((x) => x.key === k);
// Hide features that don't fit this kind of business (e.g. table ordering for a salon). Set per module in modules.categories.
const fitsBiz = (k) => { const m = modInfo(k), slug = D.biz?.categories?.slug; return !m?.categories || !slug || m.categories.includes(slug); };
const route = () => { const h = location.hash.slice(1).split("?")[0], all = ROUTES().flatMap((g) => g.items).map((r) => r[0]); return all.includes(h) ? h : all.includes("dashboard") ? "dashboard" : all[0]; };

export async function mount(ctx) {
  C = ctx;
  const m = await q(sb.from("business_members").select("business_id,role,perms").eq("user_id", C.user.id).order("created_at").limit(1));
  if (!m.length) { $("#main").innerHTML = `<div class="auth-wrap"><div class="auth"><h2>No business yet</h2><p>Choose a plan to set up your business.</p><a class="btn primary" href="index.html#pricing">See plans</a></div></div>`; return; }
  BID = m[0].business_id; D.me = { role: m[0].role, perms: m[0].perms || [] };
  window.addEventListener("hashchange", () => { if (location.hash === "#signout") return C.signOut(); render(); });
  await loadAll(); render();
  if (hasMod("menu")) {
    const tick = async () => { if (route() === "orders") return; try { const n = await newOrderCount(BID); if (n !== (D.newOrders || 0)) { D.newOrders = n; nav(); } } catch {} };
    tick(); setInterval(tick, 30000);
  }
}

async function loadAll() {
  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const [biz, customers, coupons, feedback, reminders, visits, prog, rewards, wallet, settings] = await Promise.all([
    q(sb.from("businesses").select("*, categories(id,name,icon,slug), packages(*)").eq("id", BID).single()),
    q(sb.from("customers").select("*").eq("business_id", BID).order("last_visit", { ascending: false, nullsFirst: false }).limit(5000)),
    q(sb.from("coupons").select("*").eq("business_id", BID).order("created_at", { ascending: false })),
    q(sb.from("feedback").select("*").eq("business_id", BID).order("created_at", { ascending: false }).limit(500)),
    q(sb.from("reminders").select("*").eq("business_id", BID).order("due")),
    q(sb.from("visits").select("*").eq("business_id", BID).gte("created_at", since).order("created_at", { ascending: false })),
    q(sb.from("loyalty_programs").select("*").eq("business_id", BID).maybeSingle()),
    q(sb.from("loyalty_rewards").select("*").eq("business_id", BID).order("visit_no")),
    q(sb.from("wa_wallets").select("balance,utility_balance").eq("business_id", BID).maybeSingle()),
    q(sb.from("settings").select("key,value").in("key", ["payment", "whatsapp", "agency", "gst", "razorpay"])),
  ]);
  D.mods = await q(sb.from("modules").select("*").eq("active", true).order("sort")).catch(() => []);
  D.payWaiting = (await q(sb.from("payments").select("id").eq("business_id", BID).eq("kind", "subscription").eq("status", "pending").not("utr", "is", null).limit(1))).length > 0;
  Object.assign(D, { biz, customers, coupons, feedback, reminders, visits, prog: prog || { enabled: false, name: "Loyalty card", stamps: 10, theme: "saffron" }, rewards, wallet: wallet?.balance ?? 0, walletU: wallet?.utility_balance ?? 0 });
  D.settings = Object.fromEntries(settings.map((s) => [s.key, s.value]));
}
async function reload(...keys) {
  const map = {
    biz: async () => (D.biz = await q(sb.from("businesses").select("*, categories(id,name,icon,slug), packages(*)").eq("id", BID).single())),
    customers: async () => (D.customers = await q(sb.from("customers").select("*").eq("business_id", BID).order("last_visit", { ascending: false, nullsFirst: false }).limit(5000))),
    coupons: async () => (D.coupons = await q(sb.from("coupons").select("*").eq("business_id", BID).order("created_at", { ascending: false }))),
    feedback: async () => (D.feedback = await q(sb.from("feedback").select("*").eq("business_id", BID).order("created_at", { ascending: false }).limit(500))),
    reminders: async () => (D.reminders = await q(sb.from("reminders").select("*").eq("business_id", BID).order("due"))),
    visits: async () => (D.visits = await q(sb.from("visits").select("*").eq("business_id", BID).gte("created_at", new Date(Date.now() - 60 * 864e5).toISOString()).order("created_at", { ascending: false }))),
    loyalty: async () => { D.prog = await q(sb.from("loyalty_programs").select("*").eq("business_id", BID).maybeSingle()); D.rewards = await q(sb.from("loyalty_rewards").select("*").eq("business_id", BID).order("visit_no")); },
    wallet: async () => { const w = await q(sb.from("wa_wallets").select("balance,utility_balance").eq("business_id", BID).maybeSingle()); D.wallet = w?.balance ?? 0; D.walletU = w?.utility_balance ?? 0; },
  };
  await Promise.all(keys.map((k) => map[k]()));
}

/* ---------- digital loyalty card link ---------- */
const cardUrl = (c) => new URL("c.html?t=" + c.card_token, location.href).href;
const cardMsg = (c) => `Hi ${(c.name || "there").split(" ")[0]}, here's your ${D.prog?.name || "loyalty card"} from ${D.biz.name}: ${cardUrl(c)}\nSave it on your phone and show the QR at the counter on every visit to collect stamps and rewards.`;
const waLink = (c) => `https://wa.me/${String(c.phone || "").replace(/\D/g, "")}?text=${encodeURIComponent(cardMsg(c))}`;
const mailLink = (c) => `mailto:${encodeURIComponent(c.email || "")}?subject=${encodeURIComponent(`Your ${D.prog?.name || "loyalty card"} from ${D.biz.name}`)}&body=${encodeURIComponent(cardMsg(c))}`;
const sendCardBtns = (c) => `<a class="btn sm wa" href="${esc(waLink(c))}" target="_blank" rel="noopener">${ico("wa")} WhatsApp card link</a><a class="btn sm" href="${esc(mailLink(c))}">✉️ Email${c.email ? "" : " (add address)"}</a><button class="btn sm ghost" data-a="card-copy" data-id="${c.id}">${ico("copy")} Copy link</button>`;
async function startScan() {
  const tok = await scanCard();
  if (!tok) return;
  try {
    const c = await q(sb.rpc("card_lookup", { p_business: BID, p_token: tok }));
    if (!c) { toast("This card isn't from your business", "error"); return; }
    visitModal({ phone: c.phone, name: c.name, scanned: c });
  } catch (e) { toast(e.message, "error"); }
}

/* ---------- derived ---------- */
const reviewLink = () => (D.biz.google_review_link || "").trim();
const fill = (tpl, c) => String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => ({ name: (c?.name || "there").split(" ")[0], business: D.biz.name, review_link: reviewLink() || "[add your Google review link]" }[k] ?? m));
const openComplaints = () => (D.feedback || []).filter((f) => f.status === "open").length;
const loyOn = () => !!D.prog?.enabled;
function segments() {
  const c = D.customers || [];
  return { all: ["All customers", c], birthday: ["Birthday in next 30 days", c.filter((x) => daysToBirthday(x.birthday) <= 30)], inactive: ["Not visited in 30+ days", c.filter((x) => daysSince(x.last_visit) >= 30)],
    noreview: ["Haven't reviewed yet", c.filter((x) => x.review_status !== "reviewed")], newbies: ["New (1 visit)", c.filter((x) => (x.visits || 0) <= 1)], loyal: ["Regulars (5+ visits)", c.filter((x) => (x.visits || 0) >= 5)],
    nearreward: ["One visit from final reward", c.filter((x) => loyOn() && (x.stamps || 0) === D.prog.stamps - 1)] };
}
const allTags = () => [...new Set((D.customers || []).flatMap((c) => c.tags || []))].sort();
const audience = (key) => (key?.startsWith("tag:") ? D.customers.filter((c) => (c.tags || []).includes(key.slice(4))) : (segments()[key] || [, []])[1]);
function couponStatus(k) {
  if (!k.active) return ["Paused", ""]; if (k.expiry && k.expiry < todayISO()) return ["Expired", "bad"];
  if (k.usage_limit && k.used >= k.usage_limit) return ["Used up", "warn"]; if (k.expiry && (new Date(k.expiry) - new Date()) / 864e5 < 7) return ["Ending soon", "warn"]; return ["Active", "good"];
}
const couponDeal = (k) => (k.type === "percent" ? `${+k.value}% off${+k.max_discount ? ` (up to ${inr(k.max_discount)})` : ""}` : `${inr(k.value)} off`);
function alerts() {
  if (!D.customers) return [];
  const out = [];
  if (D.biz.status === "pending_payment" && !D.payWaiting) out.push({ sev: "warn", kind: "pay", title: "Complete your payment to activate your plan", sub: "Your account is waiting for payment" });
  if (D.biz.status === "trial" && !D.payWaiting) { const l = trialLeft(); if (!trialOpen()) out.push({ sev: "bad", kind: "pay", title: "Your free trial has ended", sub: "Pay for your plan to keep using the app" }); else if (l <= 1) out.push({ sev: "warn", kind: "pay", title: l <= 0 ? "Your free trial ends today" : "Your free trial ends tomorrow", sub: "Pay now so nothing stops" }); }
  D.feedback.filter((f) => f.status === "open").forEach((f) => out.push({ sev: "bad", kind: "feedback", f, title: `Unhappy customer: ${f.name || "Walk-in"} rated ${f.rating}★`, sub: [(f.tags || []).join(", "), f.text].filter(Boolean).join(" · ") || "No details given" }));
  D.customers.forEach((c) => {
    const b = daysToBirthday(c.birthday); if (b <= 7) out.push({ sev: b === 0 ? "bad" : "warn", kind: "birthday", c, title: b === 0 ? `${c.name}'s birthday is today` : `${c.name}'s birthday in ${b} day${b > 1 ? "s" : ""}`, sub: "Send a birthday offer" });
    if (c.review_status === "requested" && daysSince(c.review_requested_at) >= 3) out.push({ sev: "info", kind: "followup", c, title: `Follow up on ${c.name}'s review`, sub: `Asked ${ago(c.review_requested_at)}` });
    if (daysSince(c.last_visit) >= 45 && (c.visits || 0) >= 2) out.push({ sev: "warn", kind: "winback", c, title: `${c.name} hasn't visited in ${daysSince(c.last_visit)} days`, sub: `${c.visits} past visits · ${inr(c.spend)} lifetime` });
    if (loyOn() && (c.stamps || 0) === D.prog.stamps - 1 && daysSince(c.last_visit) >= 7) out.push({ sev: "info", kind: "nearreward", c, title: `${c.name} is one visit from the final reward`, sub: `Last visit ${ago(c.last_visit)}` });
  });
  D.coupons.forEach((k) => { if (couponStatus(k)[0] === "Ending soon") out.push({ sev: "warn", kind: "coupon", k, title: `${k.code} expires ${fmtShort(k.expiry)}`, sub: `${k.used} used so far` }); });
  D.reminders.filter((r) => !r.done && r.due && r.due <= todayISO()).forEach((r) => out.push({ sev: "bad", kind: "reminder", r, title: r.text, sub: r.due < todayISO() ? "Overdue since " + fmtShort(r.due) : "Due today" }));
  const o = { bad: 0, warn: 1, info: 2 }; return out.sort((a, b) => o[a.sev] - o[b.sev]);
}

/* ---------- render ---------- */
function nav() {
  $("#nav").innerHTML = shell({ brandSub: "Growth Plan", groups: ROUTES(), current: route(),
    footer: `<div class="who-box"><b>${esc(D.biz.name)}</b><span>${esc(D.biz.packages?.name || "")} plan · ${esc(D.biz.status.replace("_", " "))}</span></div>` });
}
let pendingRender = false;
function render() {
  nav(); const r = route(), m = $("#main");
  if (!r) { m.innerHTML = `<div class="card empty" style="margin-top:40px">Your login doesn't have access to anything yet. Ask the owner to give you access under Team &amp; logins.</div>`; return; }
  const lock = ROUTE_MOD[r] && !hasMod(ROUTE_MOD[r]);
  m.innerHTML = banner() + (lock ? lockedView(ROUTE_MOD[r]) : VIEWS[r]()); !lock && after[r] && after[r](); m.scrollTop = 0;
}
function softRender() { const a = document.activeElement; if (a && $("#main").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { pendingRender = true; nav(); return; } render(); }
document.addEventListener("focusout", () => { if (pendingRender) setTimeout(() => { const a = document.activeElement; if (a && $("#main").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return; pendingRender = false; render(); }); });
function banner() {
  if (D.biz.status === "trial") {
    const left = trialLeft();
    if (trialOpen()) return `<div class="banner"><p><b>Free trial: ${left <= 0 ? "last day today" : `${left} day${left === 1 ? "" : "s"} left`}</b> (until ${fmtDate(D.biz.subscription_ends)}). Everything is unlocked. Pay for your plan any time to keep it running after the trial.</p><a class="btn primary" href="#plan">Pay now</a></div>`;
    if (D.payWaiting) return `<div class="banner"><p><b>Thanks, we've got your payment details.</b> Your account stays open while Branditude confirms the payment.</p></div>`;
    return `<div class="banner" style="border-color:var(--bad);background:var(--bad-soft)"><p><b>Your free trial has ended.</b> Your customers and data are safe. Pay for your plan to keep logging visits and sending offers.</p><a class="btn primary" href="#plan">Pay now</a></div>`;
  }
  if (D.biz.status === "pending_payment" && D.payWaiting) return `<div class="banner"><p><b>Thanks, we've got your payment details.</b> You can use everything while Branditude confirms the payment.</p></div>`;
  if (D.biz.status === "pending_payment") return `<div class="banner"><p><b>Your plan isn't active yet.</b> You can set things up now. Pay for your plan and we'll activate it as soon as the payment is confirmed.</p><a class="btn primary" href="#plan">Pay now</a></div>`;
  if (D.biz.status === "paused") return `<div class="banner" style="border-color:var(--bad);background:var(--bad-soft)"><p><b>Your account is paused.</b> You can view your data but not make changes. Renew your plan or contact Branditude.</p><a class="btn" href="#plan">Renew</a></div>`;
  if (D.biz.status === "cancelled") return `<div class="banner" style="border-color:var(--bad);background:var(--bad-soft)"><p><b>Your plan is cancelled.</b> Choose a plan to start again.</p><a class="btn" href="#plan">See plans</a></div>`;
  if (D.biz.status === "active" && D.biz.subscription_ends && daysSince(D.biz.subscription_ends) > -5) return `<div class="banner"><p><b>Your plan renews ${fmtDate(D.biz.subscription_ends)}.</b> Pay now so nothing stops.</p><a class="btn primary" href="#plan">Renew</a></div>`;
  return "";
}
const head = (t, p, actions = "") => `<div class="page-head"><div><h1>${t}</h1>${p ? `<p>${p}</p>` : ""}</div><div class="row">${actions}</div></div>`;
const kpi = (label, value, sub = "") => `<div class="card kpi"><div class="label">${label}</div><div class="value num">${value}</div><div class="sub">${sub}</div></div>`;
const waBtn = (label, attrs, cls = "sm") => (waOn() ? `<button class="btn ${cls} wa" ${attrs}>${ico("wa")} ${label}</button>` : "");
const after = {};
const VIEWS = {};

/* ---------- Dashboard ---------- */
VIEWS.dashboard = () => {
  const v = D.visits, c = D.customers;
  const v30 = v.filter((x) => daysSince(x.created_at) < 30), rev = v30.reduce((a, x) => a + +x.net, 0), prev = v.filter((x) => daysSince(x.created_at) >= 30).reduce((a, x) => a + +x.net, 0);
  const delta = prev ? Math.round(((rev - prev) / prev) * 100) : null, repeat = c.length ? Math.round((c.filter((x) => x.visits > 1).length / c.length) * 100) : 0;
  const reviewed = c.filter((x) => x.review_status === "reviewed").length, asked = c.filter((x) => x.review_status !== "none").length;
  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (13 - i)); const e = new Date(d.getTime() + 864e5);
    return { label: i === 13 ? "Today" : fmtShort(d), value: v.filter((x) => { const t = new Date(x.created_at); return t >= d && t < e; }).reduce((a, x) => a + +x.net, 0) }; });
  const setup = [["Add your Google review link", !!reviewLink(), "#profile"], ["Log your first visit", v.length > 0, "#dashboard"], ["Set up your loyalty card", D.rewards.length > 0, "#loyalty"], ["Create a coupon", D.coupons.length > 0, "#offers"], ["Print your feedback QR code", false, "#feedback"]];
  const al = alerts().slice(0, 5);
  return head(`Hello, ${esc(D.biz.name)}`, "Log every visit. It builds your customer list, stamps loyalty cards and brings in reviews.", `<button class="btn primary" data-a="visit" ${canWrite() ? "" : "disabled"}>${ico("plus")} Log a visit</button><button class="btn" data-a="scan" ${canWrite() ? "" : "disabled"}>${ico("grid")} Scan card</button><button class="btn" data-a="kiosk">${ico("smile")} Feedback screen</button>`) + `
  <div class="grid g4">${kpi("Revenue logged · 30 days", inr(rev), delta === null ? `${v30.length} visits` : `<span class="pill ${delta >= 0 ? "good" : "bad"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}%</span> vs previous 30 days`)}
    ${kpi("Customers", nfmt(c.length), `${repeat}% come back`)}${(() => { const f30 = (D.feedback || []).filter((f) => daysSince(f.created_at) < 30); return kpi("Average rating · 30 days", f30.length ? (f30.reduce((a, f) => a + f.rating, 0) / f30.length).toFixed(1) + " ★" : "–", f30.length ? `${f30.length} ratings · ${f30.filter((f) => f.rating <= 3).length} need attention` : "Use the feedback screen"); })()}
    ${kpi("Loyalty rewards · 30 days", v30.filter((x) => x.loyalty_reward).length, inr(v30.reduce((a, x) => a + +x.discount, 0)) + " discounts given")}</div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><div class="card-head"><h2>Daily revenue, last 14 days</h2></div>${barChart(days)}</div>
    <div class="card"><div class="card-head"><h2>Needs your attention</h2><a class="btn sm ghost" href="#alerts">See all</a></div>${al.length ? `<div class="list">${al.map(alertRow).join("")}</div>` : `<div class="empty">All clear.</div>`}</div>
  </div>
  ${setup.some((s) => !s[1]) ? `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Get set up</h2><span class="pill acc">${setup.filter((s) => s[1]).length} of ${setup.length}</span></div><div class="steps">${setup.map((s, i) => `<a class="step ${s[1] ? "done" : ""}" href="${s[2]}" style="text-decoration:none;color:inherit"><div class="dot">${s[1] ? "✓" : i + 1}</div><span>${s[0]}</span></a>`).join("")}</div></div>` : ""}`;
};
function alertRow(a) {
  let act = "";
  if (a.kind === "feedback") act = `<a class="btn sm" href="#feedback">Respond</a>`;
  else if (a.kind === "pay") act = `<a class="btn sm primary" href="#plan">Pay</a>`;
  else if (a.kind === "followup") act = `<button class="btn sm" data-a="mark-reviewed" data-id="${a.c.id}">Mark reviewed</button>`;
  else if (a.kind === "reminder") act = `<button class="btn sm" data-a="rem-done" data-id="${a.r.id}">Done</button>`;
  else if (a.kind === "coupon") act = waBtn("Remind", `data-a="wa-compose" data-aud="all"`);
  else if (a.c) act = waBtn(a.kind === "birthday" ? "Wish" : a.kind === "nearreward" ? "Send card" : "Invite back", `data-a="wa-one" data-id="${a.c.id}" data-tpl="${a.kind === "birthday" ? "birthday_wish" : a.kind === "nearreward" ? "loyalty_update" : "we_miss_you"}"`) || `<button class="btn sm" data-a="card" data-id="${a.c.id}">View</button>`;
  return `<div class="item"><div class="stripe ${a.sev}"></div><div class="grow"><b>${esc(a.title)}</b><span class="muted small">${esc(a.sub)}</span></div>${act}</div>`;
}

/* ---------- Customers ---------- */
let custQ = "", custSeg = "all";
VIEWS.customers = () => {
  const sg = segments();
  return head("Customers", "Your own customer list. Loyalty stamps and rewards are tracked for each customer.", `<button class="btn" data-a="import" ${canWrite() ? "" : "disabled"}>Import list</button><button class="btn" data-a="export">${ico("copy")} Copy as CSV</button><button class="btn" data-a="scan" ${canWrite() ? "" : "disabled"}>${ico("grid")} Scan card</button><button class="btn primary" data-a="cust-new" ${canWrite() ? "" : "disabled"}>${ico("plus")} Add customer</button>`) + `
  <input id="cust-q" type="search" placeholder="Search by name, phone or tag" value="${esc(custQ)}" style="margin-bottom:12px" aria-label="Search customers">
  <div class="chips" style="margin-bottom:16px">${Object.entries(sg).map(([k, [l, list]]) => `<button class="chip" data-a="seg" data-id="${k}" aria-pressed="${custSeg === k}">${l} <span class="num">${list.length}</span></button>`).join("")}${allTags().map((t) => `<button class="chip" data-a="seg" data-id="tag:${esc(t)}" aria-pressed="${custSeg === "tag:" + t}">#${esc(t)}</button>`).join("")}</div>
  <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Visits</th><th>Spent</th><th>Last visit</th><th>Loyalty</th><th>Review</th><th style="text-align:right">Actions</th></tr></thead><tbody id="cust-rows"></tbody></table></div>`;
};
after.customers = () => {
  const draw = () => {
    const qv = custQ.trim().toLowerCase(); const rv = { reviewed: ["Reviewed", "good"], requested: ["Asked", "info"], none: ["Not asked", ""] };
    const list = audience(custSeg).filter((c) => !qv || [c.name, c.phone, (c.tags || []).join(" ")].join(" ").toLowerCase().includes(qv));
    $("#cust-rows").innerHTML = list.length ? list.slice(0, 500).map((c) => `<tr><td><div class="who"><b>${esc(c.name)}</b><span class="num">${esc(prettyPhone(c.phone))}</span>${(c.tags || []).length ? `<div class="chips" style="margin-top:4px">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}</div></td>
      <td class="num">${c.visits}</td><td class="num">${inr(c.spend)}</td><td>${ago(c.last_visit)}</td>
      <td>${loyOn() ? `<button class="btn sm" data-a="card" data-id="${c.id}">${ico("card")} ${Math.min(c.stamps, D.prog.stamps)}/${D.prog.stamps}</button>` : "—"}</td>
      <td><span class="pill ${rv[c.review_status][1]}">${rv[c.review_status][0]}</span></td>
      <td><div class="row" style="justify-content:flex-end;flex-wrap:nowrap">${waBtn("", `data-a="wa-one" data-id="${c.id}" title="Send WhatsApp"`)}<button class="btn sm ghost" data-a="cust-edit" data-id="${c.id}">Edit</button></div></td></tr>`).join("")
      : `<tr><td colspan="7"><div class="empty">${D.customers.length ? "No customers match." : "No customers yet. Log a visit or import your list."}</div></td></tr>`;
  };
  $("#cust-q").oninput = (e) => { custQ = e.target.value; draw(); }; draw();
};

/* ---------- Reviews ---------- */
VIEWS.reviews = () => {
  const c = D.customers, link = reviewLink(), toAsk = c.filter((x) => x.review_status === "none"), asked = c.filter((x) => x.review_status === "requested"), done = c.filter((x) => x.review_status === "reviewed");
  return head("Google reviews", "Ask every customer. Happy ones review you on Google. Unhappy ones can tell you privately first through the feedback screen or link.") + `
  <div class="grid g4">${kpi("Never asked", toAsk.length, "customers")}${kpi("Asked, waiting", asked.length, "")}${kpi("Reviewed", done.length, (asked.length + done.length ? Math.round((done.length / (asked.length + done.length)) * 100) : 0) + "% of people asked")}</div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><div class="card-head"><h2>Your review link</h2>${link ? '<span class="pill good">Set</span>' : '<span class="pill warn">Not set</span>'}</div>
      ${link ? `<div class="row" style="align-items:flex-start;gap:18px"><div class="qr" id="qr-review"></div><div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:10px"><p class="small muted">Print this for your counter or bill folder. It opens your Google review form.</p><p class="small" style="word-break:break-all">${esc(link)}</p><div class="row"><button class="btn sm" data-a="copy" data-text="${esc(link)}">${ico("copy")} Copy link</button><a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener">Test</a></div></div></div>`
      : `<p class="muted" style="margin-bottom:12px">Copy it from Google Business Profile → <b>Ask for reviews</b>.</p><a class="btn primary" href="#profile">Add review link</a>`}</div>
    <div class="card"><div class="card-head"><h2>Waiting for review</h2></div>${asked.length ? `<div class="list">${asked.map((x) => `<div class="item"><div class="grow"><b>${esc(x.name)}</b><span class="muted small">Asked ${ago(x.review_requested_at)}</span></div>${waBtn("Remind", `data-a="wa-one" data-id="${x.id}" data-tpl="review_request"`)}<button class="btn sm" data-a="mark-reviewed" data-id="${x.id}">Reviewed ✓</button></div>`).join("")}</div>` : `<div class="empty">No pending requests.</div>`}</div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Ask for a review</h2><span class="muted small">most recent visitors first</span></div>
    ${toAsk.length ? `<div class="list">${toAsk.slice(0, 20).map((x) => `<div class="item"><div class="grow"><b>${esc(x.name)}</b><span class="muted small">Visited ${ago(x.last_visit)}</span></div>${waBtn("Ask on WhatsApp", `data-a="wa-one" data-id="${x.id}" data-tpl="review_request"`)}<button class="btn sm" data-a="mark-asked" data-id="${x.id}">Asked in person</button></div>`).join("")}</div>` : `<div class="empty">Everyone has been asked.</div>`}
    ${waOn() ? "" : `<div class="note" style="margin-top:12px">Turn on the WhatsApp add-on to send review requests on WhatsApp. <a href="#whatsapp">See how</a></div>`}</div>`;
};
after.reviews = () => { const el = $("#qr-review"); if (el && window.QRCode) new QRCode(el, { text: reviewLink(), width: 150, height: 150, colorDark: "#16203a", colorLight: "#ffffff" }); };

/* ---------- Feedback ---------- */
const feedbackLink = () => new URL("f.html?b=" + D.biz.slug, location.href).href;
VIEWS.feedback = () => {
  const fb = D.feedback, f30 = fb.filter((f) => daysSince(f.created_at) < 30), avg = f30.length ? f30.reduce((a, f) => a + f.rating, 0) / f30.length : 0;
  const open = fb.filter((f) => f.status === "open"), stars = (n) => `<span class="stars-txt">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;
  return head("Reviews &amp; feedback", "Every customer rates you on your own feedback screen or link. Unhappy customers reach you privately first, so you can fix it the same day.", `<button class="btn primary" data-a="kiosk">${ico("smile")} Open feedback screen</button>`) + `
  <div class="grid g4">${kpi("Average rating · 30 days", f30.length ? avg.toFixed(1) : "–", `${f30.length} ratings`)}${kpi("Happy customers", f30.filter((f) => f.rating >= 4).length, `${f30.filter((f) => f.opened_google).length} opened Google`)}${kpi("Problems caught privately", f30.filter((f) => f.rating <= 3).length, "rated 3★ or below")}${kpi("Open issues", open.length, open.length ? "reply today" : "all handled")}</div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><div class="card-head"><h2>Needs a reply</h2><span class="pill ${open.length ? "bad" : "good"}">${open.length}</span></div>
      ${open.length ? `<div class="list">${open.map((f) => `<div class="item" style="align-items:flex-start"><div class="stripe bad"></div><div class="grow"><b>${esc(f.name || "Walk-in customer")} ${stars(f.rating)}</b><span class="muted small">${ago(f.created_at)} · ${esc(f.source)}${f.phone ? " · " + esc(prettyPhone(f.phone)) : ""}</span>${(f.tags || []).length ? `<div class="chips" style="margin:6px 0">${f.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}${f.text ? `<p>“${esc(f.text)}”</p>` : ""}
        <div class="row" style="margin-top:8px">${f.phone ? `<a class="btn sm" href="tel:+${esc(f.phone)}">Call ${esc(prettyPhone(f.phone))}</a>` : ""}<button class="btn sm" data-a="fb-resolve" data-id="${f.id}">Mark resolved</button></div></div></div>`).join("")}</div>` : `<div class="empty">No open complaints.</div>`}</div>
    <div class="card"><div class="card-head"><h2>Your feedback link & QR</h2></div>
      <div class="row" style="align-items:flex-start;gap:18px"><div class="qr" id="qr-fb"></div><div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:10px">
        <p class="small muted">Print this on bills and table tents. Customers rate you on their own phone. 4–5★ go to your Google review page, and 1–3★ come to this inbox.</p>
        <p class="small" style="word-break:break-all">${esc(feedbackLink())}</p><div class="row"><button class="btn sm" data-a="copy" data-text="${esc(feedbackLink())}">${ico("copy")} Copy link</button><a class="btn sm" href="${esc(feedbackLink())}" target="_blank" rel="noopener">Open</a></div></div></div>
      <div class="note" style="margin-top:14px">Everyone can still post on Google from the feedback screen. Google and India's review standard (IS 19000) don't allow hiding the review option from unhappy customers, so we never do.</div></div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>All feedback</h2></div>
    ${fb.length ? `<div class="list">${fb.slice(0, 50).map((f) => `<div class="item"><div class="grow"><b>${esc(f.name || "Walk-in customer")} ${stars(f.rating)}</b><span class="muted small">${fmtDT(f.created_at)} · ${esc(f.source)}${f.text ? " · “" + esc(f.text) + "”" : ""}</span></div>${statusPill(f.status)}${f.status === "resolved" ? `<button class="btn sm ghost" data-a="fb-reopen" data-id="${f.id}">Reopen</button>` : ""}</div>`).join("")}</div>` : `<div class="empty">No feedback yet.</div>`}</div>`;
};
after.feedback = () => { const el = $("#qr-fb"); if (el && window.QRCode) new QRCode(el, { text: feedbackLink(), width: 150, height: 150, colorDark: "#16203a", colorLight: "#ffffff" }); };

/* ---------- Offers ---------- */
VIEWS.offers = () => {
  const v30 = D.visits.filter((x) => x.coupon_code && daysSince(x.created_at) < 30);
  return head("Offers & coupons", "Codes for festivals, birthdays and win-backs. If a customer also has a loyalty reward that visit, whichever is worth more is used.", `<button class="btn primary" data-a="coupon-new" ${canWrite() ? "" : "disabled"}>${ico("plus")} New coupon</button>`) + `
  <div class="grid g4" style="margin-bottom:16px">${kpi("Active coupons", D.coupons.filter((k) => ["Active", "Ending soon"].includes(couponStatus(k)[0])).length, `of ${D.coupons.length}`)}${kpi("Sales with a coupon · 30 days", inr(v30.reduce((a, v) => a + +v.net, 0)), `${v30.length} redemptions`)}${kpi("Discount given · 30 days", inr(v30.reduce((a, v) => a + +v.discount, 0)), "")}</div>
  ${D.coupons.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${D.coupons.map((k) => { const [s, cls] = couponStatus(k); return `<div class="coupon">
    <div class="row" style="justify-content:space-between"><span class="code">${esc(k.code)}</span><span class="pill ${cls}">${s}</span></div>
    <div><div class="deal">${esc(couponDeal(k))}</div><div class="muted small">${esc(k.title || "")}${+k.min_bill ? " · min bill " + inr(k.min_bill) : ""}${k.expiry ? " · till " + fmtShort(k.expiry) : ""}${k.show_to_customers ? " · shown in customer app" : ""}</div></div>
    <div class="small">${k.used} used${k.usage_limit ? " of " + k.usage_limit : ""}</div>${k.usage_limit ? `<div class="bar"><i style="width:${Math.min(100, Math.round((k.used / k.usage_limit) * 100))}%"></i></div>` : ""}
    <div class="row">${waBtn("Broadcast", `data-a="wa-compose" data-aud="all"`)}<button class="btn sm" data-a="coupon-edit" data-id="${k.id}">Edit</button></div></div>`; }).join("")}</div>` : `<div class="card empty">No coupons yet.</div>`}`;
};

/* ---------- Loyalty ---------- */
let LD = null;
const draftFrom = () => { const N = D.prog?.stamps || 10; return { enabled: D.prog?.enabled ?? true, name: D.prog?.name || "Loyalty card", stamps: N, theme: D.prog?.theme || "saffron",
  final: { ...(rewardAt(D.rewards, N) || { type: "free", value: 0, max_discount: 0, note: "Free gift" }) }, mids: D.rewards.filter((r) => r.visit_no < N).map((r) => ({ ...r })) }; };
const compiled = (d = LD) => { const seen = new Set(); return { enabled: d.enabled, name: d.name, stamps: d.stamps, theme: d.theme,
  rewards: [...d.mids.filter((r) => r.visit_no >= 1 && r.visit_no < d.stamps && !seen.has(r.visit_no) && seen.add(r.visit_no)), { ...d.final, visit_no: d.stamps }] }; };
const sample = (N) => ({ name: "Priya Sharma", phone: "919876543210", stamps: Math.min(3, N - 1) });
const typeOpts = (v) => [["percent", "% off"], ["flat", "₹ off"], ["free", "Free item"]].map(([k, l]) => `<option value="${k}" ${v === k ? "selected" : ""}>${l}</option>`).join("");
const valLabel = (t) => (t === "percent" ? "Percent" : t === "flat" ? "Amount ₹" : "Worth up to ₹");
VIEWS.loyalty = () => {
  if (!LD) LD = draftFrom(); const d = LD, N = d.stamps, L = compiled(), used = new Set(d.mids.map((r) => r.visit_no));
  const holders = D.customers.filter((c) => c.stamps > 0 || c.cards_completed).sort((a, b) => b.stamps - a.stamps);
  return head("Loyalty card", "Choose how many visits fill a card, rewards on any visit along the way, and the big reward at the end. Rewards apply automatically when you log a visit. Customers can see their card in the customer app.") + `
  <div class="grid g4" style="margin-bottom:16px">${kpi("Card holders", holders.length, `of ${D.customers.length} customers`)}${kpi("Rewards given · 30 days", D.visits.filter((v) => v.loyalty_reward && daysSince(v.created_at) < 30).length, "")}${kpi("Cards completed", D.customers.reduce((a, c) => a + c.cards_completed, 0), "")}${kpi("One visit from final reward", D.customers.filter((c) => c.stamps === (D.prog?.stamps || 0) - 1).length, "")}</div>
  <div class="grid g2">
    <form class="card" id="ly-form" onsubmit="return false">
      <div class="card-head"><h2>Card settings</h2><label class="check" style="margin:0"><input type="checkbox" id="ly-on" ${d.enabled ? "checked" : ""}> Program on</label></div>
      <div class="fields"><div class="field"><label for="ly-name">Card name</label><input id="ly-name" value="${esc(d.name)}"></div><div class="field"><label for="ly-n">Visits to complete the card</label><input id="ly-n" type="number" min="2" max="20" value="${N}"></div></div>
      <div class="field" style="margin-top:14px"><label>Card colour</label><div class="row">${Object.entries(THEMES).map(([k, c]) => `<button type="button" class="swatch" data-a="ly-theme" data-id="${k}" aria-label="${k}" aria-pressed="${d.theme === k}" style="background:linear-gradient(140deg,${c[0]},${c[1]})"></button>`).join("")}</div></div>
      <h3 style="margin:22px 0 4px">Rewards along the way</h3><p class="small muted">e.g. 1st visit 10% off, 3rd visit ₹100 off, 5th visit a free dessert</p>
      <div>${d.mids.map((r, i) => `<div class="ly-row" data-mid="${i}"><select data-ly="visit" aria-label="Visit number">${[...Array(N - 1)].map((_, k) => k + 1).map((v) => `<option value="${v}" ${r.visit_no === v ? "selected" : ""} ${used.has(v) && r.visit_no !== v ? "disabled" : ""}>Visit ${v}</option>`).join("")}</select>
        <select data-ly="type" aria-label="Reward type">${typeOpts(r.type)}</select><input data-ly="value" type="number" min="0" value="${esc(r.value)}" aria-label="${valLabel(r.type)}"><input data-ly="note" class="ly-note" value="${esc(r.note || "")}" placeholder="Shown to customer, e.g. Free dessert" aria-label="Reward text">
        <button type="button" class="btn sm ghost danger" data-a="ly-del" data-id="${i}" aria-label="Remove">✕</button></div>`).join("") || `<p class="muted small" style="padding:8px 0">None yet.</p>`}</div>
      <button type="button" class="btn sm" data-a="ly-add" style="margin-top:10px" ${used.size >= N - 1 ? "disabled" : ""}>${ico("plus")} Add a visit reward</button>
      <h3 style="margin:22px 0 4px">🏆 Final reward on visit ${N}</h3><p class="small muted">After this the card starts again.</p>
      <div class="fields" style="margin-top:8px"><div class="field"><label for="ly-f-type">Type</label><select id="ly-f-type">${typeOpts(d.final.type)}</select></div><div class="field"><label for="ly-f-val">${valLabel(d.final.type)}</label><input id="ly-f-val" type="number" min="0" value="${esc(d.final.value)}"></div>
        ${d.final.type === "percent" ? `<div class="field"><label for="ly-f-max">Max discount ₹</label><input id="ly-f-max" type="number" min="0" value="${esc(+d.final.max_discount || "")}"></div>` : ""}
        <div class="field" style="grid-column:1/-1"><label for="ly-f-note">Shown to customer</label><input id="ly-f-note" value="${esc(d.final.note || "")}" placeholder="e.g. Free meal for two"></div></div>
      <div class="modal-foot" style="justify-content:flex-start"><button type="button" class="btn primary" data-a="ly-save" ${canWrite() ? "" : "disabled"}>Save loyalty card</button><button type="button" class="btn ghost" data-a="ly-reset">Undo changes</button></div>
    </form>
    <div class="card"><div class="card-head"><h2>What customers see</h2><span class="muted small">example: 3 visits</span></div><div id="ly-preview" style="display:flex;justify-content:center">${loyaltyCard({ bizName: D.biz.name, prog: L, rewards: L.rewards, customer: sample(N) })}</div></div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Card holders</h2></div>${holders.length ? `<div class="list">${holders.slice(0, 50).map((c) => { const st = Math.min(c.stamps, D.prog.stamps), nx = nextReward(st, D.prog, D.rewards);
    return `<div class="item"><div class="grow"><b>${esc(c.name)}</b><span class="muted small">${nx ? (nx.visit === st + 1 ? "Next visit: " : `Visit ${nx.visit}: `) + esc(rwLabel(nx.r)) : "Card complete"}${c.cards_completed ? ` · ${c.cards_completed} completed` : ""}</span><div class="bar" style="margin-top:6px;max-width:280px"><i style="width:${Math.round((st / D.prog.stamps) * 100)}%"></i></div></div><span class="num small">${st}/${D.prog.stamps}</span><button class="btn sm" data-a="card" data-id="${c.id}">View card</button></div>`; }).join("")}</div>` : `<div class="empty">Stamps appear as you log visits.</div>`}</div>`;
};
function lyRead() {
  if (!$("#ly-form")) return; const d = LD;
  d.enabled = $("#ly-on").checked; d.name = $("#ly-name").value; d.stamps = Math.max(2, Math.min(20, parseInt($("#ly-n").value, 10) || d.stamps));
  d.final = { type: $("#ly-f-type").value, value: +$("#ly-f-val").value || 0, max_discount: +($("#ly-f-max")?.value || 0), note: $("#ly-f-note").value };
  d.mids = $$("[data-mid]").map((row) => ({ visit_no: +row.querySelector("[data-ly=visit]").value, type: row.querySelector("[data-ly=type]").value, value: +row.querySelector("[data-ly=value]").value || 0, max_discount: 0, note: row.querySelector("[data-ly=note]").value }));
}
const lyPreview = () => { const L = compiled(); $("#ly-preview").innerHTML = loyaltyCard({ bizName: D.biz.name, prog: L, rewards: L.rewards, customer: sample(L.stamps) }); };
after.loyalty = () => {
  const f = $("#ly-form");
  f.addEventListener("input", (e) => { if (e.target.tagName === "INPUT" && e.target.type !== "checkbox" && e.target.id !== "ly-n") { lyRead(); lyPreview(); } });
  f.addEventListener("change", (e) => { lyRead(); if (e.target.tagName === "SELECT" || e.target.id === "ly-n") render(); else lyPreview(); });
};
function cardModal(c) {
  openModal(`<div class="modal-head"><h2>${esc(c.name)}'s loyalty card</h2><button class="btn ghost" data-close>Close</button></div>
    <div style="display:flex;justify-content:center">${loyaltyCard({ bizName: D.biz.name, prog: D.prog, rewards: D.rewards, customer: c })}</div>
    <div class="note" style="margin-top:14px"><b>Their own digital card.</b> Send this link once. It always shows their latest stamps, and staff scan its QR at the counter to add a visit.</div>
    <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px">${sendCardBtns(c)}</div>
    <div class="modal-foot"><button class="btn" data-a="card-full" data-id="${c.id}">Show full screen</button>${waBtn("Send stamp update", `data-a="wa-one" data-id="${c.id}" data-tpl="loyalty_update"`, "")}</div>`);
}

/* ---------- WhatsApp ---------- */
let WA = { aud: "all", tpl: null, params: [] };
// Two kinds of WhatsApp credits, matching Meta's message categories
const CREDIT = {
  marketing: { name: "Promotional credits", short: "promotional", for: "Offers and coupons, festival greetings, birthday wishes, \u201cwe miss you\u201d messages and Google review requests." },
  utility: { name: "Utility credits", short: "utility", for: "Loyalty stamp and reward updates, and service updates like order or appointment confirmations. Much cheaper." },
};
const kindOf = (t) => (t?.category === "utility" ? "utility" : "marketing");
const balOf = (t) => (kindOf(t) === "utility" ? D.walletU || 0 : D.wallet || 0);
const balText = () => `<b class="num">${nfmt(D.wallet || 0)}</b> promotional · <b class="num">${nfmt(D.walletU || 0)}</b> utility credits`;
/* Type your own quantity of each credit type */
const customBuy = () => { const r = D.waRates; if (!r) return "";
  const row = (k, id) => `<div class="field"><label for="${id}">${CREDIT[k].name} <span class="muted small num">${inr2(+r[k])} each</span></label><input id="${id}" type="number" min="0" step="1" inputmode="numeric" placeholder="0"><span class="small muted">${esc(CREDIT[k].for)}</span></div>`;
  return `<div class="card" style="background:var(--surface-2, #f7f7f5);box-shadow:none;margin-top:10px"><h3 style="margin:0 0 4px">Buy exactly what you need</h3><p class="small muted" style="margin:0 0 12px">Type how many of each. Packs below cost less per message.</p>
    <div class="fields">${row("marketing", "cb-m")}${row("utility", "cb-u")}</div>
    <div class="row" style="justify-content:space-between;margin-top:12px;gap:10px;flex-wrap:wrap"><span id="cb-total" class="num">Total: <b>${inr2(0)}</b>${plusGst()}</span>
    <button class="btn primary" data-a="buy-custom" ${D.biz.status === "active" ? "" : "disabled"}>Buy credits</button></div><p id="cb-err" class="small" style="color:var(--bad);margin:6px 0 0"></p></div>`; };
const customTotal = () => { const r = D.waRates || {}, m = Math.max(0, Math.floor(+($("#cb-m")?.value || 0))), u = Math.max(0, Math.floor(+($("#cb-u")?.value || 0)));
  return { m, u, total: Math.round((m * +r.marketing + u * +r.utility) * 100) / 100 }; };
document.addEventListener("input", (e) => { if (e.target.id === "cb-m" || e.target.id === "cb-u") { const t = $("#cb-total"); if (t) t.innerHTML = `Total: <b>${inr2(customTotal().total)}</b>${plusGst()}`; } });
const packGroups = (packs, compact = false) => ["marketing", "utility"].map((k) => { const list = packs.filter((p) => (p.kind || "marketing") === k); if (!list.length) return "";
  return `<div style="margin-top:${compact ? 10 : 16}px"><h3 style="margin:0 0 2px">${CREDIT[k].name}</h3><p class="small muted" style="margin:0 0 10px">For: ${esc(CREDIT[k].for)}</p>
    ${compact ? `<div class="list">${list.map((p) => `<div class="item"><div class="grow"><b>${esc(p.name)}</b><span class="muted small num">${nfmt(p.credits)} messages · ${inr2(p.price / p.credits)}/message</span></div><b class="num">${inr(p.price)}${plusGst()}</b><button class="btn sm primary" data-a="buy-pack" data-id="${p.id}">Buy</button></div>`).join("")}</div>`
      : `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr))">${list.map((p) => `<div class="coupon" style="border-style:solid"><b style="font-size:16px">${esc(p.name)}</b><div class="num"><b style="font-size:22px">${nfmt(p.credits)}</b> messages</div><div class="muted small num">${inr(p.price)}${plusGst()} · ${inr2(p.price / p.credits)}/message</div><button class="btn sm primary" data-a="buy-pack" data-id="${p.id}" ${D.biz.status === "active" ? "" : "disabled"}>Buy</button></div>`).join("")}</div>`}</div>`; }).join("");
VIEWS.whatsapp = () => `<div id="wa-view"><div class="loading"><span class="spinner"></span></div></div>`;
after.whatsapp = async () => {
  const [packs, tpls, bcs, ledger] = await Promise.all([
    q(sb.from("wa_credit_packs").select("*").eq("active", true).order("sort")), q(sb.from("wa_templates").select("*").eq("active", true).order("created_at")),
    q(sb.from("broadcasts").select("*").eq("business_id", BID).order("created_at", { ascending: false }).limit(20)), q(sb.from("wa_ledger").select("*").eq("business_id", BID).order("created_at", { ascending: false }).limit(15)),
  ]);
  D.tpls = tpls; D.packs = packs;
  D.waRates = await q(sb.rpc("wa_custom_rates")).catch(() => null);
  const note = D.settings.whatsapp?.price_note || "";
  const packsHtml = customBuy() + packGroups(packs);
  const el = $("#wa-view"); if (!el) return;
  D.autoRules = await q(sb.from("auto_msgs").select("*").eq("business_id", BID)).catch(() => []);
  D.autoPrev = await q(sb.rpc("auto_msgs_preview", { p_business: BID })).catch(() => ({}));
  D.autoLog = await q(sb.from("auto_msg_log").select("kind,status,created_at").eq("business_id", BID).order("created_at", { ascending: false }).limit(200)).catch(() => []);
  const promo = packs.filter((p) => (p.kind || "marketing") === "marketing"), perMsg = promo.length ? [Math.min(...promo.map((p) => p.price / p.credits)), Math.max(...promo.map((p) => p.price / p.credits))] : null;
  D.perMsg = perMsg;
  if (!waOn()) {
    el.innerHTML = head("WhatsApp & reminders", "Optional. Birthday wishes, loyalty and offer reminders, and messages to single customers from a verified WhatsApp business number.") + `
    <div class="card"><div class="card-head"><h2>Charges</h2><span class="pill">Off</span></div><p><b>Charges apply per message.</b> Buy prepaid credits; each message uses 1 credit of its type. <b>Promotional</b> messages (offers, wishes, review requests) use promotional credits; <b>utility</b> messages (loyalty and service updates) use the cheaper utility credits. Failed messages are refunded automatically.</p>
    ${D.biz.status === "active" ? "" : `<p class="note" style="margin-top:10px">Your plan needs to be active before you can buy credits.</p>`}<div style="margin-top:16px">${packsHtml}</div>
    <p class="small muted" style="margin-top:12px">Buying your first pack switches WhatsApp on once the payment is confirmed. You can set up reminders below now; nothing is sent until you have credits.</p></div>
    ${remindersCard()}${bulkUpsell()}`;
    return;
  }
  if (!hasMod("bulk_whatsapp")) {
    el.innerHTML = head("WhatsApp & reminders", `Balance: ${balText()}. Charges apply per message.`, `<button class="btn" data-a="wa-buy">${ico("plus")} Buy credits</button>`) + remindersCard() + bulkUpsell() + `
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Credit history</h2></div>${ledger.length ? `<div class="list">${ledger.map((x) => `<div class="item small"><div class="grow">${esc(x.reason)} <span class="muted">${x.kind === "utility" ? "utility" : "promotional"} · ${fmtDT(x.created_at)}</span></div><b class="num">${x.delta > 0 ? "+" : ""}${x.delta}</b></div>`).join("")}</div>` : `<div class="empty">No credits used yet.</div>`}</div>`;
    return;
  }
  if (!WA.tpl && tpls.length) WA.tpl = tpls[0].id;
  const t = tpls.find((x) => x.id === WA.tpl) || tpls[0], aud = audience(WA.aud).filter((c) => c.phone), cost = aud.length * (t?.credits_per_message || 1);
  const sg = segments();
  const preview = t ? t.body_preview.replace(/\{\{(\d+)\}\}/g, (m, n) => (n === "1" ? (aud[0]?.name || "Priya").split(" ")[0] : WA.params[n - 2] || `[${t.params[n - 2] || "…"}]`)) : "";
  el.innerHTML = head("WhatsApp & reminders", `Balance: ${balText()}. Charges apply per message.`, `<button class="btn" data-a="wa-buy">${ico("plus")} Buy credits</button>`) + remindersCard() + `<div style="height:16px"></div>` + `
  <div class="grid g2">
    <div class="card"><div class="card-head"><h2>New broadcast</h2></div>
      <div class="fields">
        <div class="field"><label for="wa-aud">Send to</label><select id="wa-aud">${Object.entries(sg).map(([k, [l, list]]) => `<option value="${k}" ${WA.aud === k ? "selected" : ""}>${l} (${list.length})</option>`).join("")}${allTags().map((x) => `<option value="tag:${esc(x)}" ${WA.aud === "tag:" + x ? "selected" : ""}>Tag: ${esc(x)}</option>`).join("")}</select></div>
        <div class="field"><label for="wa-tpl">Message</label><select id="wa-tpl">${tpls.map((x) => `<option value="${x.id}" ${t?.id === x.id ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select></div>
      </div>
      ${(t?.params || []).map((p, i) => `<div class="field" style="margin-top:12px"><label for="wa-p${i}">${esc(p)}</label><input id="wa-p${i}" data-wp="${i}" value="${esc(WA.params[i] ?? defaultParam(p))}"></div>`).join("")}
      <div class="row" style="margin-top:14px;justify-content:space-between"><span class="small">${aud.length} customers × ${t?.credits_per_message || 1} ${CREDIT[kindOf(t)].short} credit = <b class="num">${nfmt(cost)} credits</b>${cost > balOf(t) ? ` <span class="pill bad">Not enough ${CREDIT[kindOf(t)].short} credits</span>` : ""}</span>
        <button class="btn primary" data-a="wa-send" ${aud.length && cost <= balOf(t) && t ? "" : "disabled"}>${ico("send")} Send to ${aud.length}</button></div>
    </div>
    <div class="card"><div class="card-head"><h2>Preview</h2></div><div class="bubble" id="wa-prev">${esc(preview)}</div><p class="small muted" style="margin-top:12px">Messages use templates approved by WhatsApp, so the wording is fixed. You fill in the highlighted parts.</p></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><div class="card-head"><h2>Past broadcasts</h2></div>${bcs.length ? `<div class="list">${bcs.map((b) => `<div class="item"><div class="grow"><b>${esc(b.title)}</b><span class="muted small">${fmtDT(b.created_at)} · ${esc(b.audience)}</span></div><span class="small num">${b.sent} sent${b.failed ? `, ${b.failed} failed` : ""} · ${b.credits_used} cr</span></div>`).join("")}</div>` : `<div class="empty">No broadcasts yet.</div>`}</div>
    <div class="card"><div class="card-head"><h2>Credit history</h2></div>${ledger.length ? `<div class="list">${ledger.map((x) => `<div class="item small"><div class="grow">${esc(x.reason)} <span class="muted">${fmtDT(x.created_at)}</span></div><b class="num" style="color:${x.delta > 0 ? "var(--good)" : "var(--ink-2)"}">${x.delta > 0 ? "+" : ""}${x.delta}</b></div>`).join("")}</div>` : `<div class="empty">No credits yet.</div>`}</div>
  </div>`;
  $("#wa-aud").onchange = (e) => { WA.aud = e.target.value; after.whatsapp(); };
  $("#wa-tpl").onchange = (e) => { WA.tpl = e.target.value; WA.params = []; after.whatsapp(); };
  $$("[data-wp]").forEach((inp) => (inp.oninput = () => { WA.params[+inp.dataset.wp] = inp.value; const tt = tpls.find((x) => x.id === WA.tpl);
    $("#wa-prev").textContent = tt.body_preview.replace(/\{\{(\d+)\}\}/g, (m, n) => (n === "1" ? (aud[0]?.name || "Priya").split(" ")[0] : WA.params[n - 2] || `[${tt.params[n - 2]}]`)); }));
  $$("[data-wp]").forEach((inp) => { if (WA.params[+inp.dataset.wp] == null) WA.params[+inp.dataset.wp] = inp.value; });
};
/* ---------- Automatic reminders (every plan, optional, charged per message) ---------- */
const AUTO = {
  birthday: { t: "Birthday wish", when: "days before their birthday", d: 3, times: false, offer: "Birthday treat in the message", ex: "Happy birthday Priya! 🎂 Everyone at {biz} wishes you a wonderful year. Enjoy {offer} this week." },
  visit_update: { t: "Thank-you after each visit", instant: true, util: true, ex: "Hi Priya, thank you for visiting {biz} today. Bill paid: ₹450. Your loyalty card at this store now has 3 of 10 stamps, and your next reward is 10% off on visit 5. You can see your card any time here: (card link)", help: "Sent straight after you save a visit. Needs the loyalty card." },
  reward_used: { t: "Reward or coupon used", instant: true, util: true, ex: "Hi Priya, you have used your loyalty reward (10% off) at {biz} today and saved ₹45. Your loyalty card at this store now has 0 of 10 stamps. You can see your card any time here: (card link)", help: "Sent instead of the thank-you when a reward or coupon was used on the visit." },
  loyalty: { t: "Loyalty reward reminder", util: true, when: "days after their last visit", d: 7, times: true, ex: "Hi Priya, thank you for your visit! Your {biz} loyalty card now has 4 of 10 stamps. Your next reward: visit 5: 15% off." },
  offer_expiry: { t: "Offer ending reminder", when: "days before an offer ends", d: 3, times: true, ex: "Hi Priya! 🎉 {biz} has a treat for you: 20% off with code DIWALI20. Valid till 14 Nov.", help: "Goes to customers who visited in the last 120 days, for offers marked 'show to customers'." },
  win_back: { t: "We miss you", when: "days after their last visit", d: 30, times: true, offer: "Offer in the message", ex: "Hi Priya, it's been a while! We'd love to see you again at {biz}. Here's {offer} on your next visit." },
};
function remindersCard() {
  const rule = (k) => (D.autoRules || []).find((r) => r.kind === k) || { kind: k, enabled: false, days: AUTO[k].d, times: 1, gap_days: 3, offer: "", daily_cap: 50 };
  const sentMonth = (k) => (D.autoLog || []).filter((l) => l.kind === k && l.status === "sent" && l.created_at >= new Date(Date.now() - 30 * 864e5).toISOString()).length;
  const pm = D.perMsg ? ` (about ${inr2(D.perMsg[0])}–${inr2(D.perMsg[1])})` : "";
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Automatic reminders</h2><span class="pill">Optional</span></div>
    <p class="small muted" style="margin-top:-6px">Sent every morning around 10 am to the customers who are due. <b>Charges apply:</b> each message uses 1 credit of the type shown on the reminder. Nothing is sent while a reminder is off or you have no credits of that type.</p>
    <div class="auto-grid">${Object.keys(AUTO).map((k) => { const r = rule(k), a = AUTO[k], loyOff = (k === "loyalty" || a.instant) && !hasMod("loyalty");
      const ex = a.ex.replace("{biz}", D.biz.name).replace("{card}", D.prog?.name || "Loyalty").replace("{offer}", r.offer || "a special treat");
      return `<div class="auto ${r.enabled ? "on" : ""}" data-auto="${k}">
        <div class="row" style="justify-content:space-between;align-items:center"><b>${a.t} <span class="pill ${a.util ? "info" : ""}" style="font-weight:500">${a.util ? "utility" : "promotional"}</span></b><label class="switch"><input type="checkbox" data-am="enabled" ${r.enabled ? "checked" : ""} ${loyOff ? "disabled" : ""} aria-label="Turn ${a.t} on"><span></span></label></div>
        <div class="bubble small">${esc(ex)}</div>
        ${a.instant ? "" : `<div class="auto-f"><label>Send <input type="number" min="0" max="365" data-am="days" value="${r.days}" aria-label="Days"> ${a.when}</label>
          ${a.times ? `<label>Up to <input type="number" min="1" max="5" data-am="times" value="${r.times}" aria-label="Times"> time(s), every <input type="number" min="1" max="60" data-am="gap_days" value="${r.gap_days}" aria-label="Gap days"> days</label>` : ""}
          ${a.offer ? `<label class="full">${a.offer}<input data-am="offer" maxlength="80" value="${esc(r.offer)}" placeholder="e.g. 20% off"></label>` : ""}
          <label>At most <input type="number" min="1" max="1000" data-am="daily_cap" value="${r.daily_cap}" aria-label="Daily limit"> messages a day</label></div>`}
        ${a.help ? `<p class="small muted">${a.help}</p>` : ""}
        <p class="small muted">${loyOff ? "Needs the loyalty card." : `${a.instant ? "" : `Due today: <b class="num">${D.autoPrev?.[k] ?? 0}</b> · `}sent in 30 days: <b class="num">${sentMonth(k)}</b>${r.last_note ? ` · last run: ${esc(r.last_note)}` : ""}`}</p>
        <button class="btn sm" data-a="am-save" data-id="${k}">Save</button></div>`; }).join("")}</div></div>`;
}
function bulkUpsell() {
  if (hasMod("bulk_whatsapp")) return "";
  return `<div class="card upsell" style="margin-top:16px"><div><h2>📣 Bulk messaging is in Pro</h2><p class="muted">Send one offer to hundreds of customers in one click, with your own message templates approved by WhatsApp. Starter and Growth can message customers one at a time and use automatic reminders.</p></div>
    <button class="btn primary" data-a="upgrade-to" data-id="bulk_whatsapp">Upgrade to Pro</button></div>`;
}

/* ---------- Message templates (Pro): submit your own for bulk messaging ---------- */
VIEWS.templates = () => `<div id="tpl-view"><div class="loading"><span class="spinner"></span></div></div>`;
after.templates = async () => {
  const all = await q(sb.from("wa_templates").select("*").order("created_at", { ascending: false }));
  const mine = all.filter((t) => t.business_id === BID), shared = all.filter((t) => !t.business_id);
  const el = $("#tpl-view"); if (!el) return;
  const st = { pending: ["warn", "Waiting for Branditude"], submitted: ["info", "With WhatsApp for approval"], approved: ["good", "Approved"], rejected: ["bad", "Not approved"] };
  el.innerHTML = head("Message templates", "WhatsApp only allows business messages from approved templates. Write yours here; Branditude checks it and sends it to WhatsApp for approval (usually within a day).") + `
  <div class="grid g2">
    <div class="card"><div class="card-head"><h2>New template</h2></div>
      <div class="fields">
        <div class="field full"><label for="nt-title">Title (for you)</label><input id="nt-title" maxlength="60" placeholder="Diwali offer"></div>
        <div class="field"><label for="nt-cat">Type</label><select id="nt-cat"><option value="marketing">Offer or promotion</option><option value="utility">Update about their account or order</option></select></div>
        <div class="field"><label for="nt-lang">Language</label><select id="nt-lang"><option value="en">English</option><option value="hi">Hindi</option><option value="mr">Marathi</option><option value="gu">Gujarati</option></select></div>
        <div class="field full"><label for="nt-body">Message</label><textarea id="nt-body" rows="5" maxlength="1024" placeholder="Hi {{1}}, this Diwali enjoy {{2}} at ${esc(D.biz.name)}. Valid till {{3}}."></textarea>
          <p class="small muted">Start with <b>{{1}}</b>, which becomes the customer's first name. Use {{2}}, {{3}}… for parts you fill in each time.</p></div>
      </div>
      <div id="nt-params"></div><div class="bubble" id="nt-prev" style="margin-top:12px">Your preview appears here.</div><p class="err" id="nt-err"></p>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-a="tpl-submit">Send for approval</button></div>
      <p class="small muted" style="margin-top:8px">Avoid: all-caps, many emojis, links to other businesses, and asking for payments or passwords. Charges apply per message when you send.</p></div>
    <div class="card"><div class="card-head"><h2>Your templates</h2></div>${mine.length ? `<div class="list">${mine.map((t) => `<div class="item"><div class="grow"><b>${esc(t.title)}</b><span class="muted small">${esc(t.body_preview)}</span>${t.reject_reason ? `<span class="small" style="color:var(--bad)">${esc(t.reject_reason)}</span>` : ""}</div><span class="pill ${st[t.status][0]}">${st[t.status][1]}</span></div>`).join("")}</div>` : `<div class="empty">No templates yet. Approved ones appear in WhatsApp → New broadcast.</div>`}
      <h3 style="margin:18px 0 8px;font-size:16px">Ready-made templates</h3><div class="list">${shared.map((t) => `<div class="item small"><div class="grow"><b>${esc(t.title)}</b><span class="muted">${esc(t.body_preview)}</span></div></div>`).join("")}</div></div>
  </div>`;
  const body = $("#nt-body"), params = () => { const n = Math.max(1, ...[...(body.value.matchAll(/\{\{(\d+)\}\}/g))].map((m) => +m[1]));
    const cur = [...$$("[data-ntp]")].map((i) => [i.value, $("#nt-s" + i.dataset.ntp)?.value || ""]);
    $("#nt-params").innerHTML = Array.from({ length: n - 1 }, (_, i) => `<div class="fields" style="margin-top:10px"><div class="field"><label for="nt-p${i}">Label for {{${i + 2}}}</label><input id="nt-p${i}" data-ntp="${i}" value="${esc(cur[i]?.[0] || "")}" placeholder="${i === 0 ? "Offer" : "Valid till"}"></div><div class="field"><label for="nt-s${i}">Example</label><input id="nt-s${i}" value="${esc(cur[i]?.[1] || "")}" placeholder="${i === 0 ? "20% off" : "14 Nov"}"></div></div>`).join("");
    prev(); $$("#nt-params input").forEach((x) => (x.oninput = prev)); };
  const prev = () => { $("#nt-prev").textContent = body.value.replace(/\{\{(\d+)\}\}/g, (m, n) => (n === "1" ? "Priya" : $("#nt-s" + (n - 2))?.value || `[${$("#nt-p" + (n - 2))?.value || "…"}]`)) || "Your preview appears here."; };
  body.oninput = params; params();
};
function defaultParam(label) {
  const l = label.toLowerCase();
  if (l.includes("business")) return D.biz.name; if (l.includes("review link")) return reviewLink(); if (l.includes("card name")) return D.prog?.name || "";
  if (l.includes("valid")) return fmtShort(new Date(Date.now() + 7 * 864e5)); return "";
}
async function sendWA(customerIds, templateName, params, title) {
  const t = (D.tpls || (D.tpls = await q(sb.from("wa_templates").select("*").eq("active", true)))).find((x) => x.name === templateName || x.id === templateName);
  if (!t) throw new Error("This WhatsApp template isn't set up yet. Ask Branditude.");
  const { data, error } = await sb.functions.invoke("whatsapp-send", { body: { business_id: BID, template_id: t.id, customer_ids: customerIds, params, title: title || t.title, audience: customerIds.length === 1 ? "one customer" : audienceLabel(WA.aud) } });
  if (error) { let msg = error.message; try { msg = (await error.context.json()).error || msg; } catch {} throw new Error(msg); }
  return data;
}
const audienceLabel = (k) => (k?.startsWith("tag:") ? "Tag: " + k.slice(4) : segments()[k]?.[0] || k);
async function waOne(c, tplName) {
  if (!D.tpls) D.tpls = await q(sb.from("wa_templates").select("*").eq("active", true).order("created_at"));
  const tpls = D.tpls; let t = tpls.find((x) => x.name === tplName) || tpls[0]; if (!t) return toast("No WhatsApp templates yet. Ask Branditude.", "error");
  const st = Math.min(c.stamps || 0, D.prog?.stamps || 0), nx = nextReward(st, D.prog || { stamps: 0 }, D.rewards);
  const auto = (label) => { const l = label.toLowerCase(); if (l.includes("stamps")) return `${st} of ${D.prog?.stamps}`; if (l.includes("next reward")) return nx ? `visit ${nx.visit}: ${rwLabel(nx.r)}` : "card complete"; return defaultParam(label); };
  const draw = () => {
    const m = openModal(`<div class="modal-head"><h2>WhatsApp ${esc(c.name.split(" ")[0])}</h2><button class="btn ghost" data-close>Close</button></div>
      <div class="field"><label for="w1-t">Message</label><select id="w1-t">${tpls.map((x) => `<option value="${x.id}" ${x.id === t.id ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select></div>
      ${t.params.map((p, i) => `<div class="field" style="margin-top:12px"><label for="w1-p${i}">${esc(p)}</label><input id="w1-p${i}" value="${esc(auto(p))}"></div>`).join("")}
      <div class="bubble" id="w1-prev" style="margin-top:14px"></div><p class="small muted" style="margin-top:8px">Uses ${t.credits_per_message} ${CREDIT[kindOf(t)].short} credit · you have ${nfmt(balOf(t))}</p><p class="err" id="w1-err"></p>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn wa" id="w1-send">${ico("send")} Send</button></div>`);
    const prev = () => { m.querySelector("#w1-prev").textContent = t.body_preview.replace(/\{\{(\d+)\}\}/g, (x, n) => (n === "1" ? c.name.split(" ")[0] : m.querySelector("#w1-p" + (n - 2))?.value || "…")); };
    m.querySelectorAll("input").forEach((i) => (i.oninput = prev)); prev();
    m.querySelector("#w1-t").onchange = (e) => { t = tpls.find((x) => x.id === e.target.value); draw(); };
    m.querySelector("#w1-send").onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await sendWA([c.id], t.id, t.params.map((_, i) => m.querySelector("#w1-p" + i).value));
        if (!r.sent) throw new Error("WhatsApp couldn't deliver this message. No credits were used.");
        D.wallet = r.balance; D.walletU = r.utility_balance ?? D.walletU; closeModal(); toast("Sent on WhatsApp");
        if (t.name === "review_request" && c.review_status === "none") { await q(sb.from("customers").update({ review_status: "requested", review_requested_at: new Date().toISOString() }).eq("id", c.id)); await reload("customers"); softRender(); }
      } catch (err) { m.querySelector("#w1-err").textContent = err.message; e.target.disabled = false; }
    };
  };
  draw();
}

/* ---------- Alerts ---------- */
VIEWS.alerts = () => {
  const al = alerts(), rem = [...D.reminders].sort((a, b) => a.done - b.done || String(a.due).localeCompare(String(b.due)));
  return head("Alerts", "Complaints, birthdays, customers drifting away, offers about to end, and your own to-dos.") + `
  <div class="grid g2"><div class="card"><div class="card-head"><h2>Today's alerts</h2><span class="pill ${al.length ? "bad" : "good"}">${al.length}</span></div>${al.length ? `<div class="list">${al.map(alertRow).join("")}</div>` : `<div class="empty">Nothing needs attention.</div>`}</div>
  <div class="card"><div class="card-head"><h2>My reminders</h2></div>
    <form id="rem-form" class="row" style="margin-bottom:10px"><input id="rem-text" placeholder="e.g. Order festive stock" style="flex:2;min-width:180px" required aria-label="Reminder"><input id="rem-due" type="date" value="${todayISO()}" style="flex:1;min-width:140px" aria-label="Due date"><button class="btn primary" ${canWrite() ? "" : "disabled"}>Add</button></form>
    ${rem.length ? `<div class="list">${rem.map((r) => `<div class="item"><input type="checkbox" id="r-${r.id}" data-a="rem-toggle" data-id="${r.id}" ${r.done ? "checked" : ""} style="width:auto"><label for="r-${r.id}" class="grow" style="margin:0;font-weight:500;color:var(--ink);${r.done ? "text-decoration:line-through;color:var(--ink-3)" : ""}">${esc(r.text)}<span class="muted small" style="display:block">${r.due ? "Due " + fmtDate(r.due) : ""}</span></label><button class="btn sm ghost danger" data-a="rem-del" data-id="${r.id}">Delete</button></div>`).join("")}</div>` : `<div class="empty">No reminders.</div>`}</div></div>`;
};
after.alerts = () => { $("#rem-form").onsubmit = async (e) => { e.preventDefault(); try { await q(sb.from("reminders").insert({ business_id: BID, text: $("#rem-text").value.trim(), due: $("#rem-due").value || null })); await reload("reminders"); render(); } catch (err) { toast(err.message, "error"); } }; };

/* ---------- Plan & services ---------- */
VIEWS.plan = () => `<div id="plan-view"><div class="loading"><span class="spinner"></span></div></div>`;
after.plan = async () => {
  const [pkgs, prods, pays] = await Promise.all([
    q(sb.from("packages").select("*").eq("active", true).order("sort")),
    q(sb.from("products").select("*, product_categories(category_id)").eq("active", true).order("sort")),
    q(sb.from("payments").select("*").eq("business_id", BID).order("created_at", { ascending: false })),
  ]);
  const myCat = D.biz.category_id, services = prods.filter((p) => !p.product_categories.length || p.product_categories.some((x) => x.category_id === myCat));
  const pend = pays.filter((p) => p.status === "pending"), b = D.biz, price = (p, bill) => (bill === "yearly" ? p.yearly_price : p.monthly_price) * (1 - p.discount_percent / 100);
  const el = $("#plan-view"); if (!el) return;
  el.innerHTML = head("Plan & services", "Your Growth Plan, payments, and extra services for " + esc(b.categories?.name || "your business") + ".") + `
  <div class="grid g2">
    <div class="card"><div class="card-head"><h2>Your plan</h2>${statusPill(b.status)}</div>
      <div class="row" style="align-items:baseline;gap:8px"><b style="font:800 26px var(--display)">${esc(b.packages?.name || "No plan")}</b><span class="muted">${esc(b.billing)}</span></div>
      <p class="muted small" style="margin-top:4px">${b.subscription_ends ? "Paid until " + fmtDate(b.subscription_ends) : "Not paid yet"}${b.wa_enabled ? " · WhatsApp add-on on" : ""}</p>
      ${b.packages ? `<ul class="small" style="padding-left:18px">${b.packages.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <div class="row" style="margin-top:12px">${b.package_id ? `<button class="btn primary" data-a="renew" data-id="${b.package_id}" data-bill="${b.billing}">Renew ${esc(b.billing)} · ${inr(price(b.packages, b.billing))}${plusGst()}</button>` : ""}</div></div>
    <div class="card"><div class="card-head"><h2>Payments waiting</h2><span class="pill ${pend.length ? "warn" : "good"}">${pend.length}</span></div>
      ${pend.length ? `<div class="list">${pend.map((p) => `<div class="item"><div class="grow"><b>${esc(p.description)}</b><span class="muted small">${fmtDT(p.created_at)} · ${p.utr ? "UPI ref " + esc(p.utr) + " · being checked" : "not paid yet"}</span></div><b class="num">${inr2(p.total)}</b>${p.utr ? "" : `<button class="btn sm primary" data-a="pay" data-id="${p.id}">Pay</button>`}</div>`).join("")}</div>` : `<div class="empty">Nothing to pay.</div>`}</div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Change plan</h2></div><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">
    ${pkgs.map((p) => `<div class="coupon" style="border-style:solid;${p.id === b.package_id ? "border-color:var(--accent)" : ""}"><div class="row" style="justify-content:space-between"><b style="font-size:18px">${esc(p.name)}</b>${p.id === b.package_id ? '<span class="pill acc">Current</span>' : p.is_popular ? '<span class="pill">Popular</span>' : ""}</div>
      <div><b class="num" style="font-size:20px">${inr(price(p, "monthly"))}</b><span class="muted">/month</span>${+p.discount_percent ? ` <span class="pill warn">${+p.discount_percent}% off</span>` : ""}<div class="muted small num">or ${inr(price(p, "yearly"))}/year</div></div>
      <p class="small muted">${esc(p.tagline)}</p>${p.id !== b.package_id ? `<div class="row"><button class="btn sm" data-a="renew" data-id="${p.id}" data-bill="monthly">Monthly</button><button class="btn sm" data-a="renew" data-id="${p.id}" data-bill="yearly">Yearly</button></div>` : ""}</div>`).join("")}</div></div>
  ${addonsCard(pend)}
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Services for ${esc(b.categories?.name || "you")}</h2></div>
    ${services.length ? `<div class="list">${services.map((p) => `<div class="item"><div class="grow"><b>${esc(p.name)}</b><span class="muted small">${esc(p.description || "")}</span></div><b class="num">${inr(p.price)}${p.billing === "monthly" ? "/mo" : ""}</b><button class="btn sm" data-a="buy-product" data-id="${p.id}" ${b.status === "active" ? "" : "disabled"}>Buy</button></div>`).join("")}</div>` : `<div class="empty">No extra services right now.</div>`}</div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Payment history</h2></div>${pays.filter((p) => p.status !== "pending").map((p) => `<div class="item"><div class="grow"><b>${esc(p.description)}</b><span class="muted small">${fmtDT(p.created_at)}</span></div><span class="num">${inr2(p.total)}</span>${statusPill(p.status)}</div>`).join("") || `<div class="empty">No payments yet.</div>`}</div>`;
  D.pays = pays;
};
function addonsCard(pend) {
  const b = D.biz, mods = (D.mods || []).filter((m) => !m.core && fitsBiz(m.key)), yr = b.billing === "yearly";
  if (!mods.length) return "";
  const inPlan = (k) => (b.packages?.modules || []).includes(k), bought = (k) => (b.addon_modules || []).includes(k);
  const waiting = (k) => pend.some((p) => p.kind === "module" && p.meta?.module === k);
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Features & add-ons</h2>${b.status === "trial" ? '<span class="pill acc">All unlocked on trial</span>' : ""}</div>
    <p class="muted small" style="margin-top:-6px">Add any single feature to your plan. Add-ons renew with your plan.</p>
    <div class="list">${(D.mods || []).filter((m) => fitsBiz(m.key)).map((m) => `<div class="item"><span style="font-size:20px" aria-hidden="true">${esc(m.icon)}</span><div class="grow"><b>${esc(m.name)}</b><span class="muted small">${esc(m.blurb)}</span></div>
      ${m.core || inPlan(m.key) ? '<span class="pill good">In your plan</span>' : bought(m.key) ? '<span class="pill good">Add-on on</span>' : waiting(m.key) ? '<span class="pill warn">Payment waiting</span>'
        : m.addon_price != null ? `<b class="num">${inr(m.addon_price * (yr ? 10 : 1))}${yr ? "/yr" : "/mo"}</b><button class="btn sm" data-a="buy-module" data-id="${m.id}">Add</button>` : ""}</div>`).join("")}</div></div>`;
}
async function payModal(paymentId) {
  const p = D.pays?.find((x) => x.id === paymentId) || (await q(sb.from("payments").select("*").eq("id", paymentId).single()));
  const online = rzpOn(D.settings);
  const upi = online ? {} : D.settings.payment || {}; const ref = "BGP-" + p.id.slice(0, 8).toUpperCase();
  const link = upi.upi_id ? `upi://pay?pa=${encodeURIComponent(upi.upi_id)}&pn=${encodeURIComponent(upi.upi_name || "Branditude")}&am=${(+p.total).toFixed(2)}&cu=INR&tn=${encodeURIComponent(ref)}` : "";
  const m = openModal(`<div class="modal-head"><h2>Pay ${inr2(p.total)}</h2><button class="btn ghost" data-close>Close</button></div>
    <p class="muted small">${esc(p.description)}${+p.gst ? ` · ${inr2(p.amount)} + GST ${inr2(p.gst)}` : ""}</p>
    ${rzpOn(D.settings) ? `<div class="rzp-box"><button class="btn primary" id="rzp-go" style="width:100%;justify-content:center">Pay ${inr2(p.total)} online</button><p class="small muted" style="margin-top:6px;text-align:center">UPI, cards, netbanking or wallets. Switches on instantly.</p></div>
` : ""}
    ${upi.upi_id ? `<div class="row" style="gap:18px;margin-top:14px;align-items:center"><div class="qr" id="pay-qr"></div><div><p class="small muted">Scan with any UPI app, or pay to</p><p style="font:800 18px var(--display)">${esc(upi.upi_id)}</p><p class="small muted">Add <b>${ref}</b> in the note</p><a class="btn sm primary" href="${esc(link)}" style="margin-top:8px">Open UPI app</a></div></div>` : online ? "" : `<div class="note">Branditude hasn't added a UPI ID yet. Contact them to pay.</div>`}
    ${online ? `<div class="modal-foot"><button class="btn" data-close>Later</button></div>` : `<div class="field" style="margin-top:18px"><label for="utr">UPI transaction ID (12-digit UTR)</label><input id="utr" inputmode="numeric" placeholder="e.g. 431298765012"></div><p class="err" id="utr-err"></p>
    <div class="modal-foot"><button class="btn" data-close>Later</button><button class="btn primary" id="utr-go">I've paid</button></div>`}`);
  if (link && window.QRCode) new QRCode(m.querySelector("#pay-qr"), { text: link, width: 150, height: 150, colorDark: "#16203a", colorLight: "#ffffff" });
  const rz = m.querySelector("#rzp-go");
  if (rz) rz.onclick = async () => {
    rz.disabled = true; rz.innerHTML = `<span class="spinner"></span> Opening…`;
    try { const r = await payOnline(sb, p.id);
      if (r === "paid") { closeModal(); toast("Payment received. Thank you!"); D.pays = null; await reload("biz"); render(); return; } }
    catch (e) { toast(e.message, "error"); }
    rz.disabled = false; rz.textContent = `Pay ${inr2(p.total)} online`;
  };
  const ug = m.querySelector("#utr-go");
  if (ug) ug.onclick = async () => {
    try { await q(sb.rpc("submit_utr", { p_payment: p.id, p_utr: m.querySelector("#utr").value.trim() })); closeModal(); toast("Thanks! We'll confirm your payment shortly."); if (p.kind === "subscription") D.payWaiting = true; render(); }
    catch (e) { m.querySelector("#utr-err").textContent = e.message; }
  };
}
async function order(kind, ref, billing) {
  let r;
  try { r = await q(sb.rpc("create_order", { p_business: BID, p_kind: kind, p_ref: ref, p_billing: billing || "monthly" })); }
  catch (e) { // an unpaid one is already waiting: open it instead of failing
    if (kind === "module" && /payment waiting/.test(e.message)) {
      const key = (D.mods || []).find((m) => m.id === ref)?.key;
      const pend = await q(sb.from("payments").select("id,meta").eq("business_id", BID).eq("kind", "module").eq("status", "pending"));
      const hit = pend.find((x) => x.meta?.module === key); if (hit) { D.pays = null; return payModal(hit.id); }
    }
    throw e;
  }
  D.pays = null; await payModal(r.payment_id);
}

/* ---------- Locked feature: explain it and offer the add-on or the plan that has it ---------- */
let PKGS_CACHE = null;
function lockedView(key) {
  const md = modInfo(key) || { name: "This feature", blurb: "", icon: "🔒" };
  setTimeout(async () => {
    PKGS_CACHE = PKGS_CACHE || (await q(sb.from("packages").select("*").eq("active", true).order("sort")).catch(() => []));
    const plan = PKGS_CACHE.find((p) => (p.modules || []).includes(key)), el = $("#lock-plan");
    if (el && plan) el.innerHTML = `<button class="btn ${md.addon_price == null ? "primary" : ""}" data-a="renew" data-id="${plan.id}" data-bill="${esc(D.biz.billing || "monthly")}">Upgrade to ${esc(plan.name)} · ${inr(plan.monthly_price)}/month</button>`;
  });
  const yr = D.biz.billing === "yearly", price = md.addon_price != null ? md.addon_price * (yr ? 10 : 1) : null;
  return head(`${esc(md.icon)} ${esc(md.name)}`, "") + `<div class="card lock-card"><div class="lock-ic" aria-hidden="true">🔒</div>
    <h2>${esc(md.name)} isn't in your ${esc(D.biz.packages?.name || "")} plan yet</h2><p class="muted">${esc(md.blurb)}</p>
    <p class="small" style="margin-top:10px">${md.addon_price == null ? "Upgrade your plan to use it." : "Add just this feature, or upgrade to get it with more."}</p>
    <div class="row" style="justify-content:center;margin-top:16px;flex-wrap:wrap;gap:10px">
      ${price != null ? `<button class="btn primary" data-a="buy-module" data-id="${md.id}">Add it for ${inr(price)}${yr ? "/year" : "/month"}${plusGst()}</button>` : ""}
      <span id="lock-plan"></span></div>
    <p class="small muted" style="margin-top:14px">Your data is safe. ${rzpOn(D.settings) ? "Pay online and it switches on straight away." : "Pay by UPI and it switches on as soon as Branditude confirms the payment."}</p></div>`;
}

/* ---------- Profile ---------- */
VIEWS.profile = () => { const b = D.biz;
  return head("Business profile", "These details appear in your messages, feedback page and customer app.") + `
  <form id="prof" class="card" style="max-width:820px"><div class="fields">
    ${[["p-name", "Business name", b.name], ["p-phone", "Business phone", b.phone], ["p-email", "Email", b.email], ["p-city", "City", b.city], ["p-cc", "Country code", b.country_code]].map(([id, l, v]) => `<div class="field"><label for="${id}">${l}</label><input id="${id}" value="${esc(v || "")}"></div>`).join("")}
    <div class="field"><label>Category</label><input value="${esc(b.categories?.name || "")}" disabled title="Ask Branditude to change your category"></div></div>
    <div class="field" style="margin-top:14px"><label for="p-addr">Address</label><input id="p-addr" value="${esc(b.address || "")}"></div>
    <div class="field" style="margin-top:14px"><label for="p-review">Google review link</label><input id="p-review" value="${esc(b.google_review_link || "")}" placeholder="https://g.page/r/…/review"><span class="muted small" style="margin-top:4px">Google Business Profile → Ask for reviews → copy link</span></div>
    <div class="modal-foot" style="justify-content:flex-start"><button class="btn primary" ${canWrite() ? "" : "disabled"}>Save profile</button></div></form>
  <div class="card" style="max-width:820px;margin-top:16px"><div class="card-head"><h2>Account</h2></div><dl class="kv"><dt>Signed in as</dt><dd>${esc(C.user.email || C.user.phone || "")}</dd><dt>Feedback page</dt><dd><a href="${esc(feedbackLink())}" target="_blank" rel="noopener">${esc(feedbackLink())}</a></dd></dl></div>`; };
after.profile = () => { $("#prof").onsubmit = async (e) => { e.preventDefault();
  try { await q(sb.from("businesses").update({ name: $("#p-name").value.trim(), phone: normPhone($("#p-phone").value, $("#p-cc").value), email: $("#p-email").value.trim(), city: $("#p-city").value.trim(), country_code: $("#p-cc").value.replace(/\D/g, "") || "91", address: $("#p-addr").value.trim(), google_review_link: $("#p-review").value.trim() }).eq("id", BID));
    await reload("biz"); toast("Profile saved"); render(); } catch (err) { toast(err.message, "error"); } }; };

/* ---------- Keywords & SEO ---------- */
const SEO_KINDS = {
  description: { label: "Profile description", max: 750, where: "Google Business Profile → Edit profile → Description" },
  post: { label: "Google post", max: 1500, where: "Google Business Profile → Add update" },
  faq: { label: "FAQ", max: 3000, where: "Your website, and Google Business Profile → Q&A" },
  reply: { label: "Reply to a review", max: 4096, where: "Google Business Profile → Reviews → Reply" },
};
let SEO = { kind: "description", out: "", input: {} };
const cityOf = () => (D.biz.city || "").trim();
const fillCity = (k) => k.replace(/\{city\}/g, cityOf() || "your city").replace(/\s+/g, " ").trim();
VIEWS.seo = () => `<div id="seo-view"><div class="loading"><span class="spinner"></span></div></div>`;
async function seoLoad() {
  const [kw, sug, saved] = await Promise.all([
    q(sb.from("business_keywords").select("*").eq("business_id", BID).order("created_at")),
    D.biz.category_id ? q(sb.from("category_keywords").select("keyword").eq("category_id", D.biz.category_id).order("sort")) : [],
    q(sb.from("business_content").select("*").eq("business_id", BID).order("created_at", { ascending: false }).limit(30)),
  ]);
  D.kw = kw; D.kwSug = sug.map((x) => fillCity(x.keyword)); D.saved = saved; D.kwAi = D.kwAi || [];
}
after.seo = async () => { try { await seoLoad(); } catch (e) { toast(e.message, "error"); } drawSeo(); };
function drawSeo() {
  const el = $("#seo-view"); if (!el) return;
  const have = new Set(D.kw.map((k) => k.keyword.toLowerCase()));
  const sugg = [...new Set([...D.kwSug, ...D.kwAi])].filter((k) => !have.has(k.toLowerCase()));
  const k = SEO_KINDS[SEO.kind], len = (SEO.out || "").length;
  const inputs = {
    description: `<div class="field"><label for="seo-in">Anything special to mention? (optional)</label><input id="seo-in" data-in="details" value="${esc(SEO.input.details || "")}" placeholder="e.g. rooftop seating, open till midnight, pure veg"></div>`,
    post: `<div class="field"><label for="seo-in">What is the post about?</label><input id="seo-in" data-in="topic" value="${esc(SEO.input.topic || "")}" placeholder="e.g. Diwali offer: 20% off sweets till 15 Nov"></div>`,
    faq: `<div class="field"><label for="seo-in">Facts to include (optional)</label><input id="seo-in" data-in="details" value="${esc(SEO.input.details || "")}" placeholder="e.g. open 8am–11pm, free parking, UPI accepted"></div>`,
    reply: `<div class="fields"><div class="field"><label for="seo-rn">Customer's name</label><input id="seo-rn" data-in="reviewer" value="${esc(SEO.input.reviewer || "")}"></div>
      <div class="field"><label for="seo-rs">Stars</label><select id="seo-rs" data-in="stars">${[5, 4, 3, 2, 1].map((n) => `<option ${String(SEO.input.stars || 5) === String(n) ? "selected" : ""}>${n}</option>`).join("")}</select></div></div>
      <div class="field" style="margin-top:12px"><label for="seo-in">Paste their Google review</label><textarea id="seo-in" data-in="review" style="min-height:80px">${esc(SEO.input.review || "")}</textarea></div>`,
  }[SEO.kind];
  el.innerHTML = head("Keywords & SEO", "Pick the searches you want to be found for. They go into content <b>you</b> publish on your Google profile: the description, posts, FAQs and replies to reviews. That helps you show up on Google Maps and in AI assistants like ChatGPT and Gemini.") + `
  <div class="note" style="margin-bottom:16px">Keywords are never put into your customers' reviews. Google doesn't allow businesses to tell customers what to write, and it can remove reviews or restrict your profile if you do.</div>
  <div class="grid g2">
    <div class="card"><div class="card-head"><h2>Your keywords</h2><span class="pill ${D.kw.length ? "good" : ""} num">${D.kw.length}/15</span></div>
      ${D.kw.length ? `<div class="chips">${D.kw.map((x) => `<span class="chip" aria-pressed="true" style="cursor:default">${esc(x.keyword)} <button class="btn sm ghost" data-a="kw-del" data-id="${x.id}" aria-label="Remove ${esc(x.keyword)}" style="padding:0 4px;color:inherit">✕</button></span>`).join("")}</div>` : `<p class="muted small">No keywords yet. Tap suggestions below or add your own.</p>`}
      <form id="kw-add" class="row" style="margin-top:12px"><input id="kw-new" placeholder="Add your own, e.g. best filter coffee in ${esc(cityOf() || "your city")}" style="flex:1;min-width:200px" aria-label="New keyword" maxlength="80"><button class="btn" ${canWrite() ? "" : "disabled"}>Add</button></form>
      <h3 style="margin:18px 0 8px">Suggested for ${esc(D.biz.categories?.name || "you")}${cityOf() ? " in " + esc(cityOf()) : ""}</h3>
      ${sugg.length ? `<div class="chips">${sugg.map((x) => `<button class="chip" data-a="kw-add-s" data-kw="${esc(x)}" ${canWrite() && D.kw.length < 15 ? "" : "disabled"}>+ ${esc(x)}</button>`).join("")}</div>` : `<p class="muted small">You've added all the suggestions.</p>`}
      <div class="row" style="margin-top:12px"><button class="btn sm" data-a="kw-ai" ${canWrite() ? "" : "disabled"}>${ico("spark")} Suggest more with AI</button>${cityOf() ? "" : `<span class="small muted">Add your city in <a href="#profile">Business profile</a> for better suggestions.</span>`}</div>
    </div>
    <div class="card"><div class="card-head"><h2>Write with your keywords</h2></div>
      <div class="chips" style="margin-bottom:14px">${Object.entries(SEO_KINDS).map(([key, v]) => `<button class="chip" data-a="seo-kind" data-id="${key}" aria-pressed="${SEO.kind === key}">${v.label}</button>`).join("")}</div>
      ${inputs}
      <div class="row" style="margin-top:12px"><button class="btn primary" data-a="seo-go" ${canWrite() ? "" : "disabled"}>${ico("spark")} Write it</button></div>
      <div class="field" style="margin-top:14px"><label for="seo-out">Draft (edit freely)</label><textarea id="seo-out" style="min-height:180px" placeholder="Your draft appears here">${esc(SEO.out)}</textarea>
        <span class="small ${len > k.max ? "err" : "muted"}" id="seo-len" style="margin-top:4px">${len}/${k.max} characters · paste into ${esc(k.where)}</span></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-a="seo-copy">${ico("copy")} Copy</button><button class="btn sm" data-a="seo-save" ${canWrite() ? "" : "disabled"}>Save to library</button></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h2>Saved drafts</h2></div>
    ${D.saved.length ? `<div class="list">${D.saved.map((c) => `<div class="item" style="align-items:flex-start"><div class="grow"><b>${esc(SEO_KINDS[c.kind]?.label || c.kind)}${c.title ? " · " + esc(c.title) : ""}</b><span class="muted small">${fmtDT(c.created_at)}</span><p class="small" style="white-space:pre-wrap;margin-top:4px">${esc(c.body.length > 280 ? c.body.slice(0, 280) + "…" : c.body)}</p></div><button class="btn sm" data-a="copy" data-text="${esc(c.body)}">${ico("copy")}</button><button class="btn sm ghost danger" data-a="seo-del" data-id="${c.id}">Delete</button></div>`).join("")}</div>` : `<div class="empty">Drafts you save appear here.</div>`}
  </div>`;
  $("#kw-add").onsubmit = async (e) => { e.preventDefault(); await addKw($("#kw-new").value, "own"); };
  $$("[data-in]").forEach((i) => (i.oninput = i.onchange = () => (SEO.input[i.dataset.in] = i.value)));
  $("#seo-out").oninput = (e) => { SEO.out = e.target.value; const n = SEO.out.length; const l = $("#seo-len"); l.textContent = `${n}/${k.max} characters · paste into ${k.where}`; l.className = "small " + (n > k.max ? "err" : "muted"); };
}
async function addKw(kw, source) {
  kw = String(kw || "").trim().replace(/\s+/g, " ");
  if (kw.length < 2) return toast("Type a keyword first", "error");
  if (D.kw.length >= 15) return toast("Keep it to 15 keywords. Remove one first.", "error");
  try { await q(sb.from("business_keywords").insert({ business_id: BID, keyword: kw.slice(0, 80), source })); await seoLoad(); drawSeo(); } catch (e) { toast(/exists/.test(e.message) ? "You already have that keyword" : e.message, "error"); }
}
async function aiCall(kind, input) {
  const { data, error } = await sb.functions.invoke("ai-content", { body: { business_id: BID, kind, input } });
  if (error) { let m = error.message, fb = true; try { const j = await error.context.json(); m = j.error || m; fb = !!j.fallback; } catch {} const e = new Error(m); e.fallback = fb; throw e; }
  return data;
}
// Template drafts used when AI writing isn't switched on
function templateDraft(kind, input) {
  const b = D.biz, name = b.name, city = cityOf(), cat = (b.categories?.name || "local business").toLowerCase(), kws = D.kw.map((x) => x.keyword);
  const k = (i) => kws[i % Math.max(kws.length, 1)] || `${cat} in ${city || "town"}`;
  if (kind === "description") return `${name} is a ${cat}${city ? ` in ${city}` : ""} that customers come back to. ${input.details ? input.details.trim().replace(/^./, (c) => c.toUpperCase()).replace(/\.?$/, ". ") : ""}If you're searching for ${k(0)}, we'd love to welcome you. Our team takes care of every visit personally, and regulars earn rewards on our loyalty card. ${kws[1] ? `People also find us when looking for ${k(1)}. ` : ""}Drop by, or message us on WhatsApp to plan your visit.`.slice(0, 750);
  if (kind === "post") return `${(input.topic || "Something new at " + name).trim()}\n\n${name}${city ? `, ${city}` : ""} is ready for you. ${kws[0] ? `If you've been looking for ${k(0)}, this is a great time to visit. ` : ""}Show this post at the counter or message us on WhatsApp to know more.\n\nSee you soon!`;
  if (kind === "faq") return [
    [`Where is ${name} located?`, `We're at [address]${city ? `, ${city}` : ""}. Search "${name}" on Google Maps for directions.`],
    [`What are your timings?`, `We're open [timings], all days except [closed day].`],
    [`What do you offer?`, `${name} is a ${cat}${kws[0] ? ` known for ${k(0)}` : ""}. ${input.details || "[main services or products]"}.`],
    [`Do I need to book in advance?`, `[Walk-ins are welcome / Booking is recommended]. You can message us on WhatsApp at [number].`],
    [`Is parking available?`, `[Parking details].`],
    [`Which payment methods do you accept?`, `We accept UPI, cards and cash.`],
  ].map(([qq, a]) => `Q: ${qq}\nA: ${a}`).join("\n\n");
  if (kind === "reply") { const first = (input.reviewer || "").split(" ")[0]; const st = +input.stars || 5;
    return st >= 4 ? `Thank you so much${first ? `, ${first}` : ""}! We're really glad you enjoyed your visit to ${name}. ${kws[0] ? `It means a lot to us as a ${cat}${city ? ` in ${city}` : ""}. ` : ""}Hope to see you again soon!`
      : `Hi${first ? ` ${first}` : ""}, thank you for telling us about this, and we're sorry your visit wasn't up to the mark. This isn't the experience we want for anyone at ${name}. Please message us on WhatsApp or call us so we can understand what happened and make it right.`; }
  return "";
}

/* ---------- Google auto-reply (owner's replies to Google reviews) ---------- */
const GBP_MODES = [
  ["positive", "Auto-reply to 4–5★, I approve 1–3★", "Recommended. Happy reviews get a warm reply within the hour. Unhappy ones wait for you, because they need a human touch."],
  ["all", "Auto-reply to every review", "Every new review gets an AI reply automatically, including complaints. You can still edit any reply later."],
  ["drafts", "Draft only, I post", "AI writes a draft for each review. Nothing goes live until you tap Post."],
  ["off", "Off", "Reviews still show here, but no drafts or replies."],
];
const gbpPending = () => (D.gbpReviews || []).filter((r) => ["draft", "error"].includes(r.status)).length;
async function gbpLoad() {
  const [st, rv] = await Promise.all([q(sb.rpc("gbp_status", { b: BID })), q(sb.from("gbp_reviews").select("*").eq("business_id", BID).order("review_time", { ascending: false, nullsFirst: false }).limit(200))]);
  D.gbp = st || { connected: false }; D.gbpReviews = rv;
}
async function gbpFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body: { business_id: BID, ...body } });
  if (error) { let m = error.message, setup = false; try { const j = await error.context.json(); m = j.error || m; setup = !!j.setup; } catch {} const e = new Error(m); e.setup = setup; throw e; }
  return data;
}
VIEWS.replies = () => `<div id="gbp-view"><div class="loading"><span class="spinner"></span></div></div>`;
after.replies = async () => {
  const hq = new URLSearchParams(location.hash.split("?")[1] || "");
  if (hq.get("gbp")) { toast(hq.get("gbp") === "ok" ? "Google Business Profile connected ✓" : hq.get("msg") || "Couldn't connect Google", hq.get("gbp") === "ok" ? "" : "error"); history.replaceState(null, "", "#replies"); }
  try { await gbpLoad(); } catch (e) { toast(e.message, "error"); D.gbp = { connected: false }; D.gbpReviews = []; }
  drawGbp();
};
function drawGbp() {
  const el = $("#gbp-view"); if (!el) return;
  const g = D.gbp, rv = D.gbpReviews || [], mode = D.biz.gbp_reply_mode || "positive", stars = (n) => `<span class="stars-txt">${"★".repeat(n || 0)}${"☆".repeat(5 - (n || 0))}</span>`;
  const todo = rv.filter((r) => ["draft", "error", "new"].includes(r.status)), done = rv.filter((r) => ["posted", "skipped"].includes(r.status));
  const intro = head("Google auto-reply", "Reply to every Google review, automatically. Replies show you care, and Google treats an active, responsive profile as a good sign.",
    g.connected ? `<button class="btn" data-g="sync" ${canWrite() ? "" : "disabled"}>${ico("spark")} Check for new reviews</button>` : "");
  if (!g.connected) { el.innerHTML = intro + `<div class="card" style="max-width:720px">
      <h2>Connect your Google Business Profile</h2>
      <p class="muted" style="margin:8px 0 14px">Sign in with the Google account that owns or manages your profile. We'll read new reviews and post your replies. You can disconnect any time.</p>
      <ol class="small" style="margin:0 0 16px 18px;display:grid;gap:6px"><li>Tap <b>Connect Google</b> and choose your Google account.</li><li>Allow "manage your business listings". That's what lets us post replies.</li><li>Choose how replies go out. We recommend auto-replying to 4–5★ and approving 1–3★ yourself.</li></ol>
      <button class="btn primary" data-g="connect" ${canWrite() ? "" : "disabled"}>Connect Google</button>
      <div class="note" style="margin-top:14px">Until it's connected, you can still write replies in <a href="#seo">Keywords &amp; SEO → Review reply</a> and paste them on Google yourself.</div></div>`; return; }
  el.innerHTML = intro + `
    ${g.last_error ? `<div class="note" style="background:var(--bad-soft,#fde8e8);margin-bottom:14px"><b>Google says:</b> ${esc(g.last_error)}</div>` : ""}
    <div class="grid g4" style="margin-bottom:16px">${kpi("Waiting for you", todo.filter((r) => r.status !== "new").length, "drafts to approve")}${kpi("Replied", rv.filter((r) => r.status === "posted").length, `of ${rv.length} reviews`)}${kpi("Average rating", rv.length ? (rv.reduce((a, r) => a + (r.stars || 0), 0) / rv.length).toFixed(1) : "–", "latest 200 reviews")}${kpi("Last checked", g.last_sync_at ? ago(g.last_sync_at) : "never", "checks every hour")}</div>
    <div class="grid g2" style="align-items:start">
      <div class="card"><div class="card-head"><h2>How replies go out</h2></div>
        <div class="list">${GBP_MODES.map(([v, t, d]) => `<label class="item" style="cursor:pointer;align-items:flex-start"><input type="radio" name="gbp-mode" value="${v}" ${mode === v ? "checked" : ""} ${canWrite() ? "" : "disabled"} style="margin-top:4px;width:auto;flex:none;min-height:0"><div class="grow"><b>${t}</b><span class="muted small">${d}</span></div></label>`).join("")}</div></div>
      <div class="card"><div class="card-head"><h2>Connected profile</h2></div>
        <dl class="kv"><dt>Location</dt><dd>${esc(g.location_title || "Not chosen")}</dd><dt>Connected</dt><dd>${g.connected_at ? fmtDate(g.connected_at) : "–"}</dd></dl>
        ${(g.locations || []).length > 1 ? `<div class="field" style="margin-top:12px"><label for="gbp-loc">Use this location</label><select id="gbp-loc">${g.locations.map((l) => `<option value="${esc(l.name)}" ${l.name === g.location_name ? "selected" : ""}>${esc(l.title)}${l.address ? " · " + esc(l.address) : ""}</option>`).join("")}</select></div>` : ""}
        <div class="row" style="margin-top:12px"><button class="btn sm ghost" data-g="disconnect">Disconnect</button></div>
        <p class="small muted" style="margin-top:10px">Replies use your keywords only where they read naturally, and never on complaints.</p></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Needs your OK</h2><span class="pill ${todo.length ? "warn" : "good"}">${todo.length}</span></div>
      ${todo.length ? `<div class="list">${todo.map((r) => `<div class="item" style="align-items:flex-start;flex-direction:column;gap:8px">
        <div><b>${esc(r.reviewer || "Google user")} ${stars(r.stars)}</b><span class="muted small"> · ${r.review_time ? ago(r.review_time) : ""}${r.status === "error" ? ` · <span class="err">${esc(r.error || "couldn't post")}</span>` : ""}</span></div>
        ${r.comment ? `<p>“${esc(r.comment)}”</p>` : `<p class="muted small">Star rating only, no text.</p>`}
        <textarea data-draft="${r.id}" style="width:100%;min-height:80px" placeholder="Write your reply">${esc(r.draft || "")}</textarea>
        <div class="row"><button class="btn sm primary" data-g="post" data-id="${r.id}" ${canWrite() ? "" : "disabled"}>Post reply on Google</button><button class="btn sm" data-g="redraft" data-id="${r.id}" ${canWrite() ? "" : "disabled"}>${ico("spark")} New draft</button><button class="btn sm ghost" data-g="skip" data-id="${r.id}">Don't reply</button></div></div>`).join("")}</div>` : `<div class="empty">All caught up. New reviews are checked every hour.</div>`}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Replied</h2></div>
      ${done.length ? `<div class="list">${done.slice(0, 50).map((r) => `<div class="item" style="align-items:flex-start"><div class="grow"><b>${esc(r.reviewer || "Google user")} ${stars(r.stars)}</b>${r.comment ? `<span class="small">“${esc(r.comment)}”</span>` : ""}${r.reply_text ? `<span class="small muted" style="display:block;margin-top:4px">↳ ${esc(r.reply_text)}</span>` : ""}</div>${r.status === "skipped" ? `<span class="pill">skipped</span>` : `<span class="pill good">replied</span>`}</div>`).join("")}</div>` : `<div class="empty">No replies yet.</div>`}</div>`;
  el.querySelectorAll('[name="gbp-mode"]').forEach((r) => (r.onchange = async () => {
    try { await q(sb.from("businesses").update({ gbp_reply_mode: r.value }).eq("id", BID)); D.biz.gbp_reply_mode = r.value; toast("Saved"); } catch (e) { toast(e.message, "error"); drawGbp(); }
  }));
  const loc = $("#gbp-loc"); if (loc) loc.onchange = async () => { try { await gbpFn("gbp-sync", { action: "set_location", location: loc.value }); await gbpLoad(); drawGbp(); toast("Location changed"); } catch (e) { toast(e.message, "error"); } };
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-g]"); if (!el || !D.biz) return;
  const a = el.dataset.g, id = el.dataset.id;
  el.disabled = true;
  try {
    if (a === "connect") { const r = await gbpFn("gbp-connect", {}); location.href = r.url; return; }
    if (a === "sync") { const r = await gbpFn("gbp-sync", { action: "sync" }); toast(`Checked ${r.synced || 0} reviews · ${r.posted || 0} replied · ${r.drafted || 0} drafts`); }
    if (a === "disconnect") { if (!(await confirmBox("Disconnect Google?", "Auto-replies stop until you connect again. Your past replies stay on Google.", "Disconnect", { danger: true }))) { el.disabled = false; return; } await gbpFn("gbp-sync", { action: "disconnect" }); }
    if (a === "post") { const text = document.querySelector(`[data-draft="${id}"]`)?.value || ""; await gbpFn("gbp-sync", { action: "post", review_id: id, text }); toast("Reply posted on Google ✓"); }
    if (a === "redraft") { const r = await gbpFn("gbp-sync", { action: "redraft", review_id: id }); const t = document.querySelector(`[data-draft="${id}"]`); if (t) t.value = r.draft || ""; el.disabled = false; return; }
    if (a === "skip") await gbpFn("gbp-sync", { action: "skip", review_id: id });
    await gbpLoad(); drawGbp(); nav();
  } catch (err) { toast(err.message, "error"); el.disabled = false; }
});

/* ---------- Log a visit ---------- */
function visitModal(pre = {}) {
  const m = openModal(`<div class="modal-head"><h2>${pre.scanned ? "Card scanned" : "Log a visit"}</h2><button class="btn ghost" data-close>Close</button></div>
    ${pre.scanned ? `<div class="result ok" style="margin-bottom:12px">✓ <b>${esc(pre.scanned.name)}</b> · ${pre.scanned.visits} visits so far. Enter the bill to add this visit.</div>` : ""}
    <form id="vf"><div class="fields">
      <div class="field"><label for="v-phone">Customer's mobile number</label><input id="v-phone" inputmode="tel" required placeholder="98xxxxxxxx"></div>
      <div class="field"><label for="v-name">Name</label><input id="v-name" placeholder="New customer? Enter name"></div>
      <div class="field"><label for="v-bill">Bill amount ₹</label><input id="v-bill" type="number" min="0" required></div>
      <div class="field"><label for="v-code">Coupon code</label><input id="v-code" style="text-transform:uppercase" placeholder="Optional"></div></div>
      <div id="v-status" style="margin-top:12px"></div><p class="err" id="v-err"></p>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save visit</button></div></form>`);
  let timer, seq = 0;
  const preview = async () => {
    const ph = m.querySelector("#v-phone").value; if (ph.replace(/\D/g, "").length < 10) { m.querySelector("#v-status").innerHTML = ""; return; }
    const my = ++seq;
    try {
      const p = await q(sb.rpc("preview_visit", { p_business: BID, p_phone: ph, p_gross: +m.querySelector("#v-bill").value || 0, p_coupon: m.querySelector("#v-code").value.trim() }));
      if (my !== seq || !modalOpen()) return;
      let h = "";
      if (p.customer) { h += `<div class="note" style="margin-bottom:8px">Returning: <b>${esc(p.customer.name)}</b> · ${p.customer.visits} visits · ${inr(p.customer.spend)}</div>`; m.querySelector("#v-name").placeholder = p.customer.name; }
      if (p.loyalty_enabled) { let t = `🎟️ Loyalty visit <b>${p.visit_no} of ${p.loyalty_stamps}</b>`;
        if (p.loyalty_reward) t += p.use === "loyalty" ? ` · reward <b>${esc(rwLabel({ ...p.loyalty_reward, max_discount: 0 }))}</b>` : ` · loyalty reward not used because the coupon gives more`;
        else if (p.next_reward) t += ` · next reward on visit ${p.next_reward.visit}`; if (p.completes_card) t += " · 🏆 completes the card";
        h += `<div class="note" style="margin-bottom:8px;background:var(--accent-soft)">${t}</div>`; }
      if (m.querySelector("#v-code").value.trim()) h += `<div class="result ${p.coupon_ok ? "ok" : "no"}" style="margin-bottom:8px">${esc(p.coupon_message || "")}${p.coupon_ok && p.use === "loyalty" ? " (loyalty reward is better)" : ""}</div>`;
      const g = +m.querySelector("#v-bill").value || 0; if (g && +p.discount) h += `<div class="result ok">Customer pays ${inr(g - p.discount)} (${inr(p.discount)} off)</div>`;
      m.querySelector("#v-status").innerHTML = h;
    } catch (e) { m.querySelector("#v-status").innerHTML = ""; }
  };
  m.querySelectorAll("input").forEach((i) => (i.oninput = () => { clearTimeout(timer); timer = setTimeout(preview, 300); }));
  if (pre.phone) { m.querySelector("#v-phone").value = pre.phone; if (pre.name) m.querySelector("#v-name").value = pre.name; preview(); m.querySelector("#v-bill").focus(); }
  m.querySelector("#vf").onsubmit = async (e) => {
    e.preventDefault(); const btn = e.submitter || m.querySelector("button.primary"); btn.disabled = true;
    try {
      const r = await q(sb.rpc("log_visit", { p_business: BID, p_phone: m.querySelector("#v-phone").value, p_name: m.querySelector("#v-name").value, p_gross: +m.querySelector("#v-bill").value, p_coupon: m.querySelector("#v-code").value.trim() }));
      if (waOn()) sb.functions.invoke("wa-notify", { body: { business_id: BID, customer_id: r.customer_id } }).then(({ data }) => {
        if (data?.ok) toast("WhatsApp update sent to the customer"); else if (/credits/.test(data?.skipped || "")) toast("WhatsApp update not sent: no utility credits left", "error"); }).catch(() => {});
      await reload("customers", "visits", "coupons"); const c = D.customers.find((x) => x.id === r.customer_id);
      const shown = r.completed ? { ...c, stamps: D.prog.stamps } : c;
      openModal(`<div class="modal-head"><h2>${r.completed ? "🏆 Card completed!" : "Visit saved"}</h2><button class="btn ghost" data-close>Close</button></div>
        <p><b>${esc(c.name)}</b> pays <b class="num">${inr(r.net)}</b>${+r.discount ? ` after ${inr(r.discount)} off` : ""}${r.reward_label ? ` (${esc(r.reward_label)})` : r.use === "coupon" ? ` (coupon)` : ""}.</p>
        ${r.loyalty_enabled ? `<div style="display:flex;justify-content:center;margin-top:14px">${loyaltyCard({ bizName: D.biz.name, prog: D.prog, rewards: D.rewards, customer: shown })}</div>` : ""}
        <div class="modal-foot"><button class="btn" data-close>Done</button><button class="btn" data-a="kiosk" data-id="${c.id}">${ico("smile")} Feedback screen</button>${r.loyalty_enabled && c.visits <= 1 ? `<a class="btn wa" href="${esc(waLink(c))}" target="_blank" rel="noopener">${ico("wa")} Send card link</a>` : ""}${waBtn("Review request", `data-a="wa-one" data-id="${c.id}" data-tpl="review_request"`, "")}</div>`);
      softRender();
    } catch (err) { m.querySelector("#v-err").textContent = err.message; btn.disabled = false; }
  };
}

/* ---------- Counter feedback screen ---------- */
let K = null;
const FACES = ["", "Very bad", "Bad", "Okay", "Good", "Excellent"], ISSUES = ["Waiting time", "Staff behaviour", "Quality", "Price", "Cleanliness", "Something else"];
const freshK = (cid) => ({ step: "rate", rating: 0, cid: cid || "", tags: [], text: "", phone: "", fid: null });
function kiosk(cid) { K = freshK(cid); drawK(); }
function drawK() {
  const link = reviewLink(), c = D.customers.find((x) => x.id === K.cid);
  const gBtn = (cls) => (link ? `<a class="btn ${cls} k-btn" target="_blank" rel="noopener" href="${esc(link)}" data-k="opened">Write a Google review</a>` : "");
  let h;
  if (K.step === "rate") h = `<p class="k-biz">${esc(D.biz.name)}</p><h1 class="k-q">${c ? esc(c.name.split(" ")[0]) + ", how" : "How"} was your visit today?</h1><p class="k-sub">Tap a star. It takes 5 seconds.</p><div class="k-stars">${[1, 2, 3, 4, 5].map((n) => `<button class="k-star" data-k="rate" data-n="${n}" aria-label="${n} stars: ${FACES[n]}"><span aria-hidden="true">★</span><b class="num" style="font-size:20px;color:var(--ink)">${n}</b><small>${FACES[n]}</small></button>`).join("")}</div>`;
  else if (K.step === "happy") h = `<div class="k-big" aria-hidden="true">🎉</div><h1 class="k-q">Thank you! We're so glad you enjoyed it.</h1><p class="k-sub">Would you share that on Google? It helps other people find ${esc(D.biz.name)}.</p>${link ? `<div class="k-qr"><div id="k-qr"></div><span>Scan with your phone camera</span></div>` : ""}<div class="k-actions">${gBtn("primary")}<button class="btn ghost k-btn" data-k="done">Done</button></div>`;
  else if (K.step === "unhappy") h = `<h1 class="k-q">We're sorry we let you down.</h1><p class="k-sub">Please tell the owner what went wrong. It goes straight to them, privately, and they read every message.</p><div class="chips k-chips">${ISSUES.map((t) => `<button class="chip" data-k="tag" data-t="${t}" aria-pressed="${K.tags.includes(t)}">${t}</button>`).join("")}</div><textarea id="k-text" placeholder="Tell the owner what happened (optional)" aria-label="What happened">${esc(K.text)}</textarea>${c ? "" : `<input id="k-phone" inputmode="tel" placeholder="Your number, so the owner can call you back (optional)" value="${esc(K.phone)}" aria-label="Your phone number">`}<div class="k-actions"><button class="btn primary k-btn" data-k="send">Send privately to the owner</button></div>${link ? `<p class="k-quiet">You can also <a href="${esc(link)}" target="_blank" rel="noopener" data-k="opened">post a public review on Google</a>.</p>` : ""}`;
  else h = `<div class="k-big" aria-hidden="true">🙏</div><h1 class="k-q">${K.rating >= 4 && !K.text ? "Thank you for visiting! See you again soon." : "Thank you for telling us. The owner will see this today."}</h1>${link && K.rating <= 3 ? `<p class="k-quiet">You can also <a href="${esc(link)}" target="_blank" rel="noopener" data-k="opened">post a public review on Google</a>.</p>` : ""}<div class="k-actions"><button class="btn primary k-btn" data-k="again">Next customer</button></div>`;
  $("#kiosk-root").innerHTML = `<div class="kiosk" role="dialog" aria-modal="true" aria-label="Customer feedback"><button class="btn sm ghost k-exit" data-k="exit">Exit</button><div class="k-inner">${h}</div></div>`;
  if (K.step === "happy" && link && window.QRCode) new QRCode($("#k-qr"), { text: link, width: 190, height: 190, colorDark: "#16203a", colorLight: "#ffffff" });
  clearTimeout(K.timer); if (K.step === "happy" || K.step === "thanks") K.timer = setTimeout(() => { if (K) { K = freshK(); drawK(); } }, K.step === "happy" ? 120000 : 20000);
}
async function saveK(extra = {}) {
  try { K.fid = await q(sb.rpc("counter_feedback", { p_business: BID, p_customer: K.cid || null, p_rating: K.rating, p_tags: K.tags, p_text: K.text, p_phone: K.phone, p_opened_google: !!extra.opened, p_id: K.fid })); }
  catch (e) { toast(e.message, "error"); }
}
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-k]"); if (!el || !K) return; const k = el.dataset.k;
  if (k === "exit") { clearTimeout(K.timer); K = null; $("#kiosk-root").innerHTML = ""; await reload("feedback"); softRender(); return; }
  if (k === "rate") { K.rating = +el.dataset.n; K.step = K.rating >= 4 ? "happy" : "unhappy"; drawK(); saveK(); }
  if (k === "opened") saveK({ opened: true });
  if (k === "improve") { K.step = "unhappy"; drawK(); }
  if (k === "tag") { K.text = $("#k-text")?.value || K.text; K.phone = $("#k-phone")?.value || K.phone; K.tags = K.tags.includes(el.dataset.t) ? K.tags.filter((x) => x !== el.dataset.t) : [...K.tags, el.dataset.t]; drawK(); }
  if (k === "send") { K.text = ($("#k-text")?.value || "").trim(); K.phone = ($("#k-phone")?.value || "").trim(); K.step = "thanks"; drawK(); saveK(); }
  if (k === "done") { K.step = "thanks"; drawK(); }
  if (k === "again") { K = freshK(); drawK(); }
});

/* ---------- forms ---------- */
function customerForm(c = { tags: [] }) {
  formModal({ title: c.id ? "Edit customer" : "Add customer", values: { ...c, tags: (c.tags || []).join(", "), phone: c.phone ? prettyPhone(c.phone) : "" },
    fields: [{ key: "name", label: "Name", required: true }, { key: "phone", label: "Mobile number", required: true }, { key: "birthday", label: "Birthday", type: "date" }, { key: "email", label: "Email", type: "email" },
      { key: "tags", label: "Tags, separated by commas", full: true, placeholder: "VIP, Regular" }, { key: "notes", label: "Notes", type: "textarea", full: true }],
    extraFoot: c.id ? `<button type="button" class="btn danger" style="margin-right:auto" id="cust-del">Delete</button>` : "",
    onSave: async (v) => { const row = { name: v.name, phone: normPhone(v.phone, D.biz.country_code), birthday: v.birthday || null, email: v.email || null, tags: v.tags.split(",").map((s) => s.trim()).filter(Boolean), notes: v.notes };
      if (row.phone.length < 11) throw new Error("Enter a valid mobile number");
      if (c.id) await q(sb.from("customers").update(row).eq("id", c.id)); else await q(sb.from("customers").insert({ ...row, business_id: BID }));
      await reload("customers"); toast("Customer saved"); render(); } });
  if (c.id) $("#cust-del").onclick = async () => { if (await confirmBox(`Delete ${c.name}?`, "Their visits stay in your revenue numbers.", "Delete", { danger: true })) { await q(sb.from("customers").delete().eq("id", c.id)); await reload("customers"); render(); } };
}
function couponForm(k = { type: "percent", active: true }) {
  formModal({ title: k.id ? "Edit coupon" : "New coupon", values: k,
    fields: [{ key: "code", label: "Code", required: true, placeholder: "WELCOME10" }, { key: "title", label: "Name (for you)" }, { key: "type", label: "Type", type: "select", options: [["percent", "Percent off"], ["flat", "Flat ₹ off"]] },
      { key: "value", label: "Value", type: "number", required: true, min: 1 }, { key: "max_discount", label: "Max discount ₹ (percent only)", type: "number", min: 0 }, { key: "min_bill", label: "Minimum bill ₹", type: "number", min: 0 },
      { key: "expiry", label: "Valid till", type: "date" }, { key: "usage_limit", label: "Total uses (empty = unlimited)", type: "number", min: 0 },
      { key: "show_to_customers", label: "Show in the customer app", type: "checkbox", full: true }, { key: "active", label: "Active", type: "checkbox", full: true }],
    extraFoot: k.id ? `<button type="button" class="btn danger" style="margin-right:auto" id="cp-del">Delete</button>` : "",
    onSave: async (v) => { const row = { ...v, code: v.code.toUpperCase().replace(/\s+/g, ""), max_discount: v.max_discount || 0, min_bill: v.min_bill || 0, usage_limit: v.usage_limit || 0, expiry: v.expiry || null };
      if (k.id) await q(sb.from("coupons").update(row).eq("id", k.id)); else await q(sb.from("coupons").insert({ ...row, business_id: BID })); await reload("coupons"); toast("Coupon saved"); render(); } });
  if (k.id) $("#cp-del").onclick = async () => { if (await confirmBox("Delete coupon?", "Past redemptions stay in your sales.", "Delete", { danger: true })) { await q(sb.from("coupons").delete().eq("id", k.id)); await reload("coupons"); render(); } };
}
function importModal() {
  const m = openModal(`<div class="modal-head"><h2>Import customers</h2><button class="btn ghost" data-close>Close</button></div>
    <p class="small muted" style="margin-bottom:10px">One per line: <b>name, phone, birthday (YYYY-MM-DD), tags</b>. Paste from Excel or Google Sheets.</p>
    <textarea id="imp" style="min-height:180px" placeholder="Priya Sharma, 9876543210, 1990-11-10, VIP"></textarea><div class="row" style="margin-top:8px"><input type="file" id="imp-f" accept=".csv,.txt" aria-label="CSV file"></div><p class="err" id="imp-err"></p>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="imp-go">Import</button></div>`);
  m.querySelector("#imp-f").onchange = async (e) => { const f = e.target.files[0]; if (f) m.querySelector("#imp").value = await f.text(); };
  m.querySelector("#imp-go").onclick = async () => {
    const have = new Set(D.customers.map((c) => c.phone)); let skipped = 0; const rows = [];
    for (const line of m.querySelector("#imp").value.split(/\r?\n/)) { const [name, phone, bday, ...tags] = line.split(/\t|,/).map((s) => s.trim().replace(/^"|"$/g, ""));
      const p = normPhone(phone, D.biz.country_code); if (!name || p.length < 11 || have.has(p) || /name/i.test(name)) { if (line.trim()) skipped++; continue; } have.add(p);
      rows.push({ business_id: BID, name, phone: p, birthday: /^\d{4}-\d{2}-\d{2}$/.test(bday || "") ? bday : null, tags: tags.flatMap((t) => t.split(/[;|]/)).map((t) => t.trim()).filter(Boolean), notes: "Imported" }); }
    try { for (let i = 0; i < rows.length; i += 500) await q(sb.from("customers").insert(rows.slice(i, i + 500))); closeModal(); await reload("customers"); toast(`Imported ${rows.length}${skipped ? `, skipped ${skipped}` : ""}`); render(); }
    catch (e) { m.querySelector("#imp-err").textContent = e.message; }
  };
}
function exportCSV() {
  const rows = [["name", "phone", "birthday", "tags", "visits", "spend", "last_visit", "stamps", "review"]].concat(D.customers.map((c) => [c.name, c.phone, c.birthday || "", (c.tags || []).join(";"), c.visits, c.spend, (c.last_visit || "").slice(0, 10), c.stamps, c.review_status]));
  copy(rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n"), "Customer list copied as CSV");
}

/* ---------- actions ---------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-a]"); if (!el || !D.biz) return;
  const a = el.dataset.a, id = el.dataset.id, cust = () => D.customers.find((c) => c.id === id);
  try {
    switch (a) {
      case "scan": startScan(); break;
      case "card-copy": copy(cardUrl(cust()), "Card link"); break;
      case "visit": visitModal(); break;
      case "kiosk": closeModal(); kiosk(id); break;
      case "seg": custSeg = id; render(); break;
      case "cust-new": customerForm(); break;
      case "cust-edit": customerForm(cust()); break;
      case "import": importModal(); break;
      case "export": exportCSV(); break;
      case "card": cardModal(cust()); break;
      case "card-full": closeModal(); $("#kiosk-root").innerHTML = `<div class="kiosk"><button class="btn sm ghost k-exit" data-a="close-full">Close</button><div class="k-inner"><p class="k-biz">${esc(D.biz.name)}</p><h1 class="k-q">Your loyalty card</h1>${loyaltyCard({ bizName: D.biz.name, prog: D.prog, rewards: D.rewards, customer: cust() })}<div id="k-cardqr" style="background:#fff;padding:10px;border-radius:14px;margin:16px auto 0;width:max-content;line-height:0"></div><p class="k-fine">Scan to save this card on your phone.</p></div></div>`; if (window.QRCode) new QRCode($("#k-cardqr"), { text: cardUrl(cust()), width: 150, height: 150, colorDark: "#16203a", colorLight: "#ffffff" }); break;
      case "close-full": $("#kiosk-root").innerHTML = ""; break;
      case "mark-reviewed": await q(sb.from("customers").update({ review_status: "reviewed" }).eq("id", id)); await reload("customers"); toast("Marked as reviewed ⭐"); render(); break;
      case "mark-asked": await q(sb.from("customers").update({ review_status: "requested", review_requested_at: new Date().toISOString() }).eq("id", id)); await reload("customers"); render(); break;
      case "copy": copy(el.dataset.text); break;
      case "fb-resolve": await q(sb.from("feedback").update({ status: "resolved" }).eq("id", id)); await reload("feedback"); toast("Resolved"); render(); break;
      case "fb-reopen": await q(sb.from("feedback").update({ status: "open" }).eq("id", id)); await reload("feedback"); render(); break;
      case "coupon-new": couponForm(); break;
      case "coupon-edit": couponForm(D.coupons.find((k) => k.id === id)); break;
      case "rem-done": case "rem-toggle": { const r = D.reminders.find((x) => x.id === id); await q(sb.from("reminders").update({ done: a === "rem-done" ? true : !r.done }).eq("id", id)); await reload("reminders"); render(); break; }
      case "rem-del": await q(sb.from("reminders").delete().eq("id", id)); await reload("reminders"); render(); break;
      case "ly-theme": lyRead(); LD.theme = id; render(); break;
      case "ly-add": { lyRead(); const used = new Set(LD.mids.map((r) => r.visit_no)); let v = 1; while (used.has(v) && v < LD.stamps - 1) v++; if (!used.has(v) && v < LD.stamps) LD.mids.push({ visit_no: v, type: "percent", value: 10, max_discount: 0, note: "" }); LD.mids.sort((x, y) => x.visit_no - y.visit_no); render(); break; }
      case "ly-del": lyRead(); LD.mids.splice(+id, 1); render(); break;
      case "ly-reset": LD = null; render(); break;
      case "ly-save": lyRead(); await q(sb.rpc("save_loyalty", { p_business: BID, p: compiled() })); await reload("loyalty"); LD = null; toast("Loyalty card saved"); render(); break;
      case "wa-one": await waOne(cust(), el.dataset.tpl); break;
      case "kw-add-s": await addKw(el.dataset.kw, "suggested"); break;
      case "kw-del": await q(sb.from("business_keywords").delete().eq("id", id)); await seoLoad(); drawSeo(); break;
      case "kw-ai": { el.disabled = true; el.innerHTML = `<span class="spinner"></span> Thinking…`;
        try { const r = await aiCall("suggest_keywords", {}); D.kwAi = r.keywords || []; toast(`${D.kwAi.length} new ideas added to suggestions`); }
        catch (e) { if (e.fallback) { const cat = (D.biz.categories?.name || "shop").toLowerCase().split(" & ")[0], c = cityOf() || "my city";
            D.kwAi = [`${cat} near me`, `best ${cat} in ${c}`, `${cat} in ${c}`, `affordable ${cat} ${c}`, `top rated ${cat} ${c}`, `${cat} open now ${c}`]; toast("Added a few common search ideas below");
          } else toast(e.message, "error"); }
        drawSeo(); break; }
      case "seo-kind": SEO = { kind: id, out: "", input: SEO.kind === id ? SEO.input : {} }; drawSeo(); break;
      case "seo-go": {
        if (SEO.kind === "post" && !(SEO.input.topic || "").trim()) { toast("Write what the post is about", "error"); break; }
        if (SEO.kind === "reply" && !(SEO.input.review || "").trim()) { toast("Paste the customer's review first", "error"); break; }
        el.disabled = true; el.innerHTML = `<span class="spinner"></span> Writing…`;
        try { const r = await aiCall(SEO.kind, SEO.input); SEO.out = r.text || ""; }
        catch (e) { if (e.fallback) { SEO.out = templateDraft(SEO.kind, SEO.input); toast("Drafted from a template (AI writing isn't switched on yet). Edit it to make it yours."); } else toast(e.message, "error"); }
        drawSeo(); break; }
      case "seo-copy": copy($("#seo-out").value, "Draft copied"); break;
      case "seo-save": { const body = $("#seo-out").value.trim(); if (!body) { toast("Nothing to save yet", "error"); break; }
        await q(sb.from("business_content").insert({ business_id: BID, kind: SEO.kind, title: (SEO.input.topic || SEO.input.reviewer || "").slice(0, 80), body })); await seoLoad(); drawSeo(); toast("Saved to your library"); break; }
      case "seo-del": await q(sb.from("business_content").delete().eq("id", id)); await seoLoad(); drawSeo(); break;
      case "wa-compose": WA.aud = el.dataset.aud || "all"; location.hash = "whatsapp"; break;
      case "wa-buy": location.hash = "whatsapp"; document.querySelector("#wa-view") && openModal(`<div class="modal-head"><h2>Buy WhatsApp credits</h2><button class="btn ghost" data-close>Close</button></div><p class="small">You have ${balText()}.</p>${customBuy()}${packGroups(D.packs || [], true)}`, { wide: true }); break;
      case "buy-pack": closeModal(); await order("wa_credits", id); break;
      case "buy-custom": { const { m, u } = customTotal(), err = $("#cb-err");
        try { const r = await q(sb.rpc("order_wa_credits", { p_business: BID, p_marketing: m, p_utility: u })); closeModal(); D.pays = null; await payModal(r.payment_id); }
        catch (e2) { if (err) err.textContent = e2.message; else toast(e2.message, "error"); } break; }
      case "buy-product": if (await confirmBox("Buy this service?", "We'll create a payment for it. Branditude's team will contact you to get started once it's paid.", "Continue to payment")) await order("product", id); break;
      case "buy-module": {
        const m = (D.mods || []).find((x) => x.id === id); if (!m) break;
        const want = [...new Set([...(D.biz.addon_modules || []), m.key])];
        PKGS_CACHE = PKGS_CACHE || (await q(sb.from("packages").select("*").eq("active", true).order("sort")).catch(() => []));
        const cost = (D.biz.packages?.monthly_price || 0) + want.reduce((t, k) => t + (+(modInfo(k)?.addon_price) || 0), 0);
        const better = PKGS_CACHE.find((p) => p.id !== D.biz.package_id && want.every((k) => (p.modules || []).includes(k)) && +p.monthly_price <= cost);
        const msg = better ? `The ${better.name} plan (${inr(better.monthly_price)}/month) already includes ${m.name}${want.length > 1 ? " and your other add-ons" : ""}, for the same or less than adding them one by one.` : m.blurb;
        if (better && await confirmBox(`Switch to ${better.name} instead?`, msg, `Switch to ${better.name}`)) { await order("subscription", better.id, D.biz.billing || "monthly"); break; }
        if (await confirmBox(`Add ${m.name}?`, better ? "We'll create a payment for the add-on only." : msg, "Continue to payment")) await order("module", id);
        break; }
      case "renew": await order("subscription", id, el.dataset.bill); break;
      case "upgrade-to": { PKGS_CACHE = PKGS_CACHE || (await q(sb.from("packages").select("*").eq("active", true).order("sort")));
        const pl = PKGS_CACHE.find((p) => (p.modules || []).includes(id));
        if (pl && await confirmBox(`Upgrade to ${pl.name}?`, `${pl.name} is ${inr(pl.monthly_price)}/month and includes ${modInfo(id)?.name || "this"}. Your current plan's paid days carry on until you pay.`, `Continue to payment`)) await order("subscription", pl.id, D.biz.billing || "monthly");
        break; }
      case "am-save": { const box = el.closest("[data-auto]"), v = (k) => box.querySelector(`[data-am="${k}"]`);
        const row = { business_id: BID, kind: id, enabled: v("enabled").checked, days: v("days") ? +v("days").value || 0 : 0, times: v("times") ? Math.min(5, Math.max(1, +v("times").value || 1)) : 1,
          gap_days: v("gap_days") ? Math.min(60, Math.max(1, +v("gap_days").value || 3)) : 3, offer: v("offer") ? v("offer").value.trim() : "", daily_cap: v("daily_cap") ? Math.min(1000, Math.max(1, +v("daily_cap").value || 50)) : 1000, updated_at: new Date().toISOString() };
        if (row.enabled && !(await confirmBox("Turn this reminder on?", `Charges apply: each message uses 1 ${AUTO[id].util ? "utility" : "promotional"} credit${AUTO[id].util ? (D.waRates ? ` (about ${inr2(+D.waRates.utility)})` : "") : D.perMsg ? ` (about ${inr2(D.perMsg[0])}–${inr2(D.perMsg[1])})` : ""}. ${AUTO[id].instant ? "One message per visit, using a utility credit." : `Up to ${row.daily_cap} messages a day.`} You can turn it off any time.`, "Turn on")))
          break;
        await q(sb.from("auto_msgs").upsert(row, { onConflict: "business_id,kind" })); toast(row.enabled ? (AUTO[id].instant ? "On. Customers get it right after each visit." : "Reminder on. It runs every morning.") : "Reminder saved (off)"); after.whatsapp(); break; }
      case "tpl-submit": { const v = (x) => $("#" + x).value.trim(); const n = $$("[data-ntp]").length;
        try { await q(sb.rpc("submit_wa_template", { p_business: BID, p: { title: v("nt-title"), category: v("nt-cat"), language: v("nt-lang"), body: v("nt-body"),
            params: Array.from({ length: n }, (_, i) => v("nt-p" + i)), sample: Array.from({ length: n }, (_, i) => v("nt-s" + i)) } }));
          toast("Sent to Branditude for approval"); after.templates(); } catch (e) { $("#nt-err").textContent = e.message; }
        break; }
      case "pay": await payModal(id); break;
      case "wa-send": {
        const t = D.tpls.find((x) => x.id === WA.tpl), aud = audience(WA.aud).filter((c) => c.phone);
        if (!(await confirmBox(`Send to ${aud.length} customers?`, `This uses ${aud.length * t.credits_per_message} ${CREDIT[kindOf(t)].short} credits. Failed messages are refunded.`, "Send now"))) break;
        el.disabled = true; el.innerHTML = `<span class="spinner"></span> Sending…`;
        const r = await sendWA(aud.map((c) => c.id), t.id, WA.params.slice(0, t.params.length), t.title);
        D.wallet = r.balance; D.walletU = r.utility_balance ?? D.walletU; toast(`Sent ${r.sent}${r.failed ? `, ${r.failed} failed (refunded)` : ""}`); WA.params = []; after.whatsapp(); break;
      }
    }
  } catch (err) { toast(err.message, "error"); }
});

/* ---------- Staff, salary, QR menu, orders (separate modules) ---------- */
const moduleApi = { VIEWS, after, head, kpi, can, hasMod, reload, render, ctx: () => ({ D, BID, canWrite: canWrite() }), isRoute: (r) => route() === r, setOrderBadge: (n) => { if (D.newOrders !== n) { D.newOrders = n; nav(); } } };
registerStaff(moduleApi);
registerMenu(moduleApi);
registerTeam(moduleApi);
registerAccounts(moduleApi);
