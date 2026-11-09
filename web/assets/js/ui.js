// Shared UI helpers for all portals
import { DEFAULT_COUNTRY_CODE } from "./config.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const inr = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Math.round(+n || 0));
export const inr2 = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(+n || 0);
export const nfmt = (n) => new Intl.NumberFormat("en-IN").format(Math.round(+n || 0));
export const DAY = 864e5;
export const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : Infinity);
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const fmtShort = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");
export const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
export const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
export const ago = (iso) => { const d = daysSince(iso); if (d === Infinity) return "never"; if (d <= 0) return "today"; if (d === 1) return "yesterday"; if (d < 30) return d + " days ago"; if (d < 365) return Math.floor(d / 30) + " mo ago"; return Math.floor(d / 365) + " yr ago"; };
export function daysToBirthday(b) {
  if (!b) return Infinity; const [, m, d] = String(b).split("-").map(Number); if (!m || !d) return Infinity;
  const t = new Date(); t.setHours(0, 0, 0, 0); let n = new Date(t.getFullYear(), m - 1, d); if (n < t) n = new Date(t.getFullYear() + 1, m - 1, d);
  return Math.round((n - t) / DAY);
}
export function normPhone(p, cc = DEFAULT_COUNTRY_CODE) {
  let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1); if (d.length === 10) d = String(cc).replace(/\D/g, "") + d; return d;
}
export const prettyPhone = (p) => { const d = String(p || ""); return d.length > 10 ? "+" + d.slice(0, d.length - 10) + " " + d.slice(-10, -5) + " " + d.slice(-5) : d; };

export function toast(msg, kind) {
  const t = document.createElement("div"); t.className = "toast"; if (kind === "error") t.style.background = "var(--bad)";
  t.textContent = msg; t.setAttribute("role", "status"); document.body.appendChild(t); setTimeout(() => t.remove(), kind === "error" ? 4500 : 2600);
}
export async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast((label || "Copied") + " ✓"); } catch { toast("Couldn't copy. Select and copy it manually.", "error"); }
}

/* ---------- modal ---------- */
let modalRoot;
export function openModal(html, { wide = false } = {}) {
  modalRoot = modalRoot || document.getElementById("modal-root") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "modal-root" }));
  modalRoot.innerHTML = `<div class="modal-back" data-modal-back><div class="modal" role="dialog" aria-modal="true" style="${wide ? "max-width:760px" : ""}">${html}</div></div>`;
  const f = modalRoot.querySelector("input:not([type=hidden]),select,textarea"); if (f) f.focus();
  return modalRoot.querySelector(".modal");
}
export function closeModal() { if (modalRoot) modalRoot.innerHTML = ""; }
export const modalOpen = () => !!(modalRoot && modalRoot.innerHTML);
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-modal-back]"); if (b && e.target === b) closeModal();
  if (e.target.closest("[data-close]")) closeModal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

export function confirmBox(title, body, okLabel = "OK", { danger = false } = {}) {
  return new Promise((res) => {
    const m = openModal(`<div class="modal-head"><h2>${esc(title)}</h2></div><p>${esc(body)}</p>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" id="cb-ok">${esc(okLabel)}</button></div>`);
    m.querySelector("#cb-ok").onclick = () => { closeModal(); res(true); };
    m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => res(false)));
  });
}

