// Business portal: gaming clubs (module "gaming", business type "Gaming Club")
//   #gboard    Live board: station timers, LP matches and splits, 15-min "time up" popup, snacks, billing
//   #gbookings Bookings (staff + online requests)      #gbills  Bills, pending amounts, WhatsApp follow-ups
//   #gstock    Snacks & stock, counter sale             #greports Gaming reports (owner)
//   #gsetup    Stations, pricing rules (happy hours…), bill settings, WhatsApp add-on (owner)
// All money maths runs in the database (gc_* functions); this file only draws and calls them.
import { sb, q } from "./sb.js";
import { $, $$, esc, inr, inr2, toast, copy, openModal, closeModal, modalOpen, confirmBox, formModal, phoneInput, readPhone, prettyPhone, fmtDT, todayISO } from "./ui.js";

let A;
const G = { board: null, at: 0, products: null, dismissed: {}, reminderOpen: false, ticker: null, poll: null, chan: null, site: null, setupTab: "stations", billQ: { from: "", to: "", status: "" }, repFrom: "", repTo: "" };
try { G.dismissed = JSON.parse(localStorage.getItem("gc_dismissed") || "{}"); } catch {}
const ctx = () => A.ctx();
const BID = () => ctx().BID;
const biz = () => ctx().D.biz;
const owner = () => A.can("settings");
const rpc = (fn, args) => q(sb.rpc(fn, args));
const hasWA = () => A.hasMod("wa_billing");
const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`);
const dur = (ms) => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
const tm = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "");
const TYPES = ["PS5", "PS4", "Xbox", "PC", "VR", "Racing sim", "Nintendo Switch", "Pool", "Snooker", "Foosball", "Other"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const spin = `<div class="loading"><span class="spinner"></span></div>`;
const err = (e) => toast(e.message || String(e), "error");
async function guard(btn, fn) { if (btn) btn.disabled = true; try { return await fn(); } catch (e) { err(e); } finally { if (btn) btn.disabled = false; } }
function pick(el, { multi = false, onChange } = {}) {
  el.addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (!b) return;
    if (multi) b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); else $$("button[data-v]", el).forEach((x) => x.setAttribute("aria-pressed", x === b));
    onChange && onChange(picked(el)); });
}
const picked = (el) => $$('button[data-v][aria-pressed="true"]', el).map((b) => b.dataset.v);
const chips = (vals, sel = []) => vals.map(([v, l]) => `<button type="button" class="chip" data-v="${esc(v)}" aria-pressed="${sel.includes(v)}">${esc(l)}</button>`).join("");
function beep(n = 2) { try { const c = new (window.AudioContext || window.webkitAudioContext)();
  for (let i = 0; i < n; i++) { const o = c.createOscillator(), g = c.createGain(); o.frequency.value = 880; o.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(0.15, c.currentTime + i * 0.35); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + i * 0.35 + 0.3); o.start(c.currentTime + i * 0.35); o.stop(c.currentTime + i * 0.35 + 0.3); } } catch {} }
async function site() {
  if (G.site) return G.site;
  const r = await q(sb.from("settings").select("value").eq("key", "gaming").maybeSingle()).catch(() => null);
  return (G.site = (r?.value?.site_url || location.origin).replace(/\/$/, ""));
}
const styles = `<style id="gc-css">
.gc-board{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.gc-st{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:9px;position:relative;overflow:hidden;min-height:210px}
.gc-st::before{content:"";position:absolute;inset:0 0 auto;height:4px;background:var(--line)}
.gc-st.running::before{background:var(--good)}.gc-st.paused::before{background:var(--warn)}.gc-st.billing::before{background:var(--info)}
.gc-st.warn{border-color:var(--bad);box-shadow:0 0 0 3px var(--bad-soft)}.gc-st.warn::before{background:var(--bad)}
.gc-hd{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.gc-nm{font:800 17px var(--display)}
.gc-timer{font:800 34px/1 var(--display);font-variant-numeric:tabular-nums;letter-spacing:.5px}
.gc-bar{height:6px;border-radius:99px;background:var(--soft);overflow:hidden}.gc-bar i{display:block;height:100%;background:var(--good);transition:width .5s}
.gc-amt{font:800 19px var(--display);color:var(--good)}
.gc-acts{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:auto}.gc-acts .btn{justify-content:center;padding-left:4px;padding-right:4px}
.gc-free{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--ink-3)}
.gc-lp{background:var(--accent-soft);border:1px dashed var(--accent);border-radius:10px;padding:8px 10px;font-size:13px}
.gc-choice{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.gc-choice button{padding:24px 10px;border-radius:14px;border:2px solid var(--line);background:var(--card);color:var(--ink);font:800 18px var(--display);cursor:pointer}
.gc-choice button:hover{border-color:var(--accent)}.gc-choice small{display:block;font:500 13px var(--body);color:var(--ink-3);margin-top:6px}
.gc-alarm{animation:gcpulse 1.2s infinite}@keyframes gcpulse{50%{box-shadow:0 0 0 10px var(--bad-soft)}}
.gc-big{font:800 40px/1 var(--display);color:var(--bad);text-align:center;margin:8px 0}
.gc-tot td{border:0!important;padding:4px 8px}.gc-tot tr.g td{font:800 20px var(--display);border-top:1px solid var(--line)!important}
.gc-prow{display:flex;gap:6px;align-items:center;margin-bottom:6px}.gc-prow select{max-width:110px}
.gc-prods{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;max-height:260px;overflow:auto;margin-top:10px}
.gc-prods button{text-align:left;display:flex;flex-direction:column;gap:2px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);cursor:pointer}
.gc-prods button:disabled{opacity:.45}
.gc-bars{display:flex;align-items:flex-end;gap:3px;height:120px}.gc-bars i{flex:1;background:var(--accent);border-radius:4px 4px 0 0;min-height:2px}
</style>`;

// =====================================================================================
//  Live board
// =====================================================================================
async function loadBoard() { G.board = await rpc("gc_board", { p_business: BID() }); G.at = Date.now(); }
const liveOf = (s) => { const d = s.status === "running" ? Date.now() - G.at : 0, active = s.calc.active_ms + d;
  return { active, amount: s.calc.amount + (s.status === "running" ? (s.calc.rate_now * d) / 3600000 : 0), remaining: s.booked_minutes ? s.booked_minutes * 60000 - active : null }; };
const remindAt = () => (G.board?.settings?.reminder_minutes || 15) * 60000;
function drawBoard() {
  const el = $("#gb-view"); if (!el || !G.board) return;
  const b = G.board, t = b.today, w = ctx().canWrite;
  const by = Object.fromEntries(b.sessions.map((s) => [s.station_id, s]));
  el.innerHTML = `<div class="grid g4">${A.kpi("Today's sales", inr(t.sales), `${t.bills} bills`)}${A.kpi("Collected today", inr(t.collected), "cash + UPI + card")}
      ${A.kpi("Playing now", `${b.sessions.length} / ${b.stations.length}`, "stations in use")}${A.kpi("Pending today", inr(t.due), "pay later")}</div>
    ${b.bookings.length ? `<div class="card" style="margin-top:14px"><div class="row" style="justify-content:space-between"><b>📅 Next 24 hours</b><a href="#gbookings" class="small">All bookings</a></div>
      <div class="chips" style="margin-top:8px">${b.bookings.slice(0, 8).map((k) => `<span class="pill ${k.status === "pending" ? "warn" : "info"}">${tm(k.start_at)} · ${esc(k.customer_name)} · ${esc(k.station_name || k.station_type || "Any")} · ${k.minutes}m${k.status === "pending" ? " · approve" : ""}</span>`).join("")}</div></div>` : ""}
    ${b.low_stock.length ? `<div class="card" style="margin-top:10px;border-color:var(--warn)">⚠️ <b>Low stock:</b> ${b.low_stock.map((p) => `${esc(p.name)} (${p.stock})`).join(", ")}</div>` : ""}
    <div class="row" style="justify-content:space-between;margin:18px 0 10px"><h2 style="margin:0">Stations</h2>
      <div class="row">${w ? `<button class="btn" data-g="sale">🧾 Counter sale</button><button class="btn" data-g="book">📅 New booking</button>` : ""}${owner() ? `<a class="btn" href="#gsetup">＋ Station</a>` : ""}</div></div>
    ${b.stations.length ? `<div class="gc-board">${b.stations.map((st) => card(st, by[st.id], w)).join("")}</div>`
      : `<div class="card empty">No stations yet. ${owner() ? `<a href="#gsetup">Add your PS5, PC, VR and pool stations →</a>` : "Ask the owner to add stations."}</div>`}`;
  tick();
}
function card(st, s, w) {
  if (!s) return `<div class="gc-st"><div class="gc-hd"><div><div class="gc-nm">${esc(st.name)}</div><div class="muted small">${esc(st.type)} · ${inr(st.rate)}/hr</div></div><span class="pill">Free</span></div>
    <div class="gc-free"><div style="font-size:34px">🎮</div>${w ? `<button class="btn primary" data-g="start" data-st="${st.id}">▶ Start session</button>` : ""}</div></div>`;
  const c = s.calc, games = c.segments.filter((x) => !x.open).length;
  const lp = s.is_lp ? `<div class="gc-lp"><div class="row" style="justify-content:space-between"><b>🏆 LP: ${s.lp_players.map(esc).join(" vs ")}</b><span>${games} game${games === 1 ? "" : "s"}</span></div>
    <div class="muted">Since last split: <b data-gl="${s.id}">—</b></div>
    <div>${Object.entries(c.per_player).map(([p, a]) => `${esc(p)}: <b>${inr(a)}</b>`).join(" · ")}</div></div>` : "";
  const items = c.items.length ? `<div class="muted small">🍿 ${c.items.map((i) => `${+i.qty}× ${esc(i.name)}`).join(", ")} · ${inr(c.items_total)}</div>` : "";
  const acts = !w ? "" : s.status === "billing"
    ? `<button class="btn sm" data-g="resume" data-s="${s.id}">↺ Resume</button><button class="btn sm" data-g="more" data-s="${s.id}">⋯ More</button><button class="btn sm primary" data-g="bill" data-s="${s.id}">🧾 Bill</button>`
    : `${s.status === "paused" ? `<button class="btn sm primary" data-g="resume" data-s="${s.id}">▶ Resume</button>` : `<button class="btn sm" data-g="pause" data-s="${s.id}">⏸ Pause</button>`}
       <button class="btn sm" data-g="extend" data-s="${s.id}">＋ Time</button><button class="btn sm" data-g="snack" data-s="${s.id}">🍿 Snack</button>
       ${s.is_lp ? `<button class="btn sm primary" data-g="split" data-s="${s.id}">✂ LP split</button>` : `<button class="btn sm" data-g="edit" data-s="${s.id}">✎ Edit</button>`}
       <button class="btn sm" data-g="more" data-s="${s.id}">⋯ More</button><button class="btn sm primary" data-g="stop" data-s="${s.id}" style="background:var(--good);border-color:var(--good)">■ Stop & bill</button>`;
  return `<div class="gc-st ${s.status}" data-gc="${s.id}">
    <div class="gc-hd"><div><div class="gc-nm">${esc(st.name)}</div><div class="muted small">${esc(st.type)} · ${s.players} player${s.players > 1 ? "s" : ""}</div></div>
      <div class="row" style="gap:4px">${s.is_lp ? '<span class="pill acc">LP</span>' : ""}<span class="pill ${s.status === "running" ? "good" : s.status === "paused" ? "warn" : "info"}">${s.status === "billing" ? "stopped" : s.status}</span></div></div>
    <div class="muted small">${esc(s.customer_name || "Walk-in")}${s.customer_phone ? " · " + esc(prettyPhone(s.customer_phone)) : ""} · from ${tm(s.start_at)}</div>
    <div class="gc-timer" data-gt="${s.id}">0:00</div>
    ${s.booked_minutes ? `<div class="gc-bar"><i data-gb="${s.id}"></i></div><div class="small" data-gr="${s.id}"></div>` : `<div class="muted small">Open time (no fixed duration)</div>`}
    <div class="row" style="justify-content:space-between"><span class="small">${inr(c.rate_now)}/hr ${c.rule_now ? `<span class="pill warn">${esc(c.rule_now)}</span>` : ""}</span><span class="gc-amt" data-ga="${s.id}">${inr(c.amount)}</span></div>
    ${lp}${items}<div class="gc-acts">${acts}</div></div>`;
}
function tick() {
  if (!A.isRoute("gboard") || !G.board) return;
  for (const s of G.board.sessions) {
    const L = liveOf(s), t = $(`[data-gt="${s.id}"]`); if (!t) continue;
    t.textContent = dur(L.active);
    const a = $(`[data-ga="${s.id}"]`); if (a) a.textContent = "≈" + inr(L.amount);
    if (s.booked_minutes) {
      const warn = s.status === "running" && L.remaining <= remindAt();
      const bar = $(`[data-gb="${s.id}"]`); if (bar) { bar.style.width = Math.min(100, (L.active / (s.booked_minutes * 60000)) * 100) + "%"; bar.style.background = warn ? "var(--bad)" : "var(--good)"; }
      const r = $(`[data-gr="${s.id}"]`); if (r) r.innerHTML = L.remaining > 0 ? `<span class="${warn ? "" : "muted"}" style="${warn ? "color:var(--bad);font-weight:700" : ""}">⏳ ${dur(L.remaining)} left of ${mins(s.booked_minutes)}</span>`
        : `<span style="color:var(--bad);font-weight:700">⏰ Over by ${dur(-L.remaining)}</span>`;
      $(`[data-gc="${s.id}"]`)?.classList.toggle("warn", warn);
      const key = `${s.id}:${s.booked_minutes}`;
      if (warn && !G.dismissed[key] && !G.reminderOpen && !modalOpen() && ctx().canWrite) reminder(s, key);
    }
    if (s.is_lp) { const el = $(`[data-gl="${s.id}"]`); if (el) { const done = s.calc.segments.filter((x) => !x.open);
      el.textContent = `${dur(L.active - done.reduce((t2, x) => t2 + x.minutes * 60000, 0))} · ≈${inr(L.amount - done.reduce((t2, x) => t2 + x.amount, 0))}`; } }
  }
}
function startLive() {
  stopLive();
  G.ticker = setInterval(() => (A.isRoute("gboard") ? tick() : stopLive()), 1000);
  G.poll = setInterval(async () => { if (!A.isRoute("gboard")) return stopLive(); if (modalOpen()) return; try { await loadBoard(); drawBoard(); } catch {} }, 20000);
  try { // instant refresh when another staff phone changes a session (Supabase Realtime)
    if (sb.channel) G.chan = sb.channel("gc-" + BID()).on("postgres_changes", { event: "*", schema: "public", table: "gc_sessions", filter: `business_id=eq.${BID()}` },
      async () => { if (!A.isRoute("gboard") || modalOpen()) return; try { await loadBoard(); drawBoard(); } catch {} }).subscribe();
  } catch {}
}
function stopLive() { clearInterval(G.ticker); clearInterval(G.poll); G.ticker = G.poll = null; try { G.chan && sb.removeChannel(G.chan); } catch {} G.chan = null; }
const findS = (id) => G.board?.sessions.find((s) => s.id === id);
async function refresh() { await loadBoard(); drawBoard(); }

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-g]"); if (!b || !$("#main")?.contains(b)) return;
  const a = b.dataset.g, s = b.dataset.s ? findS(b.dataset.s) : null;
  if (a === "start") return startFlow(G.board.stations.find((x) => x.id === b.dataset.st));
  if (a === "pause" || a === "resume") return guard(b, async () => { await rpc("gc_action", { p_session: s.id, p_action: a, p: {} }); await refresh(); });
  if (a === "extend") return extendModal(s);
  if (a === "snack") return snackModal(s.id);
  if (a === "split") return splitModal(s.id);
  if (a === "edit") return editModal(s);
  if (a === "more") return moreModal(s);
  if (a === "stop" || a === "bill") return checkout(s.id, b);
  if (a === "sale") return counterSale();
  if (a === "book") return bookingModal();
});

// ---------- start: "Is this match an LP?" popup first ----------
function startFlow(st, booking) {
  const m = openModal(`<div class="modal-head"><h2>Start ${esc(st.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <p class="muted" style="margin:0">${esc(st.type)} · ${inr(st.rate)}/hr</p><h3 style="margin-top:16px">Is this match an LP?</h3>
    <div class="gc-choice"><button data-lp="1">🏆 Yes, LP<small>Loser pays: split the time game by game and note winners</small></button><button data-lp="0">🎮 No<small>Normal timed session</small></button></div>`);
  $$("[data-lp]", m).forEach((x) => (x.onclick = () => startForm(st, x.dataset.lp === "1", booking)));
}
function durPick(def) {
  return `<div class="field" style="grid-column:1/-1"><label>Booked time (staff get a popup ${G.board?.settings?.reminder_minutes || 15} min before it ends)</label>
    <div class="chips" id="g-dur">${chips([["0", "Open"], ["30", "30 min"], ["60", "1 hr"], ["90", "1.5 hr"], ["120", "2 hr"], ["180", "3 hr"]], [String(def)])}<input id="g-durc" type="number" min="1" placeholder="Other (min)" style="width:120px"></div></div>`;
}
const readDur = (m) => +($("#g-durc", m).value || picked($("#g-dur", m))[0] || 0);
function custHint(m, id, onFound) {
  const box = $("#g-cinfo", m); if (!box) return;
  m.addEventListener("input", async (e) => {
    if (!e.target.closest(`#${id}`) && !e.target.closest(`[data-phone-for="${id}"]`) && e.target.id !== id) return;
    const ph = readPhone(id, m); if (!ph || ph.length < 11) { box.innerHTML = ""; return; }
    const c = await q(sb.from("customers").select("id,name,visits,stamps,spend").eq("business_id", BID()).eq("phone", ph).maybeSingle()).catch(() => null);
    box.innerHTML = c ? `<span class="pill good">Regular: ${esc(c.name)} · ${c.visits} visits</span>` : `<span class="pill">New customer</span>`;
    if (c && onFound) onFound(c);
  });
}
function startForm(st, lp, booking) {
  const m = openModal(`<div class="modal-head"><h2>${lp ? "🏆 LP match" : "🎮 New session"} · ${esc(st.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <form id="g-sf"><div class="fields">
    ${lp ? `<div class="field" style="grid-column:1/-1"><label>Player names <b style="color:var(--bad)">· required for LP</b></label><div class="grid" id="g-lpp" style="grid-template-columns:1fr 1fr;gap:8px">
        <input class="g-lpn" placeholder="Player 1" required><input class="g-lpn" placeholder="Player 2" required></div>
        <button type="button" class="btn sm" id="g-addp" style="margin-top:8px;align-self:flex-start">＋ Add player</button></div>`
      : `<div class="field"><label>Customer name</label><input id="g-name" value="${esc(booking?.customer_name || "")}"></div>
         <div class="field"><label>Players</label><input id="g-pl" type="number" min="1" max="16" value="${booking?.players || 1}"></div>`}
    <div class="field"><label>WhatsApp number (bill & reminders)</label>${phoneInput("g-ph", { value: booking?.customer_phone || "" })}</div>
    ${lp ? `<div class="field"><label>Bill to (optional)</label><input id="g-name" placeholder="Player 1 vs Player 2"></div>` : "<div></div>"}
    <div id="g-cinfo" class="row" style="grid-column:1/-1"></div>
    ${durPick(booking?.minutes || 60)}
    <div class="field" style="grid-column:1/-1"><label>Notes</label><input id="g-notes"></div></div>
    <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">▶ Start timer</button></div></form>`, { wide: true });
  pick($("#g-dur", m), { onChange: () => ($("#g-durc", m).value = "") });
  custHint(m, "g-ph", (c) => { const n = $("#g-name", m); if (n && !n.value && !lp) n.value = c.name; });
  if (lp) $("#g-addp", m).onclick = () => { const i = document.createElement("input"); i.className = "g-lpn"; i.placeholder = `Player ${$$(".g-lpn", m).length + 1}`; $("#g-lpp", m).appendChild(i); i.focus(); };
  $("#g-sf", m).onsubmit = (e) => { e.preventDefault(); guard($("button.primary", m), async () => {
    const p = { station_id: st.id, customer_name: $("#g-name", m)?.value.trim() || "", customer_phone: readPhone("g-ph", m) || "", players: +($("#g-pl", m)?.value || 1),
      booked_minutes: readDur(m), notes: $("#g-notes", m).value, booking_id: booking?.id || null };
    if (lp) { p.is_lp = true; p.lp_players = $$(".g-lpn", m).map((i) => i.value.trim()).filter(Boolean); if (p.lp_players.length < 2) throw new Error("Enter at least 2 player names for an LP match"); }
    await rpc("gc_start", { p_business: BID(), p }); closeModal(); toast(`${st.name} started`);
    if (A.isRoute("gboard")) await refresh(); else location.hash = "#gboard";
  }); };
}

