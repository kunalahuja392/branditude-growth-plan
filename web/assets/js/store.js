// Public store (home, product pages, gaming). Prices and plans come live from the database (Admin → Packages).
import { sb, configured, friendly } from "./sb.js";
import { phoneInput, readPhone, phoneOk, phoneHint } from "./ui.js";
import { payOnline } from "./razorpay.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(+n || 0));
const inr2 = (n) => "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(+n || 0);
const PAGE = document.body.dataset.page || "home";
const GAMING_HOST = /^gamingclubs\./.test(location.hostname) || new URLSearchParams(location.search).get("for") === "gaming-club";
if (GAMING_HOST && PAGE === "home") location.replace("/gaming" + location.search.replace(/([?&])for=gaming-club&?/, "$1").replace(/\?$/, ""));

// Product colour + name for each module (keeps the site and the plan chips in one language)
const PROD = { reviews: ["p-rev", "Review & Feedback"], loyalty: ["p-loy", "Loyalty Card"], attendance: ["p-stf", "Staff Attendance"], menu: ["p-qr", "QR Menu"] };
let CATS = [], PKGS = [], MODS = [], SET = {}, billing = "monthly", TRIAL = 0;
const per = () => (billing === "yearly" ? "/year" : "/month");
const price = (p, b = billing) => (b === "yearly" ? +p.yearly_price : +p.monthly_price) * (1 - (+p.discount_percent || 0) / 100);
const plans = () => PKGS.filter((p) => (p.kind || "plan") === "plan" && !p.categories);
const gamingPlans = () => PKGS.filter((p) => (p.kind || "plan") === "plan" && (p.categories || []).includes("gaming-club"));
const bySlug = (s) => PKGS.find((p) => p.slug === s);
const mod = (k) => MODS.find((m) => m.key === k);
const worth = (p) => (p.modules || []).reduce((t, k) => t + (mod(k) && !mod(k).core ? +mod(k).addon_price || 0 : 0), 0) * (billing === "yearly" ? 10 : 1);
const waNum = () => (SET.agency?.whatsapp || "918855837148").replace(/\D/g, "");
const waLink = (t) => (waNum() ? "https://wa.me/" + waNum() + "?text=" + encodeURIComponent(t) : "#contact");
function toast(m) { const t = document.createElement("div"); t.className = "toast"; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2800); }