/* Generic form modal. fields: [{key,label,type,options,required,placeholder,help,full,min,step}] */
export function formModal({ title, fields, values = {}, submitLabel = "Save", onSave, extraFoot = "" }) {
  const v = (k) => values[k] ?? "";
  const field = (f) => {
    const id = "fm-" + f.key; const req = f.required ? "required" : "";
    let input;
    if (f.type === "select") input = `<select id="${id}" ${req}>${(f.options || []).map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(v(f.key)) === String(val) ? "selected" : ""}>${esc(lab)}</option>`; }).join("")}</select>`;
    else if (f.type === "multiselect") input = `<div class="chips" id="${id}" data-multi>${(f.options || []).map(([val, lab]) => `<button type="button" class="chip" data-val="${esc(val)}" aria-pressed="${(v(f.key) || []).includes(val)}">${esc(lab)}</button>`).join("")}</div>`;
    else if (f.type === "textarea") input = `<textarea id="${id}" ${req} placeholder="${esc(f.placeholder || "")}">${esc(v(f.key))}</textarea>`;
    else if (f.type === "checkbox") return `<label class="check ${f.full ? "" : ""}" style="${f.full ? "grid-column:1/-1" : ""}"><input type="checkbox" id="${id}" ${v(f.key) ? "checked" : ""}> ${esc(f.label)}</label>`;
    else if (f.type === "lines") input = `<textarea id="${id}" placeholder="One per line">${esc((v(f.key) || []).join("\n"))}</textarea>`;
    else input = `<input id="${id}" type="${f.type || "text"}" ${req} value="${esc(v(f.key))}" placeholder="${esc(f.placeholder || "")}" ${f.min != null ? `min="${f.min}"` : ""} ${f.step ? `step="${f.step}"` : ""}>`;
    return `<div class="field" style="${f.full ? "grid-column:1/-1" : ""}"><label for="${id}">${esc(f.label)}</label>${input}${f.help ? `<span class="muted small" style="margin-top:4px">${esc(f.help)}</span>` : ""}</div>`;
  };
  const m = openModal(`<div class="modal-head"><h2>${esc(title)}</h2><button class="btn ghost" data-close>Close</button></div>
    <form id="fm"><div class="fields">${fields.map(field).join("")}</div><p class="err" id="fm-err" role="alert" style="margin-top:10px"></p>
    <div class="modal-foot">${extraFoot}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${esc(submitLabel)}</button></div></form>`, { wide: fields.length > 6 });
  m.querySelectorAll("[data-multi] .chip").forEach((c) => (c.onclick = () => c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") !== "true")));
  m.querySelector("#fm").onsubmit = async (e) => {
    e.preventDefault(); const out = {};
    for (const f of fields) {
      const el = m.querySelector("#fm-" + f.key);
      if (f.type === "checkbox") out[f.key] = el.checked;
      else if (f.type === "multiselect") out[f.key] = [...el.querySelectorAll('.chip[aria-pressed="true"]')].map((c) => c.dataset.val);
      else if (f.type === "lines") out[f.key] = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
      else if (f.type === "number") out[f.key] = el.value === "" ? null : +el.value;
      else out[f.key] = el.value.trim();
    }
    const btn = m.querySelector('button[type="submit"]'); btn.disabled = true;
    try { await onSave(out); closeModal(); } catch (err) { m.querySelector("#fm-err").textContent = err.message || String(err); btn.disabled = false; }
  };
  return m;
}

/* ---------- icons ---------- */
const I = {
  dash: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  store: '<path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  wa: '<path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.3z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .9c-1-.4-1.8-1.2-2.2-2.2l.9-1-1-2z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="3"/><circle cx="8" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  rupee: '<path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  food: '<path d="M4 3v8a3 3 0 0 0 3 3v7M7 3v6M10 3v8a3 3 0 0 1-3 3M17 21V3c-2 1-3 3.5-3 7v4h3"/>',
  receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
};
export const ico = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k] || ""}</svg>`;

/* ---------- shell ---------- */
export function shell({ brandSub, groups, current, footer }) {
  return `<div class="brand"><div class="brand-mark">B</div><div><b>Branditude</b><small>${esc(brandSub)}</small></div></div>` +
    groups.map((g) => (g.label ? `<div class="rail-group">${esc(g.label)}</div>` : "") +
      g.items.map(([k, l, i, badge]) => `<a class="nav-link" href="#${k}" ${k === current ? 'aria-current="page"' : ""}>${ico(i)}<span>${esc(l)}</span>${badge ? `<span class="nav-badge num">${badge}</span>` : ""}</a>`).join("")).join("") +
    `<div class="rail-foot">${footer}</div>`;
}