// ---------- LP split ----------
async function splitModal(sid) {
  const s = await rpc("gc_session", { p_session: sid }).catch(err); if (!s) return;
  const c = s.calc, pl = s.lp_players, done = c.segments.filter((x) => !x.open), pp = pl.map((p) => [p, p]);
  const m = openModal(`<div class="modal-head"><h2>✂ LP split · ${esc(c.station.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <div class="gc-lp" style="font-size:15px">Since the last split: <b>${c.tail ? mins(c.tail.minutes) : "0m"}</b> · about <b>${inr(c.tail?.amount || 0)}</b>
      <div class="muted small">This time goes on the player(s) you pick below. The timer keeps running.</div></div>
    <h3 style="margin-top:14px">Who won?</h3><div class="chips" id="g-win">${chips([...pp, ["Draw", "🤝 Draw"]])}</div>
    <h3 style="margin-top:14px">Put this time on</h3><div class="chips" id="g-pay">${chips(pp)}</div>
    <p class="muted small">Picking a winner selects the other player(s). Pick more than one to share it equally.</p>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="g-go">Save split</button></div>
    ${done.length ? `<h3 style="margin-top:16px">Games so far</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>Time</th><th>Winner</th><th>Paid by</th><th class="num">Amount</th></tr></thead><tbody>
      ${done.map((g, i) => `<tr><td>${i + 1}</td><td>${tm(g.from_at)}–${tm(g.to_at)} (${mins(g.minutes)})</td><td>${esc(g.winner || "—")}</td><td>${esc(g.payers.join(" + "))}</td><td class="num">${inr(g.amount)}</td></tr>`).join("")}</tbody></table></div>
      <div class="row" style="justify-content:space-between;margin-top:10px"><div class="chips">${Object.entries(c.per_player).map(([p, a]) => `<span class="pill acc">${esc(p)}: ${inr(a)}</span>`).join("")}</div><button class="btn sm" id="g-undo">↶ Undo last split</button></div>` : ""}`, { wide: true });
  const win = $("#g-win", m), pay = $("#g-pay", m);
  pick(win, { onChange: (w) => $$("button", pay).forEach((x) => x.setAttribute("aria-pressed", !!w[0] && w[0] !== "Draw" && x.dataset.v !== w[0])) });
  pick(pay, { multi: true });
  $("#g-go", m).onclick = () => guard($("#g-go", m), async () => {
    const payers = picked(pay); if (!payers.length) throw new Error("Pick who pays for this time");
    await rpc("gc_lp_split", { p_session: sid, p_winner: picked(win)[0] || "", p_payers: payers }); closeModal(); toast("Split saved"); await refresh(); });
  const u = $("#g-undo", m); if (u) u.onclick = () => guard(u, async () => { await rpc("gc_lp_undo", { p_session: sid }); closeModal(); toast("Last split removed"); await refresh(); });
}