async function load() {
  if (!configured) return;
  const [c, p, s, md] = await Promise.all([
    sb.from("categories").select("*").order("sort"), sb.from("packages").select("*").order("sort"),
    sb.from("settings").select("key,value"), sb.from("modules").select("*").eq("active", true).order("sort"),
  ]);
  if (c.error || p.error) { $$("[data-plans]").forEach((el) => (el.innerHTML = `<p class="muted">Couldn't load prices. ${esc(friendly(c.error || p.error))}</p>`)); return; }
  CATS = c.data || []; PKGS = (p.data || []).filter((x) => x.active !== false); MODS = md.data || [];
  SET = Object.fromEntries((s.data || []).map((x) => [x.key, x.value]));
  TRIAL = Math.max(0, parseInt(SET.trial?.days ?? 0, 10) || 0);
  $$("[data-wa]").forEach((a) => (a.href = waLink(a.dataset.wa)));
  contactInfo(); drawAll();
}
function drawAll() {
  // live single-product prices anywhere on the page: <b data-price="loyalty-card">
  $$("[data-price]").forEach((el) => { const p = bySlug(el.dataset.price); if (p) el.textContent = inr(price(p)); });
  $$("[data-per]").forEach((el) => (el.textContent = per()));
  $$("[data-bill]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.bill === billing));
  const gr = +(SET.gst?.rate ?? 0);
  $$("[data-gst]").forEach((el) => (el.textContent = gr > 0 ? `Prices exclude ${Math.round(gr * 100)}% GST, added at checkout.` : "Prices are in Indian rupees. No GST is charged."));
  if (TRIAL) $$("[data-trial]").forEach((el) => { el.hidden = false; el.textContent = `${TRIAL}-day free trial`; });
  if (TRIAL) $$("[data-trialnote]").forEach((el) => { el.hidden = false; el.innerHTML = `<b>Try it free for ${TRIAL} days.</b> Sign up and use everything now, no payment needed to start.`; });
  drawPlans(); drawGaming(); drawAddons(); drawTables();
}
function planCard(p, dark) {
  const w = worth(p), pr = price(p), chips = (p.modules || []).filter((k) => PROD[k]).map((k) => `<span class="${PROD[k][0]}">${PROD[k][1]}</span>`).join("");
  return `<article class="plan${p.is_popular ? " pop" : ""}">${p.is_popular ? `<span class="badge">${dark ? "Best value" : "Most popular"}</span>` : ""}
    <div><h3>${esc(p.name)}</h3><p class="for">${esc(p.tagline || "")}</p></div>
    <div class="amt"><b class="num">${inr(pr)}</b><span>${per()}</span></div>
    ${!dark && w > pr ? `<p class="worth">Bought separately <s class="num">${inr(w)}</s>. You save <b class="num">${inr(w - pr)}</b>${per()}.</p>` : ""}
    ${chips ? `<div class="incl">${chips}</div>` : ""}
    <ul>${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    <button class="btn ${p.is_popular ? "primary" : dark ? "line" : "dark"} block" data-buy="${p.slug}">Get ${esc(p.name)}</button></article>`;
}
function drawPlans() { const el = $("[data-plans=main]"); if (el) el.innerHTML = plans().map((p) => planCard(p)).join(""); }
function drawGaming() { const el = $("[data-plans=gaming]"); if (el) el.innerHTML = gamingPlans().map((p) => planCard(p, true)).join(""); }
function drawAddons() {
  const el = $("[data-addons]"); if (!el) return;
  const list = MODS.filter((m) => !m.core && m.addon_price != null && !(m.categories || []).includes("gaming-club"));
  el.innerHTML = list.map((m) => { const pk = Object.entries(PROD).find(([k]) => k === m.key);
    return `<div class="ad-row ${pk ? pk[1][0] : ""}"><span class="dot" style="background:${pk ? "var(--soft)" : "var(--mist)"};font-size:20px" aria-hidden="true">${esc(m.icon)}</span>
      <div class="g"><b>${esc(m.name)}</b><span>${esc(m.blurb)}${m.key === "menu" ? " Price is per 6 tables." : ""}${(m.categories || []).length ? " Restaurants, bakeries and hotels." : ""}</span></div>
      <div class="pr num">${inr(+m.addon_price * (billing === "yearly" ? 10 : 1))}<small>${per()}</small></div></div>`; }).join("");
}
// QR menu page: ₹249 per 6 tables
const TIERS = () => PKGS.filter((p) => /^qr-menu-\d+$/.test(p.slug)).sort((a, b) => a.max_tables - b.max_tables);
let tierIx = 0;
function drawTables() {
  const box = $("[data-tables]"); if (!box) return; const t = TIERS(); if (!t.length) return;
  tierIx = Math.min(tierIx, t.length); const p = t[tierIx];
  $("[data-tables-out]").textContent = p ? `Up to ${p.max_tables} tables` : `More than ${t[t.length - 1].max_tables}`;
  $("[data-tables-price]").textContent = p ? inr(price(p)) : "Let's talk";
  $("[data-tables-per]").textContent = p ? per() : "";
  const buy = $("[data-tables-buy]");
  if (p) { buy.dataset.buy = p.slug; buy.textContent = `Get QR Menu for ${p.max_tables} tables`; buy.removeAttribute("href"); }
  else { delete buy.dataset.buy; buy.textContent = "Ask us on WhatsApp"; }
}
function contactInfo() {
  const a = SET.agency || {}, row = (label, val, href) => (val ? `<div><small>${label}</small>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(val)}</a>` : `<span>${esc(val)}</span>`}</div>` : "");
  $$("[data-cinfo]").forEach((el) => (el.innerHTML = row("WhatsApp", a.whatsapp ? "+" + a.whatsapp : "", a.whatsapp ? waLink("Hi Branditude!") : "") + row("Call", a.phone, a.phone ? "tel:" + a.phone : "") + row("Email", a.email, a.email ? "mailto:" + a.email : "") + row("Office", a.address) + row("Hours", a.hours)));
  $$("[data-year]").forEach((el) => (el.textContent = "© " + new Date().getFullYear() + " " + (a.legal_name || "Branditude Global")));
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-bill]"); if (b) { billing = b.dataset.bill; drawAll(); }
  const t = e.target.closest("[data-tstep]"); if (t) { tierIx = Math.max(0, Math.min(TIERS().length, tierIx + +t.dataset.tstep)); drawTables(); }
  const tb = e.target.closest("[data-tables-buy]"); if (tb && !tb.dataset.buy) { e.preventDefault(); location.href = waLink("Hi Branditude, I need the QR Menu for more than 24 tables."); return; }
  const buy = e.target.closest("[data-buy]"); if (buy) { e.preventDefault(); if (!PKGS.length) return toast("Loading prices, try again in a second"); openCheckout(buy.dataset.buy); }
});

/* ---------- checkout ---------- */
let co = null;
const catOk = (p) => CATS.filter((c) => (p.categories || []).length ? p.categories.includes(c.slug) : c.slug !== "gaming-club");
function openCheckout(slug) {
  const p = bySlug(slug); if (!p) return;
  let saved = ""; try { saved = localStorage.getItem("bgp_cat") || ""; } catch {}
  const cats = catOk(p);
  co = { step: 1, pkg: p, billing, cat: cats.find((c) => c.id === saved)?.id || (cats.length === 1 ? cats[0].id : ""), products: [],
    promo: (() => { try { return localStorage.getItem("bgp_ref") || ""; } catch { return ""; } })(), biz: {}, quote: null, mode: "signup" };
  document.body.style.overflow = "hidden"; draw();
}
function close() { $("#checkout-root").innerHTML = ""; document.body.style.overflow = ""; co = null; }
async function refreshQuote() {
  const { data, error } = await sb.rpc("quote", { p_package: co.pkg.id, p_billing: co.billing, p_products: [], p_promo: co.promo || null, p_category: co.cat || null });
  co.quote = error ? null : data; const el = $("#co-sum"); if (el) el.innerHTML = summary();
}
const pkgLabel = (p) => p.name + (p.kind === "single" && p.max_tables ? ` · up to ${p.max_tables} tables` : (p.kind || "plan") === "plan" ? " plan" : "");
const summary = () => { const q = co.quote; if (!q) return `<p class="muted">Working out your total…</p>`;
  return `${q.lines.map((l) => `<div class="srow"><span>${esc(l.label.replace(/ plan \(/, (co.pkg.kind === "single" ? " (" : " plan (")))}</span><span class="num">${inr2(l.amount)}</span></div>`).join("")}${+q.gst ? `<div class="srow"><span>GST</span><span class="num">${inr2(q.gst)}</span></div>` : ""}<div class="srow total"><span>Total today</span><span class="num">${inr2(q.total)}</span></div>${q.promo_message ? `<p class="${q.promo_ok ? "ok-msg" : "err"}" style="font-size:14px;margin-top:6px">${esc(q.promo_message)}</p>` : ""}`; };
function readStep1() {
  const v = (id) => ($("#" + id)?.value || "").trim();
  co.biz = { name: v("b-name"), contact_name: v("b-owner"), phone: readPhone("b-phone"), email: v("b-email"), city: v("b-city") };
  if ($("#b-cat")) co.cat = v("b-cat"); co.promo = v("b-promo");
}
const colourOf = (p) => { const k = (p.modules || []).find((m) => PROD[m]); return p.kind === "single" && k ? PROD[k][0] : ""; };
function draw() {
  const steps = ["Your business", "Create your login", co.result?.trial ? "Your free trial has started" : "Pay", "Done"];
  let body = "", foot = ""; const p = co.pkg, cats = catOk(p);
  if (co.step === 1) {
    body = `<div class="buying ${colourOf(p)}"><div style="flex:1"><span>You're getting</span><b>${esc(pkgLabel(p))}</b></div>
        <div class="bill-toggle" style="margin:0"><button type="button" data-cobill="monthly" aria-pressed="${co.billing === "monthly"}">Monthly</button><button type="button" data-cobill="yearly" aria-pressed="${co.billing === "yearly"}">Yearly</button></div></div>
      <div class="fields">
      <div class="field"><label for="b-name">Business name</label><input id="b-name" value="${esc(co.biz.name || "")}" autocomplete="organization" placeholder="e.g. Chai Point Café"></div>
      ${cats.length > 1 ? `<div class="field"><label for="b-cat">Type of business</label><select id="b-cat"><option value="">Choose one</option>${cats.map((c) => `<option value="${c.id}" ${co.cat === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>` : ""}
      <div class="field"><label for="b-owner">Your name</label><input id="b-owner" value="${esc(co.biz.contact_name || "")}" autocomplete="name"></div>
      <div class="field"><label for="b-phone">WhatsApp number</label>${phoneInput("b-phone", { value: co.biz.phone || "", placeholder: "98xxxxxxxx", label: "WhatsApp number" })}</div>
      <div class="field"><label for="b-email">Email</label><input id="b-email" type="email" value="${esc(co.biz.email || "")}" autocomplete="email"></div>
      <div class="field"><label for="b-city">City</label><input id="b-city" value="${esc(co.biz.city || "")}" autocomplete="address-level2"></div></div>
      <div class="row2"><input id="b-promo" placeholder="Promo or referral code" value="${esc(co.promo)}" style="max-width:240px" aria-label="Promo code"><button class="btn sm line" data-co="promo">Apply</button></div>
      <div class="summary" id="co-sum">${summary()}</div><p class="err" id="err" role="alert"></p>`;
    foot = `<button class="btn line sm" data-co="enquire">Call me instead</button><button class="btn primary" data-co="next1">Continue</button>`;
  } else if (co.step === 2) {
    body = `<p style="color:var(--ink-2)">You'll use this email and password to open your dashboard on any phone or computer.</p>
      <div class="fields" style="margin-top:14px"><div class="field full"><label for="a-email">Email</label><input id="a-email" type="email" value="${esc(co.biz.email || "")}" autocomplete="email"></div>
      <div class="field full"><label for="a-pass">${co.mode === "signup" ? "Create a password (8+ characters)" : "Password"}</label><input id="a-pass" type="password" minlength="8" autocomplete="${co.mode === "signup" ? "new-password" : "current-password"}"></div></div>
      <p style="margin-top:12px;font-size:15px">${co.mode === "signup" ? `Already have a login? <button class="link-btn" data-co="mode">Sign in instead</button>` : `New here? <button class="link-btn" data-co="mode">Create a login</button>`}</p>
      <div class="summary">${summary()}</div><p class="err" id="err" role="alert"></p>`;
    foot = `<button class="btn line sm" data-co="back">Back</button><button class="btn primary" data-co="next2">${co.mode === "signup" ? "Create login" : "Sign in"} and continue</button>`;
  } else if (co.step === 3) {
    const trialNote = co.result.trial ? `<div class="note" style="margin-bottom:18px"><b>Everything is unlocked until ${new Date(co.result.trial_ends + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "long" })}.</b> Pay now or any time before then to keep it running.</div>` : "";
    body = trialNote + `<button class="btn primary block" data-co="rzp">Pay ${inr2(co.result.total)}</button><p class="muted" style="font-size:14px;text-align:center;margin-top:8px">UPI, cards, netbanking or wallets through Razorpay. It switches on as soon as you pay.</p><p class="err" id="err" role="alert"></p>`;
    foot = co.result.trial ? `<a class="btn line sm" href="/app">Start my free trial first</a>` : `<a class="btn line sm" href="/app#plan">Pay later</a>`;
  } else {
    body = `<div class="done-mark"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></div>
      <h3>${co.pendingConfirm ? "Check your email" : co.enquiry ? "Thanks, we'll call you" : "You're all set"}</h3>
      <p style="color:var(--ink-2);margin-top:8px">${co.pendingConfirm ? "We've sent you a link to confirm your email. Open it on any phone and your business is set up automatically." : co.enquiry ? "Our team will call or WhatsApp you within one working day." : co.paidOnline ? "Payment received and switched on. Open your dashboard to get started." : "We'll confirm your payment shortly. You can start setting up your dashboard now."}</p>
      ${co.ref ? `<p style="margin-top:10px">Reference: <b>${esc(co.ref)}</b></p>` : ""}`;
    foot = co.enquiry || co.pendingConfirm ? `<button class="btn primary" data-co="close">Close</button>` : `<a class="btn primary" href="/app">Open my dashboard</a>`;
  }
  $("#checkout-root").innerHTML = `<div class="back" data-co="backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="co-title">
    <div class="sheet-head"><h2 id="co-title">${steps[co.step - 1]}</h2><button class="x" data-co="close" aria-label="Close">×</button></div>
    <div class="prog">${steps.map((s, i) => `<i class="${i < co.step ? "on" : ""}"></i>`).join("")}</div><div class="sheet-body">${body}</div><div class="sheet-foot">${foot}</div></div></div>`;
  if (co.step === 1 && !co.quote) refreshQuote();
}
const err = (m) => { const e = $("#err"); if (e) e.textContent = m; };
const validStep1 = () => { const b = co.biz; return !b.name ? "Enter your business name." : !co.cat ? "Choose your type of business." : !b.contact_name ? "Enter your name." : !phoneOk(b.phone) ? phoneHint(b.phone).replace("mobile", "WhatsApp") : !b.city ? "Enter your city." : ""; };
const regPayload = () => ({ name: co.biz.name, contact_name: co.biz.contact_name, phone: co.biz.phone ? "+" + co.biz.phone : "", email: co.biz.email, city: co.biz.city, category_id: co.cat, package_id: co.pkg.id, billing: co.billing, product_ids: [], promo_code: co.promo });
document.addEventListener("click", async (e) => {
  const cb = e.target.closest("[data-cobill]"); if (cb && co) { readStep1(); co.billing = cb.dataset.cobill; co.quote = null; return draw(); }
  const el = e.target.closest("[data-co]"); if (!el || !co) return; const a = el.dataset.co;
  if (a === "backdrop" && e.target !== el) return;
  if (a === "close" || a === "backdrop") return close();
  try {
    if (a === "promo") { readStep1(); co.quote = null; draw(); }
    if (a === "next1") { readStep1(); const m = validStep1(); if (m) return err(m);
      try { localStorage.setItem("bgp_cat", co.cat); } catch {}
      const { data } = await sb.auth.getSession(); if (data?.session) { el.disabled = true; return register(); } co.step = 2; draw(); }
    if (a === "enquire") { readStep1(); const m = validStep1(); if (m) return err(m); el.disabled = true;
      const { data, error } = await sb.rpc("submit_lead", { p: { ...regPayload(), business_name: co.biz.name, source: "enquiry" } }); if (error) throw error; co.enquiry = true; co.ref = data.ref; co.step = 4; draw(); }
    if (a === "mode") { co.mode = co.mode === "signup" ? "signin" : "signup"; draw(); }
    if (a === "back") { co.step = 1; draw(); }
    if (a === "next2") { const email = $("#a-email").value.trim(), password = $("#a-pass").value;
      if (!/^\S+@\S+\.\S+$/.test(email)) return err("Enter a valid email."); if (password.length < 8) return err("Password needs at least 8 characters.");
      el.disabled = true; co.biz.email = co.biz.email || email;
      const r = co.mode === "signup" ? await sb.auth.signUp({ email, password, options: { data: { full_name: co.biz.contact_name, signup_as: "business", pending_registration: regPayload() }, emailRedirectTo: new URL("/app", location.href).href } })
                                     : await sb.auth.signInWithPassword({ email, password });
      if (r.error) { el.disabled = false; return err(/registered/i.test(r.error.message) ? "This email already has a login. Sign in instead." : /Invalid login/i.test(r.error.message) ? "Wrong email or password." : friendly(r.error)); }
      if (!r.data.session) { try { localStorage.setItem("bgp_pending_registration", JSON.stringify(regPayload())); } catch {} co.pendingConfirm = true; co.step = 4; return draw(); }
      await register(); }
    if (a === "rzp") { el.disabled = true; el.textContent = "Opening…";
      try { const r = await payOnline(sb, co.payment_id); if (r === "paid") { co.paidOnline = true; co.step = 4; return draw(); } }
      catch (x) { err(/switched on yet/.test(x.message) ? "Online payment is being set up. You can pay later from your dashboard." : x.message); }
      el.disabled = false; el.textContent = `Pay ${inr2(co.result.total)}`; return; }
  } catch (x) { err(friendly(x)); el.disabled = false; }
});
async function register() {
  const { data, error } = await sb.rpc("register_business", { p: regPayload() });
  if (error) { err(friendly(error)); const b = $("[data-co=next1],[data-co=next2]"); if (b) b.disabled = false; return; }
  co.result = data; co.payment_id = data.payment_id; co.step = 3; draw();
}
document.addEventListener("change", (e) => { if (co?.step === 1 && e.target.id === "b-cat") { readStep1(); co.quote = null; refreshQuote(); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (co) close(); setMenu(false); } });

/* ---------- header, menu, sticky phone bar ---------- */
const bar = $("#topbar"), mb = $("#menu-btn");
function setMenu(o) { if (!bar) return; bar.classList.toggle("open", o); mb?.setAttribute("aria-expanded", o); document.body.style.overflow = o ? "hidden" : co ? "hidden" : ""; }
mb?.addEventListener("click", () => setMenu(!bar.classList.contains("open")));
$("#site-nav")?.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
$$(".drop > .navbtn").forEach((b) => b.addEventListener("click", () => { const d = b.parentElement, o = !d.classList.contains("open"); d.classList.toggle("open", o); b.setAttribute("aria-expanded", o); }));
document.addEventListener("click", (e) => { $$(".drop.open").forEach((d) => { if (!d.contains(e.target)) { d.classList.remove("open"); d.querySelector(".navbtn")?.setAttribute("aria-expanded", "false"); } }); });
const mbar = $("#mbar"), first = $(".hero, .phero");
const onScroll = () => { bar?.classList.toggle("solid", scrollY > 10);
  if (mbar && first) { const show = first.getBoundingClientRect().bottom < 0 && !co; mbar.classList.toggle("show", show); mbar.setAttribute("aria-hidden", !show); } $("#wa-float")?.classList.toggle("hide", !!(mbar && mbar.classList.contains("show")) || !!co); };
addEventListener("scroll", onScroll, { passive: true }); onScroll();
sb.auth.getSession().then(({ data }) => { if (!data?.session) return; $$("[data-signin]").forEach((b) => { b.textContent = "My dashboard"; b.href = "/app"; }); }).catch(() => {});
try { const r = new URLSearchParams(location.search).get("ref"); if (r) localStorage.setItem("bgp_ref", r.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20)); } catch {}
// install as app (pwa.js sets window.bgpInstall)
$$("[data-install]").forEach((b) => b.addEventListener("click", async () => { if (!window.bgpInstall) return (location.href = "/login");
  const r = await bgpInstall.prompt(); toast(r === "accepted" ? "Installed. Open Branditude from your home screen." : "On iPhone: Share → Add to Home Screen. On Android: ⋮ → Install app."); }));
// call-back forms (e.g. restaurant app early access)
document.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-lead]"); if (!f) return; e.preventDefault();
  const v = (n) => (f.elements[n]?.value || "").trim(), er = f.querySelector(".err"), btn = f.querySelector("button[type=submit]");
  const ph = v("phone").replace(/\D/g, "").replace(/^0+/, ""), phone = ph.length === 10 ? "91" + ph : ph;
  if (!v("business_name") || !v("contact_name") || !v("city")) return (er.textContent = "Please fill in every field.");
  if (!/^91[6-9]\d{9}$/.test(phone)) return (er.textContent = "Enter a 10-digit WhatsApp number.");
  btn.disabled = true; er.textContent = "";
  const { data, error } = await sb.rpc("submit_lead", { p: { business_name: v("business_name"), contact_name: v("contact_name"), phone: "+" + phone, city: v("city"), source: "enquiry",
    message: f.dataset.lead + (v("orders") ? ` · about ${v("orders")} delivery orders a day` : "") } });
  if (error) { btn.disabled = false; return (er.textContent = friendly(error)); }
  f.outerHTML = `<div class="done"><h3>Thanks, we'll call you</h3><p style="color:var(--ink-2);margin-top:8px">Our team will call or WhatsApp you within one working day to show you the app.</p><p style="margin-top:10px">Reference: <b>${esc(data?.ref || "")}</b></p></div>`;
});
load();