export function barChart(points, { label = (p) => p.label, value = (p) => p.value, fmt = inr } = {}) {
  const W = 560, H = 180, pad = 26, n = Math.max(points.length, 1), bw = (W - pad * 2) / n;
  const max = Math.max(...points.map(value), 1); const mag = Math.pow(10, Math.floor(Math.log10(max))); const nice = Math.ceil(max / mag) * mag;
  const y = (v) => H - pad - (v / nice) * (H - pad * 2);
  let g = `<line x1="${pad}" x2="${W - pad}" y1="${y(nice)}" y2="${y(nice)}" stroke="var(--line)" stroke-dasharray="3 4"/><text x="${pad}" y="${y(nice) - 6}">${fmt(nice)}</text><line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>`;
  points.forEach((p, i) => { const v = value(p), x = pad + i * bw + 3, last = i === n - 1;
    g += `<rect x="${x}" y="${y(v)}" width="${Math.max(bw - 6, 2)}" height="${Math.max(y(0) - y(v), v ? 2 : 0)}" rx="3" fill="${last ? "var(--accent)" : "var(--ink-3)"}" opacity="${last ? 1 : 0.45}"><title>${esc(label(p))}: ${fmt(v)}</title></rect>`; });
  const ticks = n > 8 ? [0, Math.floor(n / 2), n - 1] : points.map((_, i) => i);
  ticks.forEach((i) => points[i] && (g += `<text x="${pad + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(label(points[i]))}</text>`));
  if (points.length) g += `<text x="${W - pad}" y="${y(value(points[n - 1])) - 6}" text-anchor="end" style="fill:var(--ink);font-weight:600">${fmt(value(points[n - 1]))}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}
export const hbars = (rows, fmt = nfmt) => { const max = Math.max(...rows.map((r) => +r.value), 1);
  return rows.length ? rows.map((r) => `<div class="hbar"><span title="${esc(r.label)}">${esc(r.label)}</span><div class="bar"><i style="width:${Math.round((+r.value / max) * 100)}%"></i></div><b class="num">${fmt(r.value)}</b></div>`).join("") : `<div class="empty">No data yet.</div>`; };

export const statusPill = (s) => { const m = { trial: "info", active: "good", won: "good", confirmed: "good", happy: "good", pending_payment: "warn", pending: "warn", payment_pending: "warn", contacted: "info", new: "acc", open: "bad", paused: "bad", rejected: "bad", lost: "", cancelled: "", resolved: "" };
  return `<span class="pill ${m[s] ?? ""}">${esc(String(s).replace(/_/g, " "))}</span>`; };

/* ---------- loyalty card (shared by business + customer portals) ---------- */
export const THEMES = { saffron: ["#e2701b", "#9a3d0a"], ink: ["#16203a", "#3d4f86"], emerald: ["#0f766e", "#073b35"], plum: ["#7c2d6b", "#3b1240"], rose: ["#d1495b", "#7a1f2e"] };
export const rwLabel = (r) => (!r ? "" : r.note && r.note.trim() ? r.note.trim() : r.type === "percent" ? `${+r.value}% off${+r.max_discount ? ` (up to ${inr(r.max_discount)})` : ""}` : r.type === "flat" ? `${inr(r.value)} off` : "Free gift");
export const rwShort = (r) => (r.type === "percent" ? `${+r.value}%` : r.type === "flat" ? `₹${+r.value}` : "Free");
export const rewardAt = (rewards, n) => (rewards || []).find((r) => +r.visit_no === n) || null;
export function nextReward(done, prog, rewards) { for (let v = done + 1; v <= +prog.stamps; v++) { const r = rewardAt(rewards, v); if (r) return { visit: v, r }; } return null; }
export function loyaltyCard({ bizName, prog, rewards, customer }) {
  const N = Math.max(1, +prog.stamps || 10), st = Math.min(customer.stamps || 0, N), th = THEMES[prog.theme] || THEMES.saffron, nx = nextReward(st, prog, rewards);
  const cells = [...Array(N)].map((_, i) => { const v = i + 1, r = rewardAt(rewards, v), on = v <= st, fin = v === N;
    return `<div class="st${on ? " on" : ""}${r && !on ? " gift" : ""}${fin && !on ? " final" : ""}" title="Visit ${v}${r ? ": " + esc(rwLabel(r)) : ""}">${on ? "✓" : r ? `<span>${fin ? "🏆" : "🎁"}<span class="rw">${esc(rwShort(r))}</span></span>` : v}</div>`; }).join("");
  const last4 = String(customer.phone || "").replace(/\D/g, "").slice(-4);
  return `<div class="lcard" style="--lc1:${th[0]};--lc2:${th[1]}">
    <div class="lc-top"><div><div class="lc-biz">${esc(bizName || "")}</div><div class="lc-prog">${esc(prog.name || "Loyalty card")}</div></div><div class="lc-count num"><b>${st}</b>/${N}</div></div>
    <div class="lc-stamps" role="img" aria-label="${st} of ${N} visits stamped">${cells}</div>
    <div class="lc-next">${nx ? (nx.visit === st + 1 ? `🎁 Your next visit gets <b>${esc(rwLabel(nx.r))}</b>` : `🎁 ${nx.visit - st} more visits to <b>${esc(rwLabel(nx.r))}</b>`) : "🏆 Card complete. Thank you!"}</div>
    <div class="lc-foot"><span>${esc(customer.name || "")}</span><span class="num">${last4 ? "•••• " + esc(last4) : ""}${customer.cards_completed ? ` · ${customer.cards_completed} card${customer.cards_completed > 1 ? "s" : ""} completed` : ""}</span></div></div>`;
}
export const LCARD_CSS_READY = true;