// ---------- extend, edit, more ----------
function extendModal(s) {
  const m = openModal(`<div class="modal-head"><h2>＋ Add time · ${esc(s.calc.station.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <p class="muted">Booked now: ${s.booked_minutes ? mins(s.booked_minutes) : "open time"}</p><div class="chips" id="g-ex">${chips([["15", "+15m"], ["30", "+30m"], ["60", "+1 hr"], ["90", "+1.5 hr"], ["120", "+2 hr"]])}</div>
    <div class="field" style="margin-top:10px"><label>Other (minutes)</label><input id="g-exc" type="number" min="1"></div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="g-go">Add time</button></div>`);
  pick($("#g-ex", m));
  $("#g-go", m).onclick = () => guard($("#g-go", m), async () => { const v = +($("#g-exc", m).value || picked($("#g-ex", m))[0] || 0); if (!v) throw new Error("Choose how much time");
    await rpc("gc_action", { p_session: s.id, p_action: "extend", p: { minutes: v } }); closeModal(); toast(`Added ${mins(v)}`); await refresh(); });
}
function editModal(s) {
  formModal({ title: `Edit · ${s.calc.station.name}`, submitLabel: "Save",
    fields: [{ key: "customer_name", label: "Customer name" }, { key: "customer_phone", label: "WhatsApp number", type: "phone" },
      { key: "players", label: "Players", type: "number", min: 1 }, { key: "booked_minutes", label: "Booked minutes (0 = open)", type: "number", min: 0 }, { key: "notes", label: "Notes", full: true }],
    values: { customer_name: s.customer_name, customer_phone: s.customer_phone || "", players: s.players, booked_minutes: s.booked_minutes, notes: s.notes },
    onSave: async (v) => { await rpc("gc_action", { p_session: s.id, p_action: "update", p: v }); toast("Saved"); refresh(); } });
}
function moreModal(s) {
  const free = G.board.stations.filter((st) => !G.board.sessions.some((x) => x.station_id === st.id));
  const m = openModal(`<div class="modal-head"><h2>${esc(s.calc.station.name)}</h2><button class="btn ghost" data-close>Close</button></div><div class="grid" style="gap:8px">
    <button class="btn" data-m="edit">✎ Customer, players, booked time</button>${s.is_lp ? `<button class="btn" data-m="split">✂ LP games so far</button>` : ""}
    <button class="btn" data-m="snack">🍿 Snacks on this session</button>${s.customer_phone ? `<button class="btn wa" data-m="wa">💬 Time reminder on WhatsApp</button>` : ""}
    <div class="row"><select id="g-to" style="flex:1"><option value="">Move to another station…</option>${free.map((st) => `<option value="${st.id}">${esc(st.name)} (${esc(st.type)})</option>`).join("")}</select><button class="btn" data-m="move">Move</button></div>
    <button class="btn danger" data-m="cancel">✕ Cancel session (no bill)</button></div>`);
  m.onclick = async (e) => { const x = e.target.closest("[data-m]")?.dataset.m; if (!x) return;
    if (x === "edit") return editModal(s); if (x === "split") return splitModal(s.id); if (x === "snack") return snackModal(s.id);
    if (x === "wa") return remindWA(s);
    if (x === "move") return guard(null, async () => { const v = $("#g-to", m).value; if (!v) throw new Error("Pick a station"); await rpc("gc_action", { p_session: s.id, p_action: "transfer", p: { station_id: v } }); closeModal(); toast("Moved"); await refresh(); });
    if (x === "cancel") formModal({ title: "Cancel session", submitLabel: "Cancel session", fields: [{ key: "reason", label: "Reason", required: true, full: true }],
      onSave: async (v) => { await rpc("gc_action", { p_session: s.id, p_action: "cancel", p: v }); toast("Session cancelled"); refresh(); } });
  };
}

// ---------- WhatsApp: add-on sends from the Branditude number; otherwise a free link from the club's own phone ----------
async function viaAddon(kind, ref) {
  if (!hasWA() || !sb.functions) return { skipped: "addon" };
  const { data, error } = await sb.functions.invoke("gc-notify", { body: { business_id: BID(), kind, ref } });
  if (error) { let j = null; try { j = await error.context?.json?.(); } catch {} return { error: j?.error || error.message }; }
  return data || {};
}
function waLink(phone, text) { window.open(`https://wa.me/${String(phone || "").replace(/\D/g, "")}?text=${encodeURIComponent(text)}`, "_blank"); }
async function sendWA(kind, ref, phone, text) {
  const r = await viaAddon(kind, ref);
  if (r.ok) return toast("✅ Sent on WhatsApp (1 credit)");
  if (r.skipped && r.skipped !== "addon") toast(`Couldn't send automatically: ${r.skipped}. Opening WhatsApp on this phone…`);
  else if (r.error) toast(`WhatsApp: ${r.error}. Opening WhatsApp on this phone…`, "error");
  waLink(phone, text);
}
async function billText(bl) { const s = await site(); return `Hi ${(bl.customer_name || "there").split(" ")[0]}, thank you for playing at ${biz().name}. Your bill ${bl.number} for ${inr(bl.total)}: ${s}/g.html?t=${bl.token}${bl.due > 0 ? ` (pending ${inr(bl.due)})` : ""} How was your time? Rate us: ${s}/f.html?b=${biz().slug}`; }
async function dueText(bl) { const s = await site(); return `Hi ${(bl.customer_name || "there").split(" ")[0]}, a reminder from ${biz().name}: ${inr(bl.due)} is still pending on bill ${bl.number}. See the bill here: ${s}/g.html?t=${bl.token} Thank you!`; }
function remindWA(s) { const L = liveOf(s);
  return sendWA("reminder", s.id, s.customer_phone, `Hi ${(s.customer_name || "there").split(" ")[0]}, your time on ${s.calc.station.name} at ${biz().name} ends in ${Math.max(0, Math.round(L.remaining / 60000))} minutes. Want to keep playing? Just tell us at the counter.`); }

// ---------- 15 minutes left popup ----------
function reminder(s, key) {
  G.reminderOpen = true; beep(3);
  const L = liveOf(s);
  const m = openModal(`<div class="modal-head"><h2>⏰ ${Math.max(0, Math.round(L.remaining / 60000))} minutes left on ${esc(s.calc.station.name)}</h2></div>
    <p class="muted" style="text-align:center">${esc(s.customer_name || "Walk-in")}${s.customer_phone ? " · " + esc(prettyPhone(s.customer_phone)) : ""} · booked ${mins(s.booked_minutes)} from ${tm(s.start_at)}</p>
    <div class="gc-big" id="g-rem">${dur(L.remaining)}</div><p style="text-align:center">Remind the customer and ask if they want more time.</p>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:8px">${s.customer_phone ? `<button class="btn wa" id="g-wa">💬 WhatsApp reminder</button>` : `<button class="btn" disabled>No number for WhatsApp</button>`}
      <button class="btn primary" id="g-more">＋ Add time</button><button class="btn" id="g-30">+30 min</button><button class="btn" id="g-60">+1 hour</button></div>
    <div class="modal-foot"><button class="btn" id="g-ok">✓ Reminded</button></div>`);
  m.classList.add("gc-alarm");
  const iv = setInterval(() => { const x = liveOf(findS(s.id) || s), el = $("#g-rem"); if (!el) { clearInterval(iv); G.reminderOpen = false; G.dismissed[key] = 1; save(); return; } el.textContent = x.remaining > 0 ? dur(x.remaining) : "Time over"; }, 1000);
  const save = () => { try { localStorage.setItem("gc_dismissed", JSON.stringify(G.dismissed)); } catch {} };
  const done = () => { G.dismissed[key] = 1; save(); clearInterval(iv); G.reminderOpen = false; closeModal(); };
  $("#g-ok", m).onclick = done;
  const w = $("#g-wa", m); if (w) w.onclick = () => guard(w, () => remindWA(s));
  $("#g-more", m).onclick = () => { done(); extendModal(s); };
  const add = (v) => guard(null, async () => { await rpc("gc_action", { p_session: s.id, p_action: "extend", p: { minutes: v } }); done(); toast(`Added ${mins(v)}`); await refresh(); });
  $("#g-30", m).onclick = () => add(30); $("#g-60", m).onclick = () => add(60);
}

// ---------- snacks ----------
async function products(force) { if (!G.products || force) G.products = await q(sb.from("gc_products").select("*").eq("business_id", BID()).eq("active", true).order("category").order("name")); return G.products; }
async function snackModal(sid) {
  const [prods, s] = await Promise.all([products(true), rpc("gc_session", { p_session: sid })]).catch((e) => (err(e), [])); if (!s) return;
  const pl = s.is_lp ? s.lp_players : [];
  const m = openModal(`<div class="modal-head"><h2>🍿 Snacks · ${esc(s.calc.station.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <div class="row"><input id="g-q" placeholder="Search…" style="flex:1"><span class="muted small">Qty</span><input id="g-qty" type="number" min="1" value="1" style="width:70px"></div>
    ${pl.length ? `<div class="field" style="margin-top:10px"><label>Charge to (LP)</label><div class="chips" id="g-who">${chips([["", "Shared"], ...pl.map((p) => [p, p])], [""])}</div></div>` : ""}
    <div class="gc-prods" id="g-pl"></div>
    <details style="margin-top:10px"><summary class="muted">Something not in the list</summary><div class="row" style="margin-top:8px"><input id="g-cn" placeholder="Item" style="flex:1"><input id="g-cp" type="number" placeholder="Price" style="width:100px"><button class="btn" id="g-ca">Add</button></div></details>
    <h3 style="margin-top:14px">On this session</h3><div id="g-cur"></div>`, { wide: true });
  if (pl.length) pick($("#g-who", m));
  const who = () => (pl.length ? picked($("#g-who", m))[0] || null : null);
  const list = () => { const t = $("#g-q", m).value.toLowerCase();
    $("#g-pl", m).innerHTML = prods.filter((p) => p.name.toLowerCase().includes(t)).map((p) => `<button data-p="${p.id}" ${p.track_stock && p.stock <= 0 ? "disabled" : ""}><b>${esc(p.name)}</b><span class="muted small">${inr(p.price)}${p.track_stock ? ` · ${p.stock} left` : ""}</span></button>`).join("")
      || `<p class="muted">No items yet.${owner() ? ` Add them in <a href="#gstock">Snacks & stock</a>.` : ""}</p>`; };
  const cur = (v) => { $("#g-cur", m).innerHTML = v.calc.items.length ? `<div class="table-wrap"><table><tbody>${v.calc.items.map((i) => `<tr><td>${+i.qty}× ${esc(i.name)} ${i.assigned_to ? `<span class="pill acc">${esc(i.assigned_to)}</span>` : ""}</td><td class="num">${inr(i.qty * i.price)}</td><td style="text-align:right"><button class="btn sm" data-del="${i.id}">✕</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`; };
  list(); cur(s); $("#g-q", m).oninput = list;
  const add = (p) => guard(null, async () => { const v = await rpc("gc_item_add", { p_session: sid, p: { ...p, qty: +($("#g-qty", m).value || 1), assigned_to: who() } }); toast("Added"); cur(v);
    if (p.product_id) { const x = prods.find((y) => y.id === p.product_id); if (x?.track_stock) x.stock -= +($("#g-qty", m).value || 1); list(); } loadBoard().then(() => {}).catch(() => {}); });
  $("#g-pl", m).onclick = (e) => { const b = e.target.closest("[data-p]"); if (b) add({ product_id: b.dataset.p }); };
  $("#g-ca", m).onclick = () => add({ name: $("#g-cn", m).value, price: +($("#g-cp", m).value || 0) });
  $("#g-cur", m).onclick = (e) => { const b = e.target.closest("[data-del]"); if (b) guard(b, async () => cur(await rpc("gc_item_remove", { p_item: +b.dataset.del }))); };
  m.addEventListener("click", (e) => { if (e.target.closest("[data-close]") && A.isRoute("gboard")) refresh(); });
}

// ---------- billing ----------
function totals(sub, disc) {
  const cf = G.board?.settings || { tax_percent: 18, tax_inclusive: false }, t = +cf.tax_percent || 0, taxable = Math.max(0, sub - disc);
  let tax, total; if (cf.tax_inclusive) { total = taxable; tax = total - total / (1 + t / 100); } else { tax = (taxable * t) / 100; total = taxable + tax; }
  const r = Math.round(total); return { tax, round: r - total, total: r, t, incl: cf.tax_inclusive };
}
function payBox(m, { players = [], total, shares }) {
  const box = $("#g-pays", m);
  const row = (mode = "cash", amt = "", by = "") => `<div class="gc-prow"><select class="g-pm">${["cash", "upi", "card"].map((x) => `<option value="${x}" ${x === mode ? "selected" : ""}>${x.toUpperCase()}</option>`).join("")}</select>
    <input class="g-pa" type="number" step="0.01" min="0" placeholder="Amount" value="${amt}" style="flex:1">${players.length ? `<select class="g-pb"><option value="">Paid by…</option>${players.map((p) => `<option ${p === by ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>` : ""}<button type="button" class="btn sm" data-rm>✕</button></div>`;
  box.innerHTML = `<label class="muted small" style="font-weight:600">Payment</label><div class="chips" id="g-pq">${chips([["cash", "Cash"], ["upi", "UPI"], ["card", "Card"], ["split", "Split"], ...(players.length ? [["lp", "Each player pays"]] : []), ["later", "Pay later"]], ["cash"])}</div>
    <div id="g-prows" style="margin-top:8px"></div><button type="button" class="btn sm" id="g-addpay">＋ Payment</button><div id="g-due" style="margin-top:8px;font-weight:700"></div>`;
  const set = (rows) => { $("#g-prows", m).innerHTML = rows.map((r) => row(...r)).join(""); upd(); };
  const upd = () => { const paid = $$(".g-pa", m).reduce((t, i) => t + +(i.value || 0), 0), T = total();
    $("#g-due", m).innerHTML = paid >= T ? (paid > T ? `<span style="color:var(--good)">Give back ${inr2(paid - T)} change</span>` : `<span style="color:var(--good)">✓ Fully paid</span>`) : `<span style="color:var(--warn)">Pending (pay later): ${inr2(T - paid)}</span>`; };
  const mode = () => picked($("#g-pq", m))[0];
  m.syncPay = () => { const k = mode(); if (["cash", "upi", "card"].includes(k)) set([[k, total()]]); else if (k === "lp") set(shares().map((x) => ["cash", x.amount, x.player])); else upd(); };
  pick($("#g-pq", m), { onChange: (v) => { const k = v[0]; if (k === "split") set([["cash", ""], ["upi", ""]]); else if (k === "later") set([]); else m.syncPay(); } });
  box.addEventListener("click", (e) => { if (e.target.closest("[data-rm]")) { e.target.closest(".gc-prow").remove(); upd(); } if (e.target.id === "g-addpay") { $("#g-prows", m).insertAdjacentHTML("beforeend", row()); upd(); } });
  box.addEventListener("input", upd);
  m.syncPay();
  return () => $$(".gc-prow", m).map((r) => ({ mode: $(".g-pm", r).value, amount: +($(".g-pa", r).value || 0), by: $(".g-pb", r)?.value || null })).filter((p) => p.amount > 0);
}
async function checkout(sid, btn) {
  const s = await guard(btn, async () => { let x = await rpc("gc_session", { p_session: sid }); if (["running", "paused"].includes(x.status)) x = await rpc("gc_action", { p_session: sid, p_action: "stop", p: {} }); return x; });
  if (!s) return; refresh().catch(() => {});
  const c = s.calc, pl = s.lp_players || [], needTail = s.is_lp && c.tail && c.tail.minutes >= 1;
  const m = openModal(`<div class="modal-head"><h2>🧾 Bill · ${esc(c.station.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <p class="muted" style="margin:0">${esc(s.customer_name || "Walk-in")} · ${tm(s.start_at)}–${tm(s.end_at)} · played ${mins(c.active_minutes)} · charged <b>${c.charged_minutes} min</b>${s.booked_minutes && c.charged_minutes > Math.ceil(c.active_minutes) ? ` (booked ${mins(s.booked_minutes)})` : ""}</p>
    ${needTail ? `<div class="gc-lp" style="margin-top:12px;font-size:14px"><b>🏆 Last LP game (${mins(c.tail.minutes)} · ${inr(c.tail.amount)}): who won and who pays?</b>
      <div class="chips" id="g-tw" style="margin-top:8px">${chips([...pl.map((p) => [p, p]), ["Draw", "Draw"]])}</div><div class="muted small" style="margin-top:8px">Put this time on:</div><div class="chips" id="g-tp">${chips(pl.map((p) => [p, p]))}</div></div>` : ""}
    <div class="table-wrap" style="margin-top:12px"><table><tbody>
      <tr><td>🎮 ${esc(c.station.name)} · ${c.charged_minutes} min ${c.by_rule.length > 1 || c.by_rule[0]?.rule !== "Standard" ? c.by_rule.map((r) => `<span class="pill ${r.rule === "Standard" ? "" : "warn"}">${esc(r.rule)} ${mins(r.minutes)}</span>`).join(" ") : ""}</td><td class="num"><b>${inr2(c.amount)}</b></td></tr>
      ${c.items.map((i) => `<tr><td>🍿 ${+i.qty}× ${esc(i.name)} ${i.assigned_to ? `<span class="pill acc">${esc(i.assigned_to)}</span>` : ""}</td><td class="num">${inr2(i.qty * i.price)}</td></tr>`).join("")}</tbody></table></div>
    ${s.is_lp ? `<h3 style="margin-top:14px">Who pays what</h3><div id="g-lpb"></div>` : ""}
    <div class="fields" style="margin-top:10px"><div class="field"><label>Customer name</label><input id="g-cname" value="${esc(s.customer_name || "")}"></div>
      <div class="field"><label>WhatsApp number</label>${phoneInput("g-cph", { value: s.customer_phone || "" })}</div>
      <div class="field"><label>Discount</label><div class="row" style="flex-wrap:nowrap"><input id="g-disc" type="number" min="0" value="0"><select id="g-dt" style="width:80px"><option value="amt">₹</option><option value="pct">%</option></select></div></div>
      <div class="field" id="g-loy"></div></div>
    <table class="gc-tot" style="width:100%;margin-top:8px"><tbody id="g-tots"></tbody></table>
    <div id="g-pays" style="margin-top:8px"></div>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="g-sendwa" ${G.board?.settings?.wa_bill !== false ? "checked" : ""}> Send the bill and feedback link on WhatsApp${hasWA() ? " (1 credit, from the Branditude number)" : ""}</label>
    <div class="modal-foot"><button class="btn" id="g-res">↺ Resume timer</button><button class="btn primary" id="g-go">✓ Create bill</button></div>`, { wide: true });
  const tail = { winner: null, payers: [] };
  const sub = () => +(c.amount + c.items_total).toFixed(2);
  const disc = () => { const v = +($("#g-disc", m).value || 0); return Math.min(sub(), $("#g-dt", m).value === "pct" ? (sub() * v) / 100 : v); };
  const shares = () => {
    const pp = { ...c.per_player }; if (needTail) tail.payers.forEach((p) => (pp[p] = (pp[p] || 0) + c.tail.amount / tail.payers.length));
    const common = c.items.filter((i) => !i.assigned_to).reduce((t, i) => t + i.qty * i.price, 0);
    const rows = pl.map((p) => ({ player: p, game: pp[p] || 0, items: c.items.filter((i) => i.assigned_to === p).reduce((t, i) => t + i.qty * i.price, 0) + common / pl.length }));
    const T = totals(sub(), disc()).total; let acc = 0;
    rows.forEach((r, i) => { r.amount = i === rows.length - 1 ? T - acc : sub() > 0 ? Math.round((T * (r.game + r.items)) / sub()) : 0; acc += r.amount; }); return rows;
  };
  const draw = () => { const t = totals(sub(), disc());
    $("#g-tots", m).innerHTML = `<tr><td>Subtotal</td><td class="num">${inr2(sub())}</td></tr>${disc() ? `<tr><td>Discount</td><td class="num">−${inr2(disc())}</td></tr>` : ""}${t.t ? `<tr><td>GST ${t.t}%${t.incl ? " (included)" : ""}</td><td class="num">${inr2(t.tax)}</td></tr>` : ""}${Math.abs(t.round) >= 0.01 ? `<tr><td>Round off</td><td class="num">${inr2(t.round)}</td></tr>` : ""}<tr class="g"><td>Total</td><td class="num">${inr(t.total)}</td></tr>`;
    if (s.is_lp) $("#g-lpb", m).innerHTML = `<div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Game time</th><th class="num">Snacks</th><th class="num">Pays</th></tr></thead><tbody>${shares().map((r) => `<tr><td>${esc(r.player)}</td><td class="num">${inr2(r.game)}</td><td class="num">${inr2(r.items)}</td><td class="num"><b>${inr(r.amount)}</b></td></tr>`).join("")}</tbody></table></div>${needTail && !tail.payers.length ? `<p class="small" style="color:var(--warn)">Pick who pays for the last game above.</p>` : ""}`;
    m.syncPay && m.syncPay(); };
  const getPays = payBox(m, { players: pl, total: () => totals(sub(), disc()).total, shares });
  draw(); ["#g-disc", "#g-dt"].forEach((x) => $(x, m).addEventListener("input", draw));
  if (needTail) {
    pick($("#g-tw", m), { onChange: (w) => { tail.winner = w[0]; $$("#g-tp button", m).forEach((b) => b.setAttribute("aria-pressed", !!w[0] && w[0] !== "Draw" && b.dataset.v !== w[0])); tail.payers = picked($("#g-tp", m)); draw(); } });
    pick($("#g-tp", m), { multi: true, onChange: (p) => { tail.payers = p; draw(); } });
  }
  // Loyalty card add-on: show the reward this visit earns, so staff can give it as a discount
  if (A.hasMod("loyalty") && s.customer_phone) rpc("preview_visit", { p_business: BID(), p_phone: s.customer_phone, p_gross: sub(), p_coupon: null }).then((pv) => {
    if (!pv?.loyalty_enabled) return; const el = $("#g-loy", m); if (!el) return;
    el.innerHTML = `<label>Loyalty card</label><div class="small">Visit ${pv.visit_no} of ${pv.loyalty_stamps}${pv.loyalty_reward ? ` · <b>reward: ${esc(pv.loyalty_reward.note || (pv.loyalty_reward.type === "percent" ? pv.loyalty_reward.value + "% off" : inr(pv.loyalty_reward.value) + " off"))}</b> <button type="button" class="btn sm" id="g-useloy">Give ${inr(pv.loyalty_reward.discount)} off</button>` : ""}</div>`;
    const u = $("#g-useloy", m); if (u) u.onclick = () => { $("#g-dt", m).value = "amt"; $("#g-disc", m).value = Math.round(pv.loyalty_reward.discount); draw(); };
  }).catch(() => {});
  $("#g-res", m).onclick = () => guard($("#g-res", m), async () => { await rpc("gc_action", { p_session: sid, p_action: "resume", p: {} }); closeModal(); toast("Timer resumed"); await refresh(); });
  $("#g-go", m).onclick = () => guard($("#g-go", m), async () => {
    if (needTail && !tail.payers.length) throw new Error("Pick who pays for the last LP game");
    const bl = await rpc("gc_checkout", { p_session: sid, p: { customer_name: $("#g-cname", m).value.trim(), customer_phone: readPhone("g-cph", m) || "", discount: +disc().toFixed(2), payments: getPays(),
      lp_final: needTail ? { winner: tail.winner, payers: tail.payers } : null } });
    const wa = $("#g-sendwa", m).checked; closeModal(); billDone(bl, wa); refresh().catch(() => {});
  });
}
async function billDone(bl, sendNow) {
  const s = await site(), url = `${s}/g.html?t=${bl.token}`;
  let waNote = "";
  if (sendNow && bl.customer_phone && hasWA()) { const r = await viaAddon("bill", bl.id); waNote = r.ok ? `<span class="pill good">WhatsApp sent ✓</span>` : `<span class="pill warn">Not sent: ${esc(r.skipped || r.error || "")}</span>`; }
  const m = openModal(`<div style="text-align:center"><div style="font-size:44px">✅</div><h2>Bill ${esc(bl.number)}</h2><div class="gc-big" style="color:var(--ink)">${inr(bl.total)}</div>
    <p>${bl.due > 0 ? `<span class="pill warn">Pending ${inr(bl.due)}</span>` : `<span class="pill good">Paid</span>`} ${waNote}</p></div>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:8px"><a class="btn" target="_blank" href="${url}&print=thermal">🖨️ Print (thermal)</a><a class="btn" target="_blank" href="${url}">📄 Open bill</a>
      <button class="btn wa" id="g-wa">💬 ${waNote.includes("sent ✓") ? "Send again" : "Send on WhatsApp"}</button><button class="btn" id="g-cp">🔗 Copy link</button></div>
    ${!hasWA() ? `<p class="muted small" style="margin-top:12px">Tip: with the <b>WhatsApp bills</b> add-on, bills, payment follow-ups and a daily report go out automatically from Branditude's number. <a href="#plan">See add-ons</a></p>` : ""}
    <div class="modal-foot"><button class="btn primary" data-close>Done</button></div>`);
  $("#g-cp", m).onclick = () => copy(url, "Bill link copied");
  $("#g-wa", m).onclick = () => guard($("#g-wa", m), async () => {
    let ph = bl.customer_phone; if (!ph) { toast("Add the customer's number in the bill first", "error"); return; }
    if (sendNow && !waNote.includes("sent ✓") && !hasWA()) return waLink(ph, await billText(bl));
    await sendWA("bill", bl.id, ph, await billText(bl)); });
  if (sendNow && bl.customer_phone && !hasWA()) waLink(bl.customer_phone, await billText(bl));
}

// ---------- counter sale ----------
async function counterSale() {
  const prods = await products(true).catch((e) => (err(e), null)); if (!prods) return; const cart = new Map();
  if (!G.board) await loadBoard().catch(() => {});
  const m = openModal(`<div class="modal-head"><h2>🧾 Counter sale</h2><button class="btn ghost" data-close>Close</button></div>
    <input id="g-q" placeholder="Search snacks…"><div class="gc-prods" id="g-pl"></div><h3 style="margin-top:12px">Cart</h3><div id="g-cart"></div>
    <div class="fields" style="margin-top:8px"><div class="field"><label>Customer name</label><input id="g-cname"></div><div class="field"><label>WhatsApp number</label>${phoneInput("g-cph")}</div>
    <div class="field"><label>Discount (₹)</label><input id="g-disc" type="number" min="0" value="0"></div></div>
    <table class="gc-tot" style="width:100%;margin-top:8px"><tbody id="g-tots"></tbody></table><div id="g-pays"></div>
    <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="g-go">✓ Create bill</button></div>`, { wide: true });
  const sub = () => [...cart.values()].reduce((t, x) => t + x.p.price * x.qty, 0), tot = () => totals(sub(), Math.min(sub(), +($("#g-disc", m).value || 0)));
  const list = () => { const t = $("#g-q", m).value.toLowerCase(); $("#g-pl", m).innerHTML = prods.filter((p) => p.name.toLowerCase().includes(t)).map((p) => `<button data-p="${p.id}"><b>${esc(p.name)}</b><span class="muted small">${inr(p.price)}${p.track_stock ? " · " + p.stock + " left" : ""}</span></button>`).join("") || `<p class="muted">No items yet.</p>`; };
  const draw = () => { $("#g-cart", m).innerHTML = cart.size ? `<div class="table-wrap"><table><tbody>${[...cart.values()].map((x) => `<tr><td>${esc(x.p.name)}</td><td><button class="btn sm" data-d="${x.p.id}">−</button> <b>${x.qty}</b> <button class="btn sm" data-i="${x.p.id}">＋</button></td><td class="num">${inr(x.p.price * x.qty)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Tap items to add them.</p>`;
    const t = tot(); $("#g-tots", m).innerHTML = `<tr><td>Subtotal</td><td class="num">${inr2(sub())}</td></tr>${t.t ? `<tr><td>GST ${t.t}%</td><td class="num">${inr2(t.tax)}</td></tr>` : ""}<tr class="g"><td>Total</td><td class="num">${inr(t.total)}</td></tr>`; m.syncPay && m.syncPay(); };
  list(); const getPays = payBox(m, { total: () => tot().total }); draw();
  $("#g-q", m).oninput = list; $("#g-disc", m).oninput = draw;
  m.addEventListener("click", (e) => { const p = e.target.closest("[data-p]"), i = e.target.closest("[data-i]"), d = e.target.closest("[data-d]");
    if (p) { const pr = prods.find((x) => x.id === p.dataset.p), x = cart.get(pr.id) || { p: pr, qty: 0 }; x.qty++; cart.set(pr.id, x); draw(); }
    if (i) { cart.get(i.dataset.i).qty++; draw(); } if (d) { const x = cart.get(d.dataset.d); if (--x.qty <= 0) cart.delete(x.p.id); draw(); } });
  $("#g-go", m).onclick = () => guard($("#g-go", m), async () => { if (!cart.size) throw new Error("The cart is empty");
    const bl = await rpc("gc_quick_sale", { p_business: BID(), p: { items: [...cart.values()].map((x) => ({ product_id: x.p.id, qty: x.qty })), customer_name: $("#g-cname", m).value.trim(), customer_phone: readPhone("g-cph", m) || "", discount: +($("#g-disc", m).value || 0), payments: getPays() } });
    closeModal(); G.products = null; billDone(bl, false); if (A.isRoute("gboard")) refresh(); });
}

// =====================================================================================
//  Bookings
// =====================================================================================
const BK = { pending: "warn", confirmed: "info", arrived: "good", cancelled: "bad", no_show: "bad" };
async function drawBookings() {
  const el = $("#gk-view"); if (!el) return;
  const from = $("#gk-f")?.value || todayISO(), to = $("#gk-t")?.value || new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const rows = await q(sb.from("gc_bookings").select("*, gc_stations(name)").eq("business_id", BID()).gte("start_at", from + "T00:00:00+05:30").lte("start_at", to + "T23:59:59+05:30").order("start_at"));
  const link = `${await site()}/play.html?b=${biz().slug}`;
  el.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:12px"><div class="row"><input type="date" id="gk-f" value="${from}"><span class="muted">to</span><input type="date" id="gk-t" value="${to}"></div>
      <div class="row"><button class="btn" id="gk-link">🔗 Online booking link</button>${ctx().canWrite ? `<button class="btn primary" id="gk-new">＋ New booking</button>` : ""}</div></div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Customer</th><th>Station</th><th>Time</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((k) => `<tr><td><b>${fmtDT(k.start_at)}</b></td><td>${esc(k.customer_name)}<div class="muted small">${esc(prettyPhone(k.customer_phone || ""))}${k.source === "online" ? " · 🌐 online" : ""}${k.notes ? " · " + esc(k.notes) : ""}</div></td>
      <td>${esc(k.gc_stations?.name || k.station_type || "Any")}</td><td>${mins(k.minutes)} · ${k.players}p</td><td><span class="pill ${BK[k.status]}">${k.status.replace("_", "-")}</span></td>
      <td style="text-align:right;white-space:nowrap">${ctx().canWrite && ["pending", "confirmed"].includes(k.status) ? `${k.status === "pending" ? `<button class="btn sm primary" data-k="confirmed" data-id="${k.id}">✓ Approve</button>` : ""}
        <button class="btn sm" data-ks="${k.id}">▶ Start</button><button class="btn sm" data-k="cancelled" data-id="${k.id}">Cancel</button><button class="btn sm" data-k="no_show" data-id="${k.id}">No-show</button>` : ""}
        ${k.customer_phone ? `<a class="btn sm wa" target="_blank" href="https://wa.me/${k.customer_phone}?text=${encodeURIComponent(`Hi ${k.customer_name.split(" ")[0]}, your booking at ${biz().name} on ${fmtDT(k.start_at)} is ${k.status === "pending" ? "received" : k.status}.`)}">💬</a>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card empty">No bookings in these dates. Share your online booking link so customers can ask for a slot.</div>`}`;
  $("#gk-f").onchange = drawBookings; $("#gk-t").onchange = drawBookings;
  $("#gk-link").onclick = () => copy(link, "Booking link copied");
  const nb = $("#gk-new"); if (nb) nb.onclick = () => bookingModal(drawBookings);
  el.onclick = async (e) => {
    const a = e.target.closest("[data-k]"), st = e.target.closest("[data-ks]");
    if (a) guard(a, async () => { await rpc("gc_booking_save", { p_business: BID(), p: { id: a.dataset.id, status: a.dataset.k } });
      const r = ["confirmed", "cancelled"].includes(a.dataset.k) ? await viaAddon("booking", a.dataset.id) : {}; toast(r.ok ? "Updated · customer told on WhatsApp" : "Updated"); drawBookings(); });
    if (st) { const k = rows.find((x) => x.id === st.dataset.ks); await loadBoard().catch(err); const free = G.board.stations.filter((x) => !G.board.sessions.some((y) => y.station_id === x.id));
      if (!free.length) return toast("No station is free right now", "error");
      const pre = free.find((x) => x.id === k.station_id) || free.find((x) => x.type === k.station_type) || free[0];
      const m = openModal(`<div class="modal-head"><h2>Start booking · ${esc(k.customer_name)}</h2><button class="btn ghost" data-close>Close</button></div><div class="field"><label>Station</label><select id="g-bs">${free.map((x) => `<option value="${x.id}" ${x.id === pre.id ? "selected" : ""}>${esc(x.name)} (${esc(x.type)})</option>`).join("")}</select></div><div class="modal-foot"><button class="btn primary" id="g-go">Next</button></div>`);
      $("#g-go", m).onclick = () => startFlow(free.find((x) => x.id === $("#g-bs", m).value), k); }
  };
}
async function bookingModal(after) {
  const st = await q(sb.from("gc_stations").select("id,name,type").eq("business_id", BID()).eq("active", true).order("sort")).catch(() => []);
  formModal({ title: "📅 New booking", submitLabel: "Save booking",
    fields: [{ key: "customer_name", label: "Customer name", required: true }, { key: "customer_phone", label: "WhatsApp number", type: "phone" },
      { key: "date", label: "Date", type: "date", required: true }, { key: "time", label: "Time", type: "time", required: true },
      { key: "station_id", label: "Station", type: "select", options: [["", "Any"], ...st.map((x) => [x.id, `${x.name} (${x.type})`])] },
      { key: "minutes", label: "Minutes", type: "number", min: 15 }, { key: "players", label: "Players", type: "number", min: 1 }, { key: "notes", label: "Notes" }],
    values: { date: todayISO(), minutes: 60, players: 1 },
    onSave: async (v) => { const s = st.find((x) => x.id === v.station_id);
      const k = await rpc("gc_booking_save", { p_business: BID(), p: { ...v, station_type: s?.type || null, start_at: new Date(`${v.date}T${v.time}:00+05:30`).toISOString() } });
      const r = k.customer_phone ? await viaAddon("booking", k.id) : {}; toast(r.ok ? "Booking saved · confirmation sent on WhatsApp" : "Booking saved"); after ? after() : A.isRoute("gboard") && refresh(); } });
}

// =====================================================================================
//  Bills
// =====================================================================================
async function drawBills() {
  const el = $("#gi-view"); if (!el) return; const f = G.billQ;
  f.from = $("#gi-f")?.value || f.from || new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10); f.to = $("#gi-t")?.value || f.to || todayISO(); f.status = $("#gi-s")?.value ?? f.status;
  let qy = sb.from("gc_bills").select("*").eq("business_id", BID()).gte("created_at", f.from + "T00:00:00+05:30").lte("created_at", f.to + "T23:59:59+05:30").order("created_at", { ascending: false }).limit(500);
  if (f.status === "due") qy = qy.in("status", ["partial", "unpaid"]); else if (f.status) qy = qy.eq("status", f.status);
  const rows = await q(qy), live = rows.filter((r) => r.status !== "void");
  const pend = await q(sb.from("gc_bills").select("customer_id,customer_name,customer_phone,due").eq("business_id", BID()).gte("due", 0.01).in("status", ["partial", "unpaid"])).catch(() => []);
  el.innerHTML = `<div class="grid g4">${A.kpi("Bills", live.length, "in these dates")}${A.kpi("Sales", inr(live.reduce((t, r) => t + +r.total, 0)))}${A.kpi("Pending (all time)", inr(pend.reduce((t, r) => t + +r.due, 0)), `${new Set(pend.map((p) => p.customer_id)).size} customers`)}
      ${A.kpi("WhatsApp follow-ups", hasWA() ? (G.board?.settings?.wa_followup !== false ? "Automatic" : "Off") : "Add-on", hasWA() ? "every few days until paid" : `<a href="#gsetup?wa">Turn on</a>`)}</div>
    <div class="row" style="justify-content:space-between;margin:14px 0 10px"><div class="row"><input type="date" id="gi-f" value="${f.from}"><input type="date" id="gi-t" value="${f.to}">
      <select id="gi-s"><option value="">All</option><option value="due" ${f.status === "due" ? "selected" : ""}>Pending</option><option value="paid" ${f.status === "paid" ? "selected" : ""}>Paid</option><option value="void" ${f.status === "void" ? "selected" : ""}>Cancelled</option></select></div>
      <button class="btn" id="gi-x">Download CSV</button></div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Bill</th><th>When</th><th>Customer</th><th>Station</th><th class="num">Total</th><th class="num">Pending</th><th></th></tr></thead><tbody>
    ${rows.map((b) => `<tr data-bill="${b.id}" style="cursor:pointer"><td><b>${esc(b.number)}</b>${b.lp ? ' <span class="pill acc">LP</span>' : ""}</td><td>${fmtDT(b.created_at)}</td><td>${esc(b.customer_name || "Walk-in")}<div class="muted small">${esc(prettyPhone(b.customer_phone || ""))}</div></td>
      <td>${esc(b.station_name || "Counter")}</td><td class="num"><b>${inr(b.total)}</b></td><td class="num" style="${b.due > 0 ? "color:var(--bad);font-weight:700" : ""}">${b.due > 0 ? inr(b.due) : "—"}</td>
      <td><span class="pill ${{ paid: "good", partial: "warn", unpaid: "warn", void: "bad" }[b.status]}">${b.status === "void" ? "cancelled" : b.status}</span></td></tr>`).join("")}</tbody></table></div>` : `<div class="card empty">No bills in these dates.</div>`}`;
  ["#gi-f", "#gi-t", "#gi-s"].forEach((x) => ($(x).onchange = drawBills));
  $("#gi-x").onclick = () => { const head = "Bill,Date,Customer,Phone,Station,Total,Paid,Pending,Status\n";
    const csv = head + rows.map((b) => [b.number, fmtDT(b.created_at), b.customer_name, b.customer_phone, b.station_name || "Counter", b.total, b.paid, b.due, b.status].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })); a.download = `bills_${f.from}_${f.to}.csv`; a.click(); };
  el.onclick = (e) => { const r = e.target.closest("[data-bill]"); if (r) billModal(rows.find((x) => x.id === r.dataset.bill)); };
}
async function billModal(b) {
  const pays = await q(sb.from("gc_payments").select("*").eq("bill_id", b.id).order("created_at")).catch(() => []);
  const url = `${await site()}/g.html?t=${b.token}`;
  const m = openModal(`<div class="modal-head"><h2>${esc(b.number)}</h2><span class="pill ${{ paid: "good", partial: "warn", unpaid: "warn", void: "bad" }[b.status]}">${b.status}</span></div>
    <p class="muted" style="margin-top:0">${fmtDT(b.created_at)} · ${esc(b.customer_name || "Walk-in")} ${esc(prettyPhone(b.customer_phone || ""))}</p>
    <div class="table-wrap"><table><tbody>${b.lines.map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${+l.qty}</td><td class="num">${inr2(l.amount)}</td></tr>`).join("")}</tbody></table></div>
    <table class="gc-tot" style="width:100%"><tbody><tr><td>Subtotal</td><td class="num">${inr2(b.subtotal)}</td></tr>${+b.discount ? `<tr><td>Discount</td><td class="num">−${inr2(b.discount)}</td></tr>` : ""}<tr><td>GST</td><td class="num">${inr2(b.tax)}</td></tr><tr class="g"><td>Total</td><td class="num">${inr(b.total)}</td></tr>
      <tr><td>Paid</td><td class="num">${inr2(b.paid)}</td></tr>${b.due > 0 ? `<tr><td style="color:var(--bad)">Pending</td><td class="num" style="color:var(--bad)"><b>${inr2(b.due)}</b></td></tr>` : ""}</tbody></table>
    ${b.lp ? `<h3>🏆 LP split</h3><div class="table-wrap"><table><tbody>${b.lp.players.map((p) => `<tr><td>${esc(p.player)}</td><td>${p.wins} win${p.wins === 1 ? "" : "s"}</td><td class="num"><b>${inr(p.payable)}</b></td></tr>`).join("")}</tbody></table></div>` : ""}
    ${pays.length ? `<p class="small muted">${pays.map((p) => `${fmtDT(p.created_at)} · ${p.mode.toUpperCase()} ${inr2(p.amount)}${p.paid_by ? " by " + esc(p.paid_by) : ""}`).join("<br>")}</p>` : ""}
    <div class="modal-foot" style="justify-content:flex-start;flex-wrap:wrap"><a class="btn" target="_blank" href="${url}">📄 Open</a><a class="btn" target="_blank" href="${url}&print=thermal">🖨️ Thermal</a>
      ${b.customer_phone ? `<button class="btn wa" id="g-wb">💬 Send bill</button>` : ""}${b.due > 0 && b.status !== "void" && b.customer_phone ? `<button class="btn wa" id="g-wd">💬 Payment reminder</button>` : ""}
      ${b.due > 0 && b.status !== "void" && ctx().canWrite ? `<button class="btn primary" id="g-pay">Collect ${inr(b.due)}</button>` : ""}${owner() && b.status !== "void" ? `<button class="btn danger" id="g-void">Cancel bill</button>` : ""}</div>`, { wide: true });
  const on = (id, fn) => { const x = $(id, m); if (x) x.onclick = () => guard(x, fn); };
  on("#g-wb", async () => sendWA("bill", b.id, b.customer_phone, await billText(b)));
  on("#g-wd", async () => sendWA("due", b.id, b.customer_phone, await dueText(b)));
  on("#g-pay", async () => formModal({ title: `Collect · ${b.number}`, submitLabel: "Collect", fields: [{ key: "amount", label: "Amount", type: "number", required: true, step: "0.01" }, { key: "mode", label: "Paid by", type: "select", options: [["cash", "Cash"], ["upi", "UPI"], ["card", "Card"]] }],
    values: { amount: b.due, mode: "cash" }, onSave: async (v) => { await rpc("gc_bill_pay", { p_bill: b.id, p_mode: v.mode, p_amount: v.amount }); toast("Payment saved"); drawBills(); } }));
  on("#g-void", async () => formModal({ title: `Cancel ${b.number}`, submitLabel: "Cancel bill", fields: [{ key: "reason", label: "Reason", required: true, full: true }],
    onSave: async (v) => { await rpc("gc_bill_void", { p_bill: b.id, p_reason: v.reason }); toast("Bill cancelled, stock returned"); drawBills(); } }));
}

// =====================================================================================
//  Snacks & stock
// =====================================================================================
async function drawStock() {
  const el = $("#gs-view"); if (!el) return;
  const rows = await q(sb.from("gc_products").select("*").eq("business_id", BID()).order("category").order("name"));
  el.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:12px"><span class="muted">${rows.length} items</span><div class="row">${ctx().canWrite ? `<button class="btn" data-g="sale">🧾 Counter sale</button>` : ""}${owner() ? `<button class="btn primary" id="gs-new">＋ Item</button>` : ""}</div></div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th>Group</th><th class="num">Price</th>${owner() ? `<th class="num">Cost</th>` : ""}<th class="num">Stock</th><th></th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td><b>${esc(p.name)}</b> ${p.active ? "" : '<span class="pill bad">hidden</span>'}</td><td>${esc(p.category)}</td><td class="num">${inr(p.price)}</td>${owner() ? `<td class="num muted">${inr(p.cost)}</td>` : ""}
      <td class="num" style="${p.track_stock && p.stock <= p.low_stock ? "color:var(--bad);font-weight:700" : ""}">${p.track_stock ? p.stock : "∞"}</td><td style="text-align:right">${owner() ? `<button class="btn sm" data-sk="${p.id}">± Stock</button> <button class="btn sm" data-se="${p.id}">✎</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card empty">No snacks yet. Add drinks, snacks and accessories (extra controller, headset) so staff can put them on bills.</div>`}`;
  const edit = (p = {}) => formModal({ title: p.id ? "Edit item" : "New item", submitLabel: "Save",
    fields: [{ key: "name", label: "Name", required: true }, { key: "category", label: "Group" }, { key: "price", label: "Selling price", type: "number", required: true, step: "0.01" }, { key: "cost", label: "Cost price", type: "number", step: "0.01" },
      ...(p.id ? [] : [{ key: "stock", label: "Opening stock", type: "number" }]), { key: "low_stock", label: "Warn when stock is at", type: "number" }, { key: "track_stock", label: "Track stock", type: "checkbox" }, { key: "active", label: "Show to staff", type: "checkbox" }],
    values: { category: "Snacks", low_stock: 5, track_stock: true, active: true, stock: 0, cost: 0, ...p },
    onSave: async (v) => { if (p.id) await q(sb.from("gc_products").update(v).eq("id", p.id)); else await q(sb.from("gc_products").insert({ ...v, business_id: BID() })); G.products = null; drawStock(); } });
  const nb = $("#gs-new"); if (nb) nb.onclick = () => edit();
  el.onclick = (e) => { const ed = e.target.closest("[data-se]"), sk = e.target.closest("[data-sk]");
    if (ed) edit(rows.find((x) => x.id === ed.dataset.se));
    if (sk) { const p = rows.find((x) => x.id === sk.dataset.sk); formModal({ title: `Stock · ${p.name} (now ${p.stock})`, submitLabel: "Update", fields: [{ key: "delta", label: "Add (+) or remove (−)", type: "number", required: true }],
      onSave: async (v) => { await q(sb.from("gc_products").update({ stock: p.stock + (+v.delta || 0) }).eq("id", p.id)); G.products = null; drawStock(); } }); } };
}

// =====================================================================================
//  Reports (owner)
// =====================================================================================
async function drawReports() {
  const el = $("#gr-view"); if (!el) return;
  G.repFrom = $("#gr-f")?.value || G.repFrom || new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10); G.repTo = $("#gr-t")?.value || G.repTo || todayISO();
  const r = await rpc("gc_report", { p_business: BID(), p_from: G.repFrom, p_to: G.repTo }), s = r.summary;
  const days = []; for (let d = new Date(G.repFrom + "T12:00:00"); d <= new Date(G.repTo + "T12:00:00"); d.setDate(d.getDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const byD = Object.fromEntries(r.daily.map((x) => [x.d, x])), mx = Math.max(1, ...r.daily.map((x) => +x.sales)), peak = Array.from({ length: 24 }, (_, h) => r.peak.find((p) => p.hour === h)?.sessions || 0), mp = Math.max(1, ...peak);
  const hb = (rows, k, v) => { const top = Math.max(1, ...rows.map((x) => +x[v])); return rows.length ? rows.map((x) => `<div class="row" style="flex-wrap:nowrap;margin:5px 0"><span class="small" style="width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x[k])}</span><div class="gc-bar" style="flex:1;height:10px"><i style="width:${(x[v] / top) * 100}%"></i></div><b class="small num" style="width:80px;text-align:right">${inr(x[v])}</b></div>`).join("") : `<p class="muted">No data</p>`; };
  el.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:12px"><div class="row"><input type="date" id="gr-f" value="${G.repFrom}"><input type="date" id="gr-t" value="${G.repTo}"></div><button class="btn" onclick="window.print()">🖨️ Print / PDF</button></div>
    <div class="grid g4">${A.kpi("Sales", inr(s.sales), `${s.bills} bills`)}${A.kpi("Collected", inr(s.collected), "cash + UPI + card")}${A.kpi("Gaming time", inr(s.gaming))}${A.kpi("Snacks", inr(s.items))}
      ${A.kpi("GST", inr(s.tax))}${A.kpi("Discounts", inr(s.discount))}${A.kpi("Pending (all time)", inr(s.outstanding))}${A.kpi("LP matches", s.lp_matches)}</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:14px">
      <div class="card"><h3>Daily sales</h3><div class="gc-bars">${days.map((d) => `<i style="height:${((+byD[d]?.sales || 0) / mx) * 100}%" title="${d}: ${inr(byD[d]?.sales || 0)}"></i>`).join("")}</div><div class="row muted small" style="justify-content:space-between"><span>${days[0]?.slice(5)}</span><span>${days.at(-1)?.slice(5)}</span></div></div>
      <div class="card"><h3>Busy hours</h3><div class="gc-bars">${peak.map((v, h) => `<i style="height:${(v / mp) * 100}%;background:var(--good)" title="${h}:00 · ${v} sessions"></i>`).join("")}</div><div class="row muted small" style="justify-content:space-between"><span>12 am</span><span>12 pm</span><span>11 pm</span></div></div>
      <div class="card"><h3>Cash, UPI, card</h3>${hb(r.by_mode.map((x) => ({ ...x, mode: x.mode.toUpperCase() })), "mode", "amount")}</div>
      <div class="card"><h3>By game type</h3>${hb(r.by_type, "type", "amount")}</div>
      <div class="card"><h3>Stations</h3><div class="table-wrap" style="border:0"><table><thead><tr><th>Station</th><th class="num">Sessions</th><th class="num">Hours</th><th class="num">Busy</th><th class="num">Revenue</th></tr></thead><tbody>${r.by_station.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.sessions}</td><td class="num">${x.hours}</td><td class="num">${Math.round((x.hours / (r.range_hours || 1)) * 100)}%</td><td class="num">${inr(x.revenue)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h3>Top snacks</h3>${hb(r.items, "name", "revenue")}</div></div>
    <p class="muted small" style="margin-top:12px">Expenses, profit & loss and GST returns are in <a href="#accounts">Accounts & GST</a>${A.hasMod("accounting") ? "" : " (add-on)"}.</p>`;
  $("#gr-f").onchange = drawReports; $("#gr-t").onchange = drawReports;
}

// =====================================================================================
//  Set-up (owner): stations, pricing rules, bills, WhatsApp add-on
// =====================================================================================
async function drawSetup() {
  const el = $("#gu-view"); if (!el) return;
  if (location.hash.includes("?wa")) G.setupTab = "wa";
  const tabs = [["stations", "Stations"], ["rules", "Pricing rules"], ["bills", "Bill & timer settings"], ["wa", "WhatsApp bills"]];
  const cf = await rpc("gc_board", { p_business: BID() }).then((b) => b.settings).catch(() => ({}));
  el.innerHTML = `<div class="tabs" style="margin-bottom:14px">${tabs.map(([k, l]) => `<button class="chip" data-tab="${k}" aria-pressed="${G.setupTab === k}">${l}</button>`).join(" ")}</div><div id="gu-body">${spin}</div>`;
  $$("[data-tab]", el).forEach((b) => (b.onclick = () => { G.setupTab = b.dataset.tab; drawSetup(); }));
  const body = $("#gu-body");
  if (G.setupTab === "stations") {
    const rows = await q(sb.from("gc_stations").select("*").eq("business_id", BID()).order("sort").order("name"));
    body.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:10px"><p class="muted" style="margin:0">Base price per hour. Happy hours and day prices go in <b>Pricing rules</b>.</p><button class="btn primary" id="gu-new">＋ Station</button></div>
      <div class="table-wrap"><table><thead><tr><th>Station</th><th>Type</th><th class="num">Per hour</th><th class="num">Players included</th><th class="num">Extra player /hr</th><th></th><th></th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.type)}</td><td class="num">${inr(s.rate)}</td><td class="num">${s.included_players}</td><td class="num">${inr(s.extra_player_rate)}</td><td>${s.active ? '<span class="pill good">on</span>' : '<span class="pill">off</span>'}</td><td style="text-align:right"><button class="btn sm" data-e="${s.id}">✎ Edit</button></td></tr>`).join("") || `<tr><td colspan="7" class="muted">No stations yet</td></tr>`}</tbody></table></div>`;
    const ed = (s = {}) => formModal({ title: s.id ? "Edit station" : "New station", submitLabel: "Save",
      fields: [{ key: "name", label: "Name", required: true, placeholder: "PS5 #1" }, { key: "type", label: "Type", type: "select", options: TYPES.includes(s.type) || !s.type ? TYPES : [s.type, ...TYPES] },
        { key: "rate", label: "Price per hour (₹)", type: "number", required: true, step: "0.01" }, { key: "included_players", label: "Players included in the price", type: "number", min: 1 },
        { key: "extra_player_rate", label: "Each extra player, per hour (₹)", type: "number", step: "0.01" }, { key: "sort", label: "Order on the board", type: "number" }, { key: "active", label: "Show on the board", type: "checkbox" }],
      values: { type: "PS5", rate: 100, included_players: 1, extra_player_rate: 0, sort: rows.length + 1, active: true, ...s },
      onSave: async (v) => { if (s.id) await q(sb.from("gc_stations").update(v).eq("id", s.id)); else await q(sb.from("gc_stations").insert({ ...v, business_id: BID() })); drawSetup(); } });
    $("#gu-new").onclick = () => ed(); body.onclick = (e) => { const b = e.target.closest("[data-e]"); if (b) ed(rows.find((x) => x.id === b.dataset.e)); };
  }
  if (G.setupTab === "rules") {
    const [rows, st] = await Promise.all([q(sb.from("gc_rules").select("*").eq("business_id", BID()).order("priority", { ascending: false })), q(sb.from("gc_stations").select("id,name,type").eq("business_id", BID()))]);
    const price = (r) => (r.mode === "fixed" ? `${inr(r.value)}/hr` : r.mode === "percent" ? `${+r.value}% off` : `+${inr(r.value)}/hr`);
    const hm = (t) => String(t || "").slice(0, 5).replace("00:00", "00:00");
    body.innerHTML = `<div class="card" style="margin-bottom:12px"><b>How it works</b><p class="muted" style="margin:6px 0 0">Every minute is priced with the matching rule that has the highest priority. A session from 3:30 pm into a 4 pm happy hour is billed at both rates. Use rules for happy hours, weekend or Sunday prices, late nights, or one station type.</p></div>
      <div class="row" style="justify-content:flex-end;margin-bottom:10px"><button class="btn primary" id="gu-new">＋ Pricing rule</button></div>
      <div class="table-wrap"><table><thead><tr><th>Rule</th><th>For</th><th>Days</th><th>Time</th><th>Price</th><th class="num">Priority</th><th></th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${r.station_type === "*" ? "All stations" : r.station_type.startsWith("#") ? esc(st.find((x) => "#" + x.id === r.station_type)?.name || "One station") : esc(r.station_type)}</td><td>${r.days.length === 7 ? "Every day" : r.days.map((d) => DAYS[d]).join(", ")}</td><td>${hm(r.start_time)}–${hm(r.end_time)}</td><td>${price(r)}</td><td class="num">${r.priority}</td><td>${r.active ? '<span class="pill good">on</span>' : '<span class="pill">off</span>'}</td><td style="text-align:right"><button class="btn sm" data-e="${r.id}">✎</button> <button class="btn sm danger" data-d="${r.id}">✕</button></td></tr>`).join("") || `<tr><td colspan="8" class="muted">No rules. Station prices apply all the time.</td></tr>`}</tbody></table></div>`;
    const types = [...new Set(st.map((x) => x.type))];
    const ed = (r = {}) => { const m = formModal({ title: r.id ? "Edit pricing rule" : "New pricing rule", submitLabel: "Save rule",
      fields: [{ key: "name", label: "Name", required: true, placeholder: "Happy hours / Sunday special" }, { key: "days", label: "Days", type: "multiselect", options: DAYS.map((d, i) => [String(i), d]), full: true },
        { key: "start_time", label: "From", type: "time", required: true }, { key: "end_time", label: "To (00:00 = midnight)", type: "time", required: true },
        { key: "station_type", label: "For", type: "select", options: [["*", "All stations"], ...types.map((t) => [t, "All " + t]), ...st.map((x) => ["#" + x.id, "Only " + x.name])] },
        { key: "mode", label: "Price", type: "select", options: [["percent", "% off the station price"], ["fixed", "Fixed price per hour"], ["add", "Extra per hour"]] },
        { key: "value", label: "Value", type: "number", required: true, step: "0.01" }, { key: "priority", label: "Priority (higher wins)", type: "number" }, { key: "active", label: "On", type: "checkbox" }],
      values: { days: (r.days || [0, 1, 2, 3, 4, 5, 6]).map(String), start_time: hm(r.start_time) || "12:00", end_time: hm(r.end_time) === "24:00" ? "00:00" : hm(r.end_time) || "16:00", station_type: "*", mode: "percent", value: 20, priority: 1, active: true, ...r, ...(r.id ? { days: r.days.map(String), start_time: hm(r.start_time), end_time: hm(r.end_time) } : {}) },
      onSave: async (v) => { if (!v.days.length) throw new Error("Pick at least one day");
        const row = { ...v, days: v.days.map(Number), end_time: v.end_time === "00:00" ? "24:00" : v.end_time };
        if (r.id) await q(sb.from("gc_rules").update(row).eq("id", r.id)); else await q(sb.from("gc_rules").insert({ ...row, business_id: BID() })); drawSetup(); } });
      void m; };
    $("#gu-new").onclick = () => ed();
    body.onclick = async (e) => { const b = e.target.closest("[data-e]"), d = e.target.closest("[data-d]");
      if (b) ed(rows.find((x) => x.id === b.dataset.e));
      if (d && (await confirmBox("Delete this rule?", "Station prices will apply in that time instead.", "Delete", { danger: true }))) guard(null, async () => { await q(sb.from("gc_rules").delete().eq("id", d.dataset.d)); drawSetup(); }); };
  }
  if (G.setupTab === "bills") {
    body.innerHTML = `<div class="card" style="max-width:760px"><form id="gu-f"><div class="fields">
      <div class="field"><label>GST %</label><input id="u-tax" type="number" step="0.01" value="${cf.tax_percent}"></div><div class="field"><label>GSTIN (on bills)</label><input id="u-gstin" value="${esc(cf.gstin)}"></div>
      <label class="check" style="grid-column:1/-1"><input type="checkbox" id="u-incl" ${cf.tax_inclusive ? "checked" : ""}> My prices already include GST</label>
      <div class="field"><label>Bill number prefix</label><input id="u-pre" value="${esc(cf.bill_prefix)}"></div><div class="field"><label>UPI ID (pay link on bills)</label><input id="u-upi" value="${esc(cf.upi_id)}" placeholder="club@upi"></div>
      <div class="field" style="grid-column:1/-1"><label>Bill footer</label><input id="u-foot" value="${esc(cf.bill_footer)}"></div>
      <div class="field"><label>Round up time to every (min)</label><input id="u-round" type="number" min="1" max="60" value="${cf.round_minutes}"></div><div class="field"><label>Minimum charge (min)</label><input id="u-min" type="number" min="0" value="${cf.min_minutes}"></div>
      <div class="field"><label>"Time up" popup, minutes before the end</label><input id="u-rem" type="number" min="1" max="60" value="${cf.reminder_minutes}"></div><div></div>
      <label class="check" style="grid-column:1/-1"><input type="checkbox" id="u-book" ${cf.charge_booked ? "checked" : ""}> Charge the full booked time even if they stop early</label></div>
      <p class="err" id="u-err"></p><div class="modal-foot"><button class="btn primary">Save</button></div></form></div>`;
    $("#gu-f").onsubmit = (e) => { e.preventDefault(); guard($("#gu-f button"), async () => {
      await q(sb.from("gc_settings").update({ tax_percent: +$("#u-tax").value, gstin: $("#u-gstin").value.trim(), tax_inclusive: $("#u-incl").checked, bill_prefix: $("#u-pre").value.trim() || "GC", upi_id: $("#u-upi").value.trim(),
        bill_footer: $("#u-foot").value, round_minutes: +$("#u-round").value, min_minutes: +$("#u-min").value, reminder_minutes: +$("#u-rem").value, charge_booked: $("#u-book").checked, updated_at: new Date().toISOString() }).eq("business_id", BID()));
      toast("Saved"); G.board = null; }); };
  }
  if (G.setupTab === "wa") {
    const D = ctx().D, mod = (D.mods || []).find((x) => x.key === "wa_billing"), yr = D.biz.billing === "yearly", on = hasWA();
    const pend = on ? [] : (await q(sb.from("payments").select("id,meta").eq("business_id", BID()).eq("kind", "module").eq("status", "pending")).catch(() => [])).filter((p) => p.meta?.module === "wa_billing");
    const log = on ? await q(sb.from("gc_wa_log").select("*").eq("business_id", BID()).order("created_at", { ascending: false }).limit(30)).catch(() => []) : [];
    const LBL = { bill: "Bill", due: "Payment reminder", reminder: "Time up", booking: "Booking", report: "Daily report", weekly: "Weekly report", monthly: "Monthly report", low_stock: "Low stock", dues: "Pending payments" };
    // [setting, title, when it goes]
    const CUST = [["wa_bill", "🧾 Bill + feedback link", "Right after every bill, with the bill link and your review page"],
      ["wa_time_reminder", "⏰ Time is ending", `${cf.reminder_minutes} minutes before booked time ends (also from the staff popup)`],
      ["wa_followup", "💸 Payment reminders", "For pending bills, 10 am–8 pm"], ["wa_booking", "📅 Booking confirmed / cancelled", "When staff approve or cancel a booking"]];
    const OWN = [["wa_daily_report", "📊 Daily sales report", "Sales, bills, collected, pending and the busiest station, every day"],
      ["report_weekly", "🗓️ Weekly report", "Every Monday, for the last 7 days"], ["report_monthly", "📅 Monthly report", "On the 1st, for the last month"],
      ["report_low_stock", "📦 Low-stock alert", "Items at or under their warning level (only when something is low)"],
      ["report_dues", "🔔 Pending payments", "Total pending and how many customers owe you (only when something is pending)"]];
    const sw = (k, t, d) => `<label class="check" style="align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line)"><input type="checkbox" data-sw="${k}" ${cf[k] ? "checked" : ""} ${on ? "" : "disabled"}>
      <span style="flex:1"><b>${t}</b><br><span class="muted small">${d}</span>${k === "wa_followup" ? `<br><span class="small">Every <input id="w-fud" type="number" min="1" max="30" value="${cf.followup_days}" style="width:56px" ${on ? "" : "disabled"}> days, up to <input id="w-fut" type="number" min="0" max="10" value="${cf.followup_times}" style="width:56px" ${on ? "" : "disabled"}> times</span>` : ""}</span><span class="pill">1 credit</span></label>`;
    body.innerHTML = `${on ? "" : `<div class="card upsell" style="margin-bottom:14px"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">🧾 WhatsApp bills, follow-ups & reports</h2>
        <p style="margin:6px 0 0">Sent automatically from Branditude's verified WhatsApp number. You pick which ones below.<br>${mod && +mod.addon_price ? `<b>${inr(mod.addon_price * (yr ? 10 : 1))}/${yr ? "year" : "month"}</b> + ` : "<b>No monthly fee.</b> You pay "}<b>1 utility credit per message</b> (you have ${D.walletU}).</p></div>
        ${pend.length ? `<span class="pill warn">Payment waiting for confirmation</span>` : mod ? `<button class="btn primary" data-a="buy-module" data-id="${mod.id}">${+mod.addon_price ? `Add for ${inr(mod.addon_price * (yr ? 10 : 1))}${yr ? "/year" : "/month"}` : "Switch on (free)"}</button>` : ""}</div>
        <p class="muted small" style="margin:10px 0 0">Without the add-on you can still send any bill from your own phone with one tap.</p></div>`}
      ${on && !D.biz.wa_enabled ? `<div class="card" style="margin-bottom:14px;border-color:var(--warn)">WhatsApp is off for your account. Buy utility credits on the <a href="#whatsapp">WhatsApp</a> page to switch it on.</div>` : ""}
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">
        <div class="card"><h3 style="margin-top:0">Messages to customers</h3>${CUST.map((x) => sw(...x)).join("")}</div>
        <div class="card"><h3 style="margin-top:0">Reports to you</h3>${OWN.map((x) => sw(...x)).join("")}
          <div class="fields" style="margin-top:10px"><div class="field"><label>Send reports to (WhatsApp)</label><input id="w-rph" value="${esc(cf.report_phone)}" placeholder="Business number if empty" ${on ? "" : "disabled"}></div>
          <div class="field"><label>At</label><select id="w-rh" ${on ? "" : "disabled"}>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === cf.report_hour ? "selected" : ""}>${h === 0 ? "12 am" : h < 12 ? h + " am" : h === 12 ? "12 pm" : h - 12 + " pm"}</option>`).join("")}</select></div></div></div></div>
      ${on ? `<div class="row" style="justify-content:space-between;margin-top:12px"><span class="muted">Utility credits left: <b>${D.walletU}</b> · <a href="#whatsapp">Buy credits</a></span><button class="btn primary" id="w-save">Save choices</button></div>
      <div class="card" style="margin-top:14px"><h3 style="margin-top:0">Recent messages</h3>${log.length ? `<div class="table-wrap"><table><tbody>${log.map((l) => `<tr><td>${fmtDT(l.created_at)}</td><td>${esc(LBL[l.kind] || l.kind)}</td><td>${esc(prettyPhone(l.phone))}</td><td><span class="pill ${l.status === "sent" ? "good" : l.status === "failed" ? "bad" : ""}">${l.status}</span> <span class="muted small">${esc(l.error || "")}</span></td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">None yet.</p>`}</div>` : ""}`;
    const sv = $("#w-save"); if (sv) sv.onclick = () => guard(sv, async () => {
      const up = Object.fromEntries($$("[data-sw]", body).map((i) => [i.dataset.sw, i.checked]));
      await q(sb.from("gc_settings").update({ ...up, followup_days: +$("#w-fud").value || 2, followup_times: +$("#w-fut").value || 0,
        report_phone: $("#w-rph").value.replace(/\D/g, "").replace(/^(\d{10})$/, "91$1"), report_hour: +$("#w-rh").value, updated_at: new Date().toISOString() }).eq("business_id", BID()));
      toast("Saved. Only the ticked messages will be sent."); });
  }
}

// ---------- register with the portal ----------
const wrap = (id, fn) => async () => { const el = $("#" + id); if (!document.getElementById("gc-css")) document.head.insertAdjacentHTML("beforeend", styles); try { await fn(); } catch (e) { if (el) el.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; } };
export function registerGaming(api) {
  A = api;
  api.VIEWS.gboard = () => api.head("Live board", "Timers, LP matches and bills for every station") + `<div id="gb-view">${spin}</div>`;
  api.after.gboard = wrap("gb-view", async () => { await loadBoard(); drawBoard(); startLive(); });
  api.VIEWS.gbookings = () => api.head("Bookings", "Slots booked by staff or online") + `<div id="gk-view">${spin}</div>`;
  api.after.gbookings = wrap("gk-view", drawBookings);
  api.VIEWS.gbills = () => api.head("Bills", "Every bill, pending amounts and payment reminders") + `<div id="gi-view">${spin}</div>`;
  api.after.gbills = wrap("gi-view", async () => { if (!G.board) await loadBoard().catch(() => {}); await drawBills(); });
  api.VIEWS.gstock = () => api.head("Snacks & stock", "Items staff can add to bills") + `<div id="gs-view">${spin}</div>`;
  api.after.gstock = wrap("gs-view", drawStock);
  api.VIEWS.greports = () => api.head("Gaming reports", "Sales, stations, busy hours and snacks") + `<div id="gr-view">${spin}</div>`;
  api.after.greports = wrap("gr-view", drawReports);
  api.VIEWS.gsetup = () => api.head("Stations & pricing", "Stations, happy hours, bill settings and WhatsApp bills") + `<div id="gu-view">${spin}</div>`;
  api.after.gsetup = wrap("gu-view", drawSetup);
}
