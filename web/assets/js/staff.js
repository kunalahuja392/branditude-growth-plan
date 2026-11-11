// Business portal: Staff & attendance (#staff) and Salary (#salary)
import { sb, q } from "./sb.js";
import { $, esc, inr, inr2, fmtDate, toast, openModal, closeModal, confirmBox, formModal, ico, normPhone, prettyPhone, copy } from "./ui.js";
import { computeStaffMonth, DEFAULT_SETTINGS, CODES, ist, todayIST, monthDates } from "./payroll.js";

const STAFF_COLS = "id,business_id,name,phone,designation,pay_type,pay_rate,shift_start,shift_end,break_minutes,weekly_off,joined_on,active,sort,created_at";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PAY = { monthly: "per month", daily: "per day", hourly: "per hour" };
const MARKS = [["", "Auto (from check-in times)"], ["present", "Present"], ["half_day", "Half day"], ["absent", "Absent"], ["leave", "Leave (uses paid leave allowance)"],
  ["paid_leave", "Paid leave (always paid)"], ["unpaid_leave", "Unpaid leave"], ["holiday", "Holiday"], ["week_off", "Weekly off"]];
const SHORT = { P: "P", H: "½", A: "A", L: "L", PL: "L", UL: "UL", WO: "WO", HO: "HO", NJ: "·", F: "" };
const CODE_CLS = { P: "good", H: "warn", A: "bad", L: "info", PL: "info", UL: "bad", WO: "", HO: "acc", NJ: "", F: "" };

let A;              // portal api from business.js
const S = { tab: "today", ym: null, d: null, showLeft: false };

const ymNow = () => todayIST().slice(0, 7);
const ymParts = (ym) => ym.split("-").map(Number);
const ymShift = (ym, k) => { let [y, m] = ymParts(ym); m += k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, "0")}`; };
const ymLabel = (ym) => new Date(ym + "-01T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const hm = (min) => { if (min == null) return "—"; min = ((min % 1440) + 1440) % 1440; const h = Math.floor(min / 60), m = min % 60; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const tOf = (iso) => (iso ? hm(ist(iso).min) : "—");
const t24 = (iso) => { if (!iso) return ""; const m = ist(iso).min; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const shiftTxt = (s) => `${hm(+s.shift_start.slice(0, 2) * 60 + +s.shift_start.slice(3, 5))} – ${hm(+s.shift_end.slice(0, 2) * 60 + +s.shift_end.slice(3, 5))}`;
const settings = () => ({ ...DEFAULT_SETTINGS, ...(S.d?.settings || {}) });
const ctx = () => A.ctx();
const can = () => ctx().canWrite;
const staffList = () => (S.d?.staff || []).filter((s) => S.showLeft || s.active);

async function load(ym = S.ym) {
  const { BID } = ctx(); const [y, m] = ymParts(ym); const from = `${ym}-01`, to = monthDates(y, m).at(-1);
  // add this month's instalment for open advances (once per month; skipped months stay skipped)
  if (ctx().canWrite) await sb.rpc("advance_sync", { p_business: BID, p_month: from }).catch?.(() => {});
  const [staff, st, att, hol, adj, slips, pins] = await Promise.all([
    q(sb.from("staff").select(STAFF_COLS).eq("business_id", BID).order("sort").order("name")),
    q(sb.from("att_settings").select("*").eq("business_id", BID).maybeSingle()),
    q(sb.from("attendance").select("*").eq("business_id", BID).gte("day", from).lte("day", to)),
    q(sb.from("holidays").select("*").eq("business_id", BID).order("day")),
    q(sb.from("salary_adjustments").select("*").eq("business_id", BID).eq("month", from).order("created_at")),
    q(sb.from("salary_slips").select("*").eq("business_id", BID).eq("month", from)),
    q(sb.rpc("staff_pin_status", { b: BID })),
  ]);
  const adv = await q(sb.rpc("advance_list", { p_business: BID })).catch(() => []);
  S.d = { staff, settings: st, att, hol, adj, slips, adv, pins: Object.fromEntries((pins || []).map((p) => [p.staff_id, p])), ym };
}
const monthCalc = (s) => { const [y, m] = ymParts(S.d.ym); return computeStaffMonth({ settings: settings(), staff: s, records: S.d.att, holidays: S.d.hol, adjustments: S.d.adj, year: y, month: m, today: todayIST() }); };
const recOf = (staffId, day) => S.d.att.find((r) => r.staff_id === staffId && r.day === day);

/* =================== Staff & attendance =================== */
function drawStaff() {
  const el = $("#st-view"); if (!el) return;
  const tabs = [["today", "Today"], ["register", "Monthly register"], ["staff", "Staff"], ["rules", "Salary & attendance rules"], ["holidays", "Holidays"]];
  el.innerHTML = A.head("Staff & attendance", "Staff check in on their phone with their PIN. Late marks, half days and salary are worked out from your rules.",
    `<button class="btn" data-st="qr">${ico("grid")} Check-in QR</button><button class="btn primary" data-st="add" ${can() ? "" : "disabled"}>${ico("plus")} Add staff</button>`) +
    `<div class="tabs" role="tablist" style="margin-bottom:16px;max-width:820px">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${S.tab === k}" data-st-tab="${k}">${l}</button>`).join("")}</div>
     <div id="st-body">${({ today: tabToday, register: tabRegister, staff: tabStaffList, rules: tabRules, holidays: tabHolidays })[S.tab]()}</div>`;
  if (S.tab === "rules") wireRules();
}

function tabToday() {
  const today = todayIST(), list = (S.d.staff || []).filter((s) => s.active);
  if (!list.length) return `<div class="card empty">No staff yet. <button class="btn primary sm" data-st="add" ${can() ? "" : "disabled"}>Add your first staff member</button></div>`;
  const rows = list.map((s) => { const calc = monthCalc(s); return { s, day: calc.days.find((d) => d.date === today), rec: recOf(s.id, today) }; });
  const inNow = rows.filter((r) => r.rec?.check_in && !r.rec?.check_out).length, late = rows.filter((r) => r.day?.late > 0).length;
  const notIn = rows.filter((r) => r.day?.pending).length, off = rows.filter((r) => ["WO", "HO", "L", "PL", "UL"].includes(r.day?.code)).length;
  return `<div class="grid g4" style="margin-bottom:16px">${A.kpi("In now", inNow, `of ${list.length} staff`)}${A.kpi("Late today", late, `grace ${settings().grace_minutes} min`)}${A.kpi("Not in yet", notIn, "working today")}${A.kpi("Off / leave", off, fmtDate(today))}</div>
  <div class="table-wrap"><table><thead><tr><th>Staff</th><th>Shift</th><th>In</th><th>Out</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map(({ s, day, rec }) => `<tr><td><div class="who"><b>${esc(s.name)}</b><span>${esc(s.designation || prettyPhone(s.phone))}</span></div></td><td class="small">${shiftTxt(s)}</td>
    <td class="num">${tOf(rec?.check_in)}</td><td class="num">${tOf(rec?.check_out)}</td>
    <td><span class="pill ${day.pending ? "warn" : CODE_CLS[day.code]}">${day.pending ? "Not in yet" : day.inProgress ? "Working" : CODES[day.code]}</span>${day.late ? ` <span class="pill warn">late ${day.late} min</span>` : ""}${rec?.mark ? ` <span class="pill">set by you</span>` : ""}</td>
    <td><div class="row" style="justify-content:flex-end">${!rec?.check_in ? `<button class="btn sm" data-st="in" data-id="${s.id}" ${can() ? "" : "disabled"}>Check in now</button>` : !rec?.check_out ? `<button class="btn sm" data-st="out" data-id="${s.id}" ${can() ? "" : "disabled"}>Check out now</button>` : ""}
      <button class="btn sm ghost" data-st="day" data-id="${s.id}" data-day="${today}">Edit</button></div></td></tr>`).join("")}
  </tbody></table></div>
  <p class="small muted" style="margin-top:10px">Staff check themselves in from the <b>Check-in QR</b> page with their phone number and PIN. You can also check them in here or edit any day.</p>`;
}

function tabRegister() {
  const [y, m] = ymParts(S.d.ym), dates = monthDates(y, m), list = staffList();
  const nav = `<div class="row" style="margin-bottom:12px"><button class="btn sm" data-st="ym" data-k="-1">‹</button><b style="min-width:150px;text-align:center">${ymLabel(S.d.ym)}</b><button class="btn sm" data-st="ym" data-k="1">›</button>
    <span class="small muted" style="margin-left:8px">Tap any day to correct it. P present · ½ half day · A absent · L paid leave · UL unpaid leave · WO weekly off · HO holiday · <span style="color:var(--warn)">●</span> late</span></div>`;
  if (!list.length) return nav + `<div class="card empty">No staff yet.</div>`;
  return nav + `<div class="table-wrap reg"><table style="min-width:${260 + dates.length * 34}px"><thead><tr><th class="reg-name">Staff</th>${dates.map((d) => `<th class="c">${+d.slice(8)}<br><span>${DOW[new Date(d + "T00:00:00Z").getUTCDay()][0]}</span></th>`).join("")}<th>P</th><th>½</th><th>A</th><th>L</th><th>Late</th></tr></thead><tbody>
  ${list.map((s) => { const c = monthCalc(s); return `<tr><td class="reg-name"><div class="who"><b>${esc(s.name)}</b><span>${esc(s.designation || "")}</span></div></td>
    ${c.days.map((d) => `<td class="c ${d.code === "F" && !d.pending ? "" : "tap"}" ${d.code === "F" && !d.pending ? "" : `data-st="day" data-id="${s.id}" data-day="${d.date}"`} title="${esc(CODES[d.code])}${d.late ? `, late ${d.late} min` : ""}${d.note ? " · " + esc(d.note) : ""}"><span class="cc cc-${d.code}">${SHORT[d.code]}</span>${d.late || d.early ? '<i class="late-dot"></i>' : ""}</td>`).join("")}
    <td class="num">${c.counts.P}</td><td class="num">${c.counts.H}</td><td class="num">${c.counts.A + c.counts.UL}</td><td class="num">${c.counts.L}</td><td class="num">${c.lateCount}</td></tr>`; }).join("")}
  </tbody></table></div>`;
}

function tabStaffList() {
  const all = S.d.staff || [], left = all.filter((s) => !s.active).length;
  return `<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Phone</th><th>Pay</th><th>Shift</th><th>Weekly off</th><th>Check-in PIN</th><th></th></tr></thead><tbody>
  ${staffList().map((s) => { const p = S.d.pins[s.id]; return `<tr style="${s.active ? "" : "opacity:.55"}"><td><div class="who"><b>${esc(s.name)}</b><span>${esc(s.designation || "")}${s.active ? "" : " · left"}</span></div></td><td class="num">${prettyPhone(s.phone)}</td>
    <td class="num">${inr(s.pay_rate)} <span class="muted small">${PAY[s.pay_type]}</span></td><td class="small">${shiftTxt(s)}${s.break_minutes ? `<br><span class="muted">${s.break_minutes} min break</span>` : ""}</td>
    <td class="small">${(s.weekly_off || []).map((d) => DOW[d]).join(", ") || "None"}</td>
    <td>${p?.locked ? '<span class="pill bad">Locked</span>' : p?.has_pin ? '<span class="pill good">Set</span>' : '<span class="pill warn">Not set</span>'}</td>
    <td><div class="row" style="justify-content:flex-end"><button class="btn sm" data-st="pin" data-id="${s.id}" ${can() ? "" : "disabled"}>${p?.has_pin ? "Reset PIN" : "Set PIN"}</button><button class="btn sm ghost" data-st="edit" data-id="${s.id}">Edit</button></div></td></tr>`; }).join("") || `<tr><td colspan="7" class="empty">No staff yet.</td></tr>`}
  </tbody></table></div>${left ? `<label class="check" style="margin-top:10px"><input type="checkbox" data-st="showleft" ${S.showLeft ? "checked" : ""}> Show ${left} staff who left</label>` : ""}`;
}

const RULE_GROUPS = [
  ["Month & pay", "How a day's pay is worked out for monthly salary.", [
    { key: "month_days", label: "Days in a month", type: "select", options: [["calendar", "Actual days (28–31)"], ["fixed", "Fixed number of days"], ["working", "Working days only (minus offs & holidays)"]] },
    { key: "fixed_days", label: "Fixed days", type: "number", min: 20, help: "Used when 'Fixed number of days' is chosen (often 26 or 30)" },
    { key: "paid_weekly_off", label: "Weekly offs are paid", type: "checkbox" }, { key: "paid_holidays", label: "Holidays are paid", type: "checkbox" },
  ]],
  ["Late & early", "A late mark is counted when someone checks in after shift start + grace, or (optionally) leaves before shift end.", [
    { key: "grace_minutes", label: "Grace minutes", type: "number", min: 0, help: "e.g. 10 = 10:10 for a 10:00 shift is still on time" },
    { key: "late_allowed", label: "Late marks allowed per month", type: "number", min: 0, help: "No cut for these" },
    { key: "late_rule", label: "Cut for extra late marks", type: "select", options: [["none", "No cut"], ["half_day_per", "Half day for every N extra late marks"], ["full_day_per", "Full day for every N extra late marks"], ["fixed_per_late", "Fixed ₹ for each extra late mark"], ["per_minute", "Per minute late (× N)"]] },
    { key: "late_rule_value", label: "N", type: "number", min: 0, step: "0.5", help: "Number of late marks, ₹ amount, or minute multiplier, depending on the rule" },
    { key: "count_early_leave", label: "Leaving early also counts as a late mark", type: "checkbox" },
    { key: "early_grace_minutes", label: "Early-leaving grace (minutes)", type: "number", min: 0 },
  ]],
  ["Half day & absent", "Day-wise cuts whole or half days. Hour-wise cuts exactly the hours someone was short.", [
    { key: "deduction_basis", label: "Cut salary", type: "select", options: [["day", "Day-wise (full / half / absent)"], ["hour", "Hour-wise (hours short × hourly rate)"]] },
    { key: "half_day_below_hours", label: "Half day if worked less than (hours)", type: "number", min: 0, step: "0.5" },
    { key: "absent_below_hours", label: "Absent if worked less than (hours)", type: "number", min: 0, step: "0.5" },
    { key: "missed_checkout", label: "If someone forgets to check out", type: "select", options: [["full", "Count a full day"], ["half", "Count a half day"], ["absent", "Count as absent"]] },
  ]],
  ["Leaves", "", [
    { key: "paid_leaves", label: "Paid leaves per month", type: "number", min: 0, step: "0.5" },
    { key: "absent_uses_leave", label: "Unused paid leave covers absences", type: "checkbox" },
    { key: "sandwich_rule", label: "Sandwich rule: an off day between two absences is also absent", type: "checkbox" },
  ]],
  ["Overtime & extra days", "", [
    { key: "overtime_on", label: "Pay overtime", type: "checkbox" },
    { key: "overtime_after_min", label: "Overtime starts after (minutes past shift)", type: "number", min: 0 },
    { key: "overtime_multiplier", label: "Overtime rate (× hourly pay)", type: "number", min: 0, step: "0.25", help: "1 = normal hourly rate, 1.5 = time and a half" },
    { key: "offday_work_pay", label: "Pay an extra day when someone works on a weekly off or holiday", type: "checkbox" },
  ]],
  ["Check-in location", "Only allow check-in when the phone is near the shop. Open this page at the shop and tap 'Use my location'.", [
    { key: "geo_on", label: "Staff must be at the shop to check in", type: "checkbox" },
    { key: "geo_lat", label: "Shop latitude", type: "number", step: "any" }, { key: "geo_lng", label: "Shop longitude", type: "number", step: "any" },
    { key: "geo_radius", label: "Allowed distance (metres)", type: "number", min: 30 },
  ]],
];
function ruleField(f, v) {
  const id = "rl-" + f.key, val = v[f.key] ?? "";
  if (f.type === "checkbox") return `<label class="check" style="grid-column:1/-1"><input type="checkbox" id="${id}" ${val ? "checked" : ""} ${can() ? "" : "disabled"}> ${esc(f.label)}</label>`;
  const input = f.type === "select" ? `<select id="${id}" ${can() ? "" : "disabled"}>${f.options.map(([o, l]) => `<option value="${o}" ${String(val) === o ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`
    : `<input id="${id}" type="number" value="${esc(val)}" ${f.min != null ? `min="${f.min}"` : ""} step="${f.step || 1}" ${can() ? "" : "disabled"}>`;
  return `<div class="field" style="${f.type === "select" ? "grid-column:1/-1" : ""}"><label for="${id}">${esc(f.label)}</label>${input}${f.help ? `<span class="muted small" style="margin-top:4px">${esc(f.help)}</span>` : ""}</div>`;
}
function tabRules() {
  const v = settings();
  return `<form id="rules-form"><div class="grid g2">${RULE_GROUPS.map(([t, p, fs]) => `<div class="card"><div class="card-head"><h2>${t}</h2></div>${p ? `<p class="small muted" style="margin:-4px 0 12px">${p}</p>` : ""}
    <div class="fields">${fs.map((f) => ruleField(f, v)).join("")}</div>${t === "Check-in location" ? `<button type="button" class="btn sm" data-st="geo" style="margin-top:10px" ${can() ? "" : "disabled"}>Use my current location</button>` : ""}</div>`).join("")}</div>
    <div class="card note" id="rule-example" style="margin-top:16px"></div>
    <div class="row" style="margin-top:16px"><button class="btn primary" type="submit" ${can() ? "" : "disabled"}>Save rules</button><span class="small muted">Changes apply to salary calculations straight away, including this month.</span></div></form>`;
}
function readRules() {
  const out = {};
  for (const [, , fs] of RULE_GROUPS) for (const f of fs) {
    const el = $("#rl-" + f.key); if (!el) continue;
    out[f.key] = f.type === "checkbox" ? el.checked : f.type === "number" ? (el.value === "" ? null : +el.value) : el.value;
  }
  return out;
}
function ruleExample() {
  const v = { ...settings(), ...readRules() }, sal = 15000, basis = v.month_days === "fixed" ? v.fixed_days : v.month_days === "working" ? 26 : 30, day = sal / basis;
  const lr = { none: "no cut for extra late marks", half_day_per: `a half-day cut (${inr(day / 2)}) for every ${v.late_rule_value} late marks after that`, full_day_per: `a full-day cut (${inr(day)}) for every ${v.late_rule_value} late marks after that`,
    fixed_per_late: `${inr(v.late_rule_value)} cut for each late mark after that`, per_minute: `a cut for every minute late after that (${inr2(day / 9 / 60 * v.late_rule_value)}/min on a 9-hour shift)` }[v.late_rule];
  $("#rule-example").innerHTML = `<b>Example with these rules:</b> a ₹15,000 monthly salary is ${inr2(day)} a day (${basis}-day ${v.month_days === "calendar" ? "month, e.g. November" : "basis"}).
    Checking in more than ${v.grace_minutes} min after shift start is a late mark. ${v.late_allowed} late marks a month are free, then ${lr}.
    ${v.deduction_basis === "hour" ? `Short hours are cut hour by hour (${inr2(day / 9)}/hour on a 9-hour shift); below ${v.absent_below_hours} h is absent.` : `Under ${v.half_day_below_hours} h worked is a half day (${inr(day / 2)} cut); under ${v.absent_below_hours} h is absent.`}
    ${+v.paid_leaves ? `${v.paid_leaves} paid leave${+v.paid_leaves === 1 ? "" : "s"} a month${v.absent_uses_leave ? ", which also cover absences" : ""}.` : "No paid leave."}${v.sandwich_rule ? " Sandwich rule is on." : ""}${v.overtime_on ? ` Overtime after ${v.overtime_after_min} min at ${v.overtime_multiplier}× the hourly rate.` : ""}`;
}
function wireRules() {
  const f = $("#rules-form"); if (!f) return;
  ruleExample(); f.oninput = ruleExample;
  f.onsubmit = async (e) => {
    e.preventDefault(); const v = readRules();
    if (v.geo_on && (v.geo_lat == null || v.geo_lng == null)) return toast("Add the shop location first (tap 'Use my current location' at the shop)", "error");
    if (v.absent_below_hours > v.half_day_below_hours) return toast("'Absent if less than' should be smaller than 'Half day if less than'", "error");
    try { await q(sb.from("att_settings").upsert({ business_id: ctx().BID, ...v, updated_at: new Date().toISOString() })); S.d.settings = { ...S.d.settings, ...v }; toast("Rules saved"); } catch (err) { toast(err.message, "error"); }
  };
}

function tabHolidays() {
  const y = ymParts(S.d.ym)[0], list = S.d.hol.filter((h) => h.day.startsWith(String(y)));
  return `<div class="grid g2"><div class="card"><div class="card-head"><h2>Holidays in ${y}</h2></div>
    ${list.length ? `<div class="list">${list.map((h) => `<div class="item"><div class="grow"><b>${esc(h.name)}</b><span class="muted small">${fmtDate(h.day)} · ${DOW[new Date(h.day + "T00:00:00Z").getUTCDay()]}</span></div><button class="btn sm ghost" data-st="hol-del" data-id="${h.id}" ${can() ? "" : "disabled"}>Remove</button></div>`).join("")}</div>` : `<div class="empty">No holidays added for ${y}.</div>`}</div>
    <div class="card"><div class="card-head"><h2>Add a holiday</h2></div><form id="hol-form" class="fields"><div class="field"><label for="hol-day">Date</label><input id="hol-day" type="date" required></div><div class="field"><label for="hol-name">Name</label><input id="hol-name" placeholder="Diwali" required></div>
      <div class="row" style="grid-column:1/-1"><button class="btn primary" ${can() ? "" : "disabled"}>Add holiday</button><button type="button" class="btn" data-st="hol-national" ${can() ? "" : "disabled"}>Add national holidays for ${y}</button></div></form>
      <p class="small muted" style="margin-top:10px">Holidays are paid like weekly offs (change this in the rules). Festivals change date every year, so add them here.</p></div></div>`;
}

/* ---------- forms & actions ---------- */
function staffForm(s = {}) {
  const isNew = !s.id;
  formModal({ title: isNew ? "Add staff" : `Edit ${s.name}`, submitLabel: isNew ? "Add staff" : "Save",
    values: { pay_type: "monthly", shift_start: "10:00", shift_end: "19:00", break_minutes: 0, weekly_off: ["0"], joined_on: todayIST(), active: true, ...s,
      phone: s.phone ? s.phone.slice(-10) : "", shift_start: (s.shift_start || "10:00").slice(0, 5), shift_end: (s.shift_end || "19:00").slice(0, 5), weekly_off: (s.weekly_off ?? [0]).map(String) },
    fields: [
      { key: "name", label: "Name", required: true }, { key: "phone", label: "Mobile number", type: "tel", required: true, help: "They check in with this number + their PIN" },
      { key: "designation", label: "Role", placeholder: "Chef, Stylist, Helper…" }, { key: "joined_on", label: "Joined on", type: "date" },
      { key: "pay_type", label: "Paid", type: "select", options: [["monthly", "Monthly salary"], ["daily", "Per day (daily wage)"], ["hourly", "Per hour"]] },
      { key: "pay_rate", label: "Amount ₹", type: "number", required: true, min: 0 },
      { key: "shift_start", label: "Shift starts", type: "time", required: true }, { key: "shift_end", label: "Shift ends", type: "time", required: true },
      { key: "break_minutes", label: "Unpaid break (minutes)", type: "number", min: 0 },
      { key: "weekly_off", label: "Weekly off", type: "multiselect", options: DOW.map((d, i) => [String(i), d]), full: true },
      { key: "pin", label: isNew ? "Check-in PIN (4–6 digits)" : "New PIN (leave blank to keep)", type: "password", placeholder: "e.g. 2468" },
      ...(isNew ? [] : [{ key: "active", label: "Still working here", type: "checkbox" }]),
    ],
    onSave: async (v) => {
      const phone = normPhone(v.phone); if (phone.length < 12) throw new Error("Enter a valid 10-digit mobile number");
      if (v.pin && !/^\d{4,6}$/.test(v.pin)) throw new Error("PIN must be 4 to 6 digits");
      if (isNew && !v.pin) throw new Error("Set a PIN so they can check in");
      const row = { name: v.name, phone, designation: v.designation, pay_type: v.pay_type, pay_rate: v.pay_rate || 0, shift_start: v.shift_start, shift_end: v.shift_end,
        break_minutes: v.break_minutes || 0, weekly_off: v.weekly_off.map(Number), joined_on: v.joined_on || todayIST(), ...(isNew ? {} : { active: v.active }) };
      let id = s.id;
      try {
        if (isNew) id = (await q(sb.from("staff").insert({ ...row, business_id: ctx().BID }).select("id").single())).id;
        else await q(sb.from("staff").update(row).eq("id", s.id));
      } catch (e) { throw new Error(/staff_phone_uq|duplicate/i.test(e.message) ? "Another staff member already uses this number" : e.message); }
      if (v.pin) await q(sb.rpc("set_staff_pin", { p_staff: id, p_pin: v.pin }));
      toast(isNew ? `${v.name} added` : "Saved"); await load(); drawStaff();
    } });
}
function pinForm(s) {
  formModal({ title: `PIN for ${s.name}`, submitLabel: "Save PIN", fields: [{ key: "pin", label: "New PIN (4–6 digits)", type: "password", required: true, help: "Tell them the PIN in person. Resetting also unlocks them after wrong tries." }],
    onSave: async (v) => { if (!/^\d{4,6}$/.test(v.pin)) throw new Error("PIN must be 4 to 6 digits"); await q(sb.rpc("set_staff_pin", { p_staff: s.id, p_pin: v.pin })); toast("PIN saved"); await load(); drawStaff(); } });
}
function dayForm(s, day) {
  const r = recOf(s.id, day) || {};
  const m = openModal(`<div class="modal-head"><h2>${esc(s.name)} · ${fmtDate(day)}</h2><button class="btn ghost" data-close>Close</button></div>
    <form id="day-form"><div class="fields">
      <div class="field" style="grid-column:1/-1"><label for="d-mark">Status</label><select id="d-mark">${MARKS.map(([v, l]) => `<option value="${v}" ${(r.mark || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="d-in">Checked in</label><input id="d-in" type="time" value="${t24(r.check_in)}"></div>
      <div class="field"><label for="d-out">Checked out</label><input id="d-out" type="time" value="${t24(r.check_out)}"></div>
      <div class="field" style="grid-column:1/-1"><label for="d-note">Note</label><input id="d-note" value="${esc(r.note || "")}" placeholder="Doctor visit, came late because of rain…"></div></div>
      <p class="small muted" style="margin-top:8px">Shift ${shiftTxt(s)}. "Auto" works out present, half day, late and overtime from the times. Any other status overrides the times.${r.source === "self" ? " Times were recorded by the staff member's own check-in." : ""}</p>
      <p class="err" id="d-err"></p>
      <div class="modal-foot">${r.id ? `<button type="button" class="btn ghost" id="d-clear" style="margin-right:auto">Clear day</button>` : ""}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" ${can() ? "" : "disabled"}>Save</button></div></form>`);
  const iso = (t, nextDay) => { if (!t) return null; const d = new Date(`${day}T${t}:00+05:30`); if (nextDay) d.setTime(d.getTime() + 864e5); return d.toISOString(); };
  m.querySelector("#day-form").onsubmit = async (e) => {
    e.preventDefault(); const tin = $("#d-in").value, tout = $("#d-out").value;
    if (tout && !tin) return ($("#d-err").textContent = "Add the check-in time too");
    const row = { business_id: ctx().BID, staff_id: s.id, day, mark: $("#d-mark").value || null, note: $("#d-note").value.trim(), check_in: iso(tin), check_out: iso(tout, tin && tout && tout < tin), updated_at: new Date().toISOString() };
    if (r.id) row.source = r.source === "self" && tin === t24(r.check_in) ? "self" : "manual";
    try { await q(sb.from("attendance").upsert(row, { onConflict: "staff_id,day" })); closeModal(); toast("Saved"); await load(); A.isRoute("salary") ? drawSalary() : drawStaff(); } catch (err) { $("#d-err").textContent = err.message; }
  };
  const c = m.querySelector("#d-clear"); if (c) c.onclick = async () => { await q(sb.from("attendance").delete().eq("id", r.id)); closeModal(); toast("Cleared"); await load(); A.isRoute("salary") ? drawSalary() : drawStaff(); };
}
function qrModal() {
  const link = new URL("a.html?b=" + ctx().D.biz.slug, location.href).href;
  const m = openModal(`<div class="modal-head"><h2>Staff check-in</h2><button class="btn ghost" data-close>Close</button></div>
    <div class="grid g2"><div style="text-align:center"><div id="att-qr" class="qr" style="display:inline-block;padding:12px;background:#fff;border-radius:12px"></div></div>
    <div><p>Print this QR and stick it near the counter, or open the link on a shop tablet. Staff scan it, enter their mobile number and PIN, and tap once to check in and again to check out.</p>
    <p class="small muted">${settings().geo_on ? "Location check is on: staff must be at the shop." : "Tip: turn on the location check in the rules so nobody checks in from home."}</p>
    <div class="row"><button class="btn" data-copy>${ico("copy")} Copy link</button><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open check-in page</a><button class="btn primary" data-print>Print poster</button></div></div></div>`);
  if (window.QRCode) new QRCode(m.querySelector("#att-qr"), { text: link, width: 200, height: 200, colorDark: "#16203a", colorLight: "#ffffff" });
  m.querySelector("[data-copy]").onclick = () => copy(link, "Link");
  m.querySelector("[data-print]").onclick = () => { const img = m.querySelector("#att-qr canvas")?.toDataURL() || m.querySelector("#att-qr img")?.src;
    printHTML(`<div style="text-align:center;font-family:system-ui,sans-serif;padding:40px"><h1 style="font-size:34px;margin:0">${esc(ctx().D.biz.name)}</h1><p style="font-size:22px;margin:8px 0 24px">Staff check-in &amp; check-out</p>
      <img src="${img}" style="width:320px;height:320px"><p style="font-size:18px;margin-top:20px">Scan → enter your mobile number and PIN → tap the button</p></div>`); };
}
export function printHTML(body, title = "Print") {
  const w = window.open("", "_blank"); if (!w) return toast("Allow pop-ups to print", "error");
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{margin:0;color:#16203a}@page{margin:12mm}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;font-size:13px}</style></head><body>${body}<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
}

async function onStaffClick(e) {
  const el = e.target.closest("[data-st]"); if (!el || !$("#st-view, #sal-view")) return;
  const a = el.dataset.st, id = el.dataset.id, s = (S.d?.staff || []).find((x) => x.id === id), BID = ctx().BID;
  try {
    if (a === "add") return staffForm();
    if (a === "edit") return staffForm(s);
    if (a === "pin") return pinForm(s);
    if (a === "qr") return qrModal();
    if (a === "day") return dayForm(s, el.dataset.day);
    if (a === "ym") { S.ym = ymShift(S.d.ym, +el.dataset.k); await load(S.ym); return A.isRoute("salary") ? drawSalary() : drawStaff(); }
    if (a === "showleft") { S.showLeft = el.checked; return drawStaff(); }
    if (a === "in" || a === "out") {
      const today = todayIST(), now = new Date().toISOString();
      await q(sb.from("attendance").upsert({ business_id: BID, staff_id: id, day: today, ...(a === "in" ? { check_in: now } : { check_in: recOf(id, today).check_in, check_out: now }), source: "manual", updated_at: now }, { onConflict: "staff_id,day" }));
      toast(`${s.name} checked ${a}`); await load(); return drawStaff();
    }
    if (a === "geo") {
      if (!navigator.geolocation) return toast("This browser can't share location", "error");
      el.disabled = true; el.textContent = "Finding location…";
      navigator.geolocation.getCurrentPosition((p) => { $("#rl-geo_lat").value = p.coords.latitude.toFixed(6); $("#rl-geo_lng").value = p.coords.longitude.toFixed(6); $("#rl-geo_on").checked = true; el.disabled = false; el.textContent = "Use my current location"; ruleExample(); toast(`Location set (±${Math.round(p.coords.accuracy)} m). Save the rules.`); },
        (err) => { el.disabled = false; el.textContent = "Use my current location"; toast("Couldn't get location: " + err.message, "error"); }, { enableHighAccuracy: true, timeout: 15000 });
      return;
    }
    if (a === "hol-del") { await q(sb.from("holidays").delete().eq("id", id)); await load(); return drawStaff(); }
    if (a === "hol-national") {
      const y = ymParts(S.d.ym)[0];
      await q(sb.from("holidays").upsert([[`${y}-01-26`, "Republic Day"], [`${y}-08-15`, "Independence Day"], [`${y}-10-02`, "Gandhi Jayanti"]].map(([day, name]) => ({ business_id: BID, day, name })), { onConflict: "business_id,day", ignoreDuplicates: true }));
      toast("Added Republic Day, Independence Day and Gandhi Jayanti"); await load(); return drawStaff();
    }
    if (a === "adj") return adjForm(s);
    if (a === "adj-del") { const row = S.d.adj.find((x) => x.id === id);
      if (row?.advance_id) { if (!(await confirmBox("Skip this month's advance cut?", "The balance stays and is cut from the next months instead.", "Skip this month"))) return; await q(sb.rpc("advance_skip", { p_business: BID, p_id: row.advance_id, p_month: S.d.ym + "-01", p_skip: true })); }
      else { if (!(await confirmBox("Remove this entry?", "", "Remove", { danger: true }))) return; await q(sb.from("salary_adjustments").delete().eq("id", id)); }
      closeModal(); await load(); return drawSalary(); }
    if (a === "adv-new") return advanceForm(id);
    if (a === "tip-new") return tipForm();
    if (a === "tip-del") { if (!(await confirmBox("Remove this tip?", "It comes off the salary for this month.", "Remove", { danger: true }))) return; await q(sb.from("salary_adjustments").delete().eq("id", id)); await load(); return drawSalary(); }
    if (a === "adv-skip" || a === "adv-resume") { await q(sb.rpc("advance_skip", { p_business: BID, p_id: id, p_month: S.d.ym + "-01", p_skip: a === "adv-skip" })); await load(); return drawSalary(); }
    if (a === "adv-del") { if (!(await confirmBox("Delete this advance?", "Its monthly cuts are removed too.", "Delete", { danger: true }))) return; await q(sb.rpc("advance_delete", { p_business: BID, p_id: id })); toast("Advance deleted"); await load(); return drawSalary(); }
    if (a === "slip") return payslip(s);
    if (a === "paid") return paidForm(s);
    if (a === "unpaid") { await q(sb.from("salary_slips").delete().eq("staff_id", id).eq("month", S.d.ym + "-01")); toast("Marked as not paid"); await load(); return drawSalary(); }
    if (a === "export-xlsx" || a === "export-csv") return exportSalary(a === "export-xlsx" ? "xlsx" : "csv");
  } catch (err) { toast(err.message, "error"); }
}
document.addEventListener("click", onStaffClick);
document.addEventListener("change", (e) => { if (e.target.matches?.('[data-st="showleft"]')) onStaffClick(e); });
document.addEventListener("click", (e) => { const t = e.target.closest("[data-st-tab]"); if (!t) return; S.tab = t.dataset.stTab; if (S.tab === "today" && S.d.ym !== ymNow()) { S.ym = ymNow(); load(S.ym).then(drawStaff); } else drawStaff(); });
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "hol-form") return; e.preventDefault();
  try { await q(sb.from("holidays").upsert({ business_id: ctx().BID, day: $("#hol-day").value, name: $("#hol-name").value.trim() || "Holiday" }, { onConflict: "business_id,day" })); toast("Holiday added"); await load(); drawStaff(); } catch (err) { toast(err.message, "error"); }
});

/* =================== Salary =================== */
function drawSalary() {
  const el = $("#sal-view"); if (!el) return;
  const list = (S.d.staff || []).filter((s) => s.active || S.d.att.some((r) => r.staff_id === s.id));
  const rows = list.map((s) => ({ s, c: monthCalc(s), slip: S.d.slips.find((x) => x.staff_id === s.id) }));
  const total = rows.reduce((t, r) => t + r.c.net, 0), paid = rows.filter((r) => r.slip?.paid).reduce((t, r) => t + +r.slip.net, 0), inProg = rows.some((r) => r.c.inProgress);
  el.innerHTML = A.head("Salary", "Worked out from attendance and your rules. Add advances or bonuses, print payslips, and mark salaries as paid.",
    `<button class="btn" data-st="export-csv">Download CSV</button><button class="btn" data-st="export-xlsx">${ico("copy")} Download Excel</button>`) +
    `<div class="row" style="margin-bottom:12px"><button class="btn sm" data-st="ym" data-k="-1">‹</button><b style="min-width:150px;text-align:center">${ymLabel(S.d.ym)}</b><button class="btn sm" data-st="ym" data-k="1">›</button>
      ${inProg ? `<span class="pill info">Month still running: figures up to today</span>` : ""}<a class="small" href="#staff" data-st-tab="rules" style="margin-left:auto">Change salary rules</a></div>
    <div class="grid g4" style="margin-bottom:16px">${A.kpi("Total salary", inr(total), `${rows.length} staff`)}${A.kpi("Paid", inr(paid), `${rows.filter((r) => r.slip?.paid).length} of ${rows.length}`)}${A.kpi("Still to pay", inr(Math.max(0, total - paid)), "")}${A.kpi("Late marks", rows.reduce((t, r) => t + r.c.lateCount, 0), "this month")}</div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Pay</th><th>Days</th><th>Late</th><th>OT</th><th>Net pay</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map(({ s, c, slip }) => { const changed = slip?.paid && Math.abs(+slip.net - c.net) >= 1; return `<tr><td><div class="who"><b>${esc(s.name)}</b><span>${esc(s.designation || "")}</span></div></td>
      <td class="num small">${inr(s.pay_rate)}<br><span class="muted">${PAY[s.pay_type]}</span></td><td class="small" style="white-space:nowrap"><span class="cc cc-P" title="Present">${c.counts.P}</span> <span class="cc cc-H" title="Half days">${c.counts.H}</span> <span class="cc cc-A" title="Absent">${c.counts.A + c.counts.UL}</span> <span class="cc cc-L" title="Paid leave">${c.counts.L}</span></td>
      <td class="num">${c.lateCount}${c.latePenalty ? `<br><span class="small" style="color:var(--bad)">−${inr(c.latePenalty)}</span>` : ""}</td><td class="num">${c.otHours ? `${c.otHours} h` : "—"}</td>
      <td class="num"><b>${inr2(c.net)}</b></td>
      <td>${slip?.paid ? `<span class="pill good">Paid ${fmtDate(slip.paid_on)}</span>${changed ? `<br><span class="pill warn" title="Paid ${inr2(slip.net)}">Changed since paid</span>` : ""}` : '<span class="pill warn">Not paid</span>'}</td>
      <td style="min-width:200px"><div class="row" style="justify-content:flex-end;gap:6px"><button class="btn sm" data-st="slip" data-id="${s.id}">Payslip</button><button class="btn sm ghost" data-st="adj" data-id="${s.id}" ${ctx().canWrite ? "" : "disabled"}>+ Bonus / cut</button>
        ${slip?.paid ? `<button class="btn sm ghost" data-st="unpaid" data-id="${s.id}" ${ctx().canWrite ? "" : "disabled"}>Undo paid</button>` : `<button class="btn sm primary" data-st="paid" data-id="${s.id}" ${ctx().canWrite ? "" : "disabled"}>Mark paid</button>`}</div></td></tr>`; }).join("")}
    <tr><td colspan="5"><b>Total</b> <span class="small muted">· Days: <span class="cc cc-P">P</span> present <span class="cc cc-H">½</span> half <span class="cc cc-A">A</span> absent <span class="cc cc-L">L</span> paid leave</span></td><td class="num"><b>${inr2(total)}</b></td><td colspan="2"></td></tr></tbody></table></div>` : `<div class="card empty">No staff yet. <a href="#staff">Add staff</a> to start.</div>`}` + (rows.length ? tipsCard() + advancesCard() : "");
}
/* ---------- advances: given once, cut from salary in monthly instalments ---------- */
/* ---------- tips: for one person, or a shared pool split by the owner; paid with the month's salary ---------- */
function tipsCard() {
  const tips = (S.d.adj || []).filter((a) => a.kind === "tip"), can = ctx().canWrite, name = (id) => (S.d.staff.find((s) => s.id === id) || {}).name || "";
  const byStaff = {}; for (const t of tips) byStaff[t.staff_id] = (byStaff[t.staff_id] || 0) + +t.amount;
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Tips</h2><button class="btn sm primary" data-st="tip-new" ${can ? "" : "disabled"}>+ Add tips</button></div>
    <p class="small muted" style="margin:-4px 0 10px">Tips for one person go to them. Shared tips are split the way you choose. Both are added to ${ymLabel(S.d.ym)} salary and show on the payslip.</p>
    ${tips.length ? `<div class="chips" style="margin-bottom:10px">${Object.entries(byStaff).map(([id, v]) => `<span class="tag">${esc(name(id))}: <b>${inr2(v)}</b></span>`).join("")}</div>
      <div class="list">${tips.map((t) => `<div class="item small"><div class="grow"><b>${esc(name(t.staff_id))}</b><span class="muted">${t.tip_day ? fmtDate(t.tip_day) + " · " : ""}${esc(t.note || "Tip")}</span></div><b class="num">${inr2(t.amount)}</b>${can ? `<button class="btn sm ghost danger" data-st="tip-del" data-id="${t.id}" aria-label="Remove">✕</button>` : ""}</div>`).join("")}</div>` : `<div class="empty">No tips this month.</div>`}</div>`;
}
function tipForm() {
  const staff = (S.d.staff || []).filter((s) => s.active), today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
  const def = today.slice(0, 7) === S.d.ym ? today : S.d.ym + "-01";
  const m = openModal(`<div class="modal-head"><h2>Add tips</h2><button class="btn ghost" data-close>Close</button></div>
    <div class="fields"><div class="field"><label for="tp-day">Date</label><input id="tp-day" type="date" value="${def}" min="${S.d.ym}-01" max="${S.d.ym}-31"></div><div class="field"><label for="tp-amt">Amount ₹</label><input id="tp-amt" type="number" min="1" step="1"></div>
      <div class="field full"><label for="tp-who">Who gets it</label><select id="tp-who"><option value="pool">Shared by the team</option>${staff.map((s) => `<option value="${s.id}">${esc(s.name)} only</option>`).join("")}</select></div>
      <div class="field full" id="tp-how-f"><label for="tp-how">How to split it</label><select id="tp-how"><option value="present">Equally among staff present that day</option><option value="all">Equally among all staff</option><option value="custom">I'll choose each person's share</option></select></div>
      <div class="field full"><label for="tp-note">Note</label><input id="tp-note" placeholder="e.g. Saturday tip box, wedding order"></div></div>
    <div id="tp-split" style="margin-top:10px"></div><p class="err" id="tp-err"></p><div class="modal-foot"><button class="btn primary" id="tp-go">Add to salary</button></div>`);
  const $m = (s) => m.querySelector(s);
  const present = (day) => staff.filter((s) => { const r = S.d.att.find((x) => x.staff_id === s.id && x.day === day); return r && (r.check_in || ["present", "half_day"].includes(r.mark)); });
  const shares = () => { const amt = +$m("#tp-amt").value || 0, who = $m("#tp-who").value, how = $m("#tp-how").value;
    if (who !== "pool") return [{ id: who, amt }];
    let list = how === "present" ? present($m("#tp-day").value) : staff;
    if (how === "custom") { const ws = staff.map((s) => ({ id: s.id, w: Math.max(0, +($m(`[data-w="${s.id}"]`)?.value || 0)) })).filter((x) => x.w > 0), tw = ws.reduce((t, x) => t + x.w, 0);
      return tw ? split(amt, ws.map((x) => ({ id: x.id, f: x.w / tw }))) : []; }
    return list.length ? split(amt, list.map((s) => ({ id: s.id, f: 1 / list.length }))) : []; };
  const split = (amt, parts) => { let left = Math.round(amt * 100); const out = parts.map((p, i) => { const v = i === parts.length - 1 ? left : Math.round(amt * 100 * p.f); left -= v; return { id: p.id, amt: v / 100 }; }); return out.filter((x) => x.amt > 0); };
  const draw = () => { const who = $m("#tp-who").value, how = $m("#tp-how").value; $m("#tp-how-f").hidden = who !== "pool";
    const custom = who === "pool" && how === "custom";
    const sh = shares(), nm = (id) => staff.find((s) => s.id === id)?.name || "";
    $m("#tp-split").innerHTML = custom ? `<p class="small muted">Give each person a share (for example 2 for senior staff, 1 for helpers, 0 to leave someone out).</p><div class="list">${staff.map((s) => `<div class="item small"><div class="grow">${esc(s.name)}</div><input data-w="${s.id}" type="number" min="0" step="0.5" value="${$m(`[data-w="${s.id}"]`)?.value ?? 1}" style="max-width:90px" aria-label="Share for ${esc(s.name)}"><b class="num" style="min-width:80px;text-align:right">${inr2(sh.find((x) => x.id === s.id)?.amt || 0)}</b></div>`).join("")}</div>`
      : who === "pool" ? (sh.length ? `<div class="chips">${sh.map((x) => `<span class="tag">${esc(nm(x.id))}: <b>${inr2(x.amt)}</b></span>`).join("")}</div>` : `<p class="small muted">${how === "present" ? "Nobody is marked present on that day. Choose another split." : "Add staff first."}</p>`) : "";
    m.querySelectorAll("[data-w]").forEach((i) => (i.oninput = () => { const v = i.value; draw(); const j = $m(`[data-w="${i.dataset.w}"]`); j.value = v; j.focus(); })); };
  ["#tp-amt", "#tp-who", "#tp-how", "#tp-day"].forEach((s) => ($m(s).oninput = $m(s).onchange = draw)); draw();
  $m("#tp-go").onclick = async (e) => { const err = $m("#tp-err"); err.textContent = ""; const sh = shares(), day = $m("#tp-day").value, amt = +$m("#tp-amt").value || 0, pool = $m("#tp-who").value === "pool";
    if (!(amt > 0)) return (err.textContent = "Enter the tip amount"); if (!sh.length) return (err.textContent = "Nobody to give it to");
    if (day.slice(0, 7) !== S.d.ym) return (err.textContent = "Pick a date in " + ymLabel(S.d.ym));
    const note = ($m("#tp-note").value.trim() || (pool ? "Shared tip" : "Tip")) + (pool ? ` (${inr2(amt)} split ${sh.length} ways)` : "");
    e.target.disabled = true;
    try { await q(sb.from("salary_adjustments").insert(sh.map((x) => ({ business_id: ctx().BID, staff_id: x.id, month: S.d.ym + "-01", kind: "tip", amount: x.amt, note, tip_day: day }))));
      closeModal(); toast(`${inr2(amt)} in tips added to salary`); await load(); drawSalary(); } catch (x) { err.textContent = x.message; e.target.disabled = false; } };
}
function advancesCard() {
  const list = S.d.adv || [], open = list.filter((a) => +a.recovered < +a.amount), month = S.d.ym + "-01", can = ctx().canWrite;
  const cutThis = (a) => S.d.adj.find((x) => x.advance_id === a.id);
  const row = (a) => { const bal = +a.amount - +a.recovered, c = cutThis(a), skipped = (a.skip_months || []).includes(month);
    const W = (t) => `<span style="font-weight:700;color:var(--ink)">${t}</span>`;
    return `<div class="item"><div class="grow"><b>${esc(a.staff_name)}</b><span class="muted small">${inr(a.amount)} given ${fmtDate(a.given_on)} from ${a.paid_from}${a.note ? " · " + esc(a.note) : ""}</span>
      <div class="bar" style="margin:6px 0;max-width:320px"><i style="width:${Math.round((+a.recovered / +a.amount) * 100)}%"></i></div>
      <span class="small muted">${inr(a.recovered)} recovered · ${W(inr(bal) + " left")} · ${inr(a.monthly_cut)} a month${c ? ` · ${W(inr(c.amount) + " cut in " + ymLabel(S.d.ym))}` : skipped ? ` · skipped in ${ymLabel(S.d.ym)}` : ""}</span></div>
      ${!can ? "" : bal > 0 && c ? `<button class="btn sm ghost" data-st="adv-skip" data-id="${a.id}">Skip this month</button>` : skipped ? `<button class="btn sm ghost" data-st="adv-resume" data-id="${a.id}">Cut this month</button>` : ""}
      ${can && +a.recovered_paid === 0 ? `<button class="btn sm ghost danger" data-st="adv-del" data-id="${a.id}">Delete</button>` : ""}</div>`; };
  return `<div class="card" style="margin-top:16px"><div class="card-head"><h2>Advances</h2><button class="btn sm primary" data-st="adv-new" ${can ? "" : "disabled"}>+ Give an advance</button></div>
    <p class="small muted" style="margin:-4px 0 10px">Give money now and cut it from salary a bit each month. Cuts show on the payslip automatically.</p>
    ${open.length ? `<div class="list">${open.map(row).join("")}</div>` : `<div class="empty">No advances to recover.</div>`}
    ${list.length > open.length ? `<details style="margin-top:10px"><summary class="small">Fully recovered (${list.length - open.length})</summary><div class="list">${list.filter((a) => +a.recovered >= +a.amount).map(row).join("")}</div></details>` : ""}</div>`;
}
function advanceForm(staffId) {
  const staff = (S.d.staff || []).filter((s) => s.active), next = ymShift(S.d.ym, 1);
  formModal({ title: "Give an advance", submitLabel: "Save advance", values: { staff_id: staffId || staff[0]?.id, given_on: todayIST(), start: S.d.ym, paid_from: "cash" },
    fields: [{ key: "staff_id", label: "Staff", type: "select", options: staff.map((s) => [s.id, s.name]), full: true },
      { key: "amount", label: "Advance amount ₹", type: "number", required: true, min: 1 }, { key: "monthly_cut", label: "Cut from salary each month ₹", type: "number", required: true, min: 1 },
      { key: "given_on", label: "Given on", type: "date", required: true }, { key: "start", label: "Start cutting from", type: "select", options: [[S.d.ym, ymLabel(S.d.ym) + " salary"], [next, ymLabel(next) + " salary"]] },
      { key: "paid_from", label: "Paid from", type: "select", options: [["cash", "Cash"], ["bank", "Bank / UPI"]] }, { key: "note", label: "Note", placeholder: "e.g. medical, festival" }],
    onSave: async (v) => { if (!(v.amount > 0) || !(v.monthly_cut > 0)) throw new Error("Enter the amount and the monthly cut");
      await q(sb.rpc("advance_give", { p_business: ctx().BID, p: { staff_id: v.staff_id, amount: v.amount, monthly_cut: v.monthly_cut, given_on: v.given_on, start_month: v.start + "-01", paid_from: v.paid_from, note: v.note } }));
      toast(`Advance saved. ${inr(Math.min(v.monthly_cut, v.amount))} will be cut each month.`); await load(); drawSalary(); } });
}
function adjForm(s) {
  formModal({ title: `Bonus or one-time cut · ${s.name}`, submitLabel: "Add", values: { kind: "bonus" },
    fields: [{ key: "kind", label: "Type", type: "select", options: [["bonus", "Bonus"], ["allowance", "Allowance (travel, food…)"], ["deduction", "Deduction (fine, damage, loan EMI…)"], ["advance", "One-time advance, cut fully this month"]] },
      { key: "amount", label: "Amount ₹", type: "number", required: true, min: 1 }, { key: "note", label: "Note", full: true, placeholder: "Diwali bonus, advance on 5th…" }],
    onSave: async (v) => { if (!(v.amount > 0)) throw new Error("Enter an amount"); await q(sb.from("salary_adjustments").insert({ business_id: ctx().BID, staff_id: s.id, month: S.d.ym + "-01", kind: v.kind, amount: v.amount, note: v.note }));
      toast("Added to " + ymLabel(S.d.ym)); await load(); drawSalary(); } });
}
function slipHTML(s, c) {
  const biz = ctx().D.biz;
  return `<div style="font-family:system-ui,sans-serif;max-width:720px;margin:0 auto"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px"><div><h2 style="margin:0">${esc(biz.name)}</h2><div style="color:#666">${esc(biz.city || "")}</div></div>
    <div style="text-align:right"><b>Salary slip</b><div>${ymLabel(S.d.ym)}</div></div></div><hr>
    <table><tr><td><b>${esc(s.name)}</b><br>${esc(s.designation || "")}</td><td>${inr(s.pay_rate)} ${PAY[s.pay_type]}<br>Shift ${shiftTxt(s)}</td>
      <td>Present ${c.counts.P} · Half ${c.counts.H} · Absent ${c.counts.A + c.counts.UL}<br>Leave ${c.counts.L} · Off ${c.counts.WO} · Holidays ${c.counts.HO} · Late ${c.lateCount}</td></tr></table>
    <h3 style="margin:18px 0 6px">Calculation</h3><table>${c.lines.map((l) => `<tr><td>${esc(l.label.replace(/× ([\d.]+)/g, (m, n) => "× ₹" + n))}</td><td style="text-align:right;white-space:nowrap">${l.amount < 0 ? "−" : ""}${inr2(Math.abs(l.amount))}</td></tr>`).join("")}
      <tr><td><b>Net pay</b></td><td style="text-align:right"><b>${inr2(c.net)}</b></td></tr></table>
    <p style="color:#666;font-size:12px;margin-top:14px">Day rate ${inr2(c.dayRate)} · hourly ${inr2(c.hourRate)} · ${c.expectedHours} h shift${c.inProgress ? " · month still running" : ""}</p>
    <div style="display:flex;justify-content:space-between;margin-top:48px;font-size:13px"><span>Employer signature</span><span>Employee signature</span></div></div>`;
}
function payslip(s) {
  const c = monthCalc(s);
  const m = openModal(`<div class="modal-head"><h2>Payslip · ${esc(s.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <div class="list">${c.lines.map((l) => `<div class="item"><div class="grow">${esc(l.label.replace(/× ([\d.]+)/g, (mm, n) => "× ₹" + n))}</div><b class="num" style="color:${l.amount < 0 ? "var(--bad)" : "inherit"}">${l.amount < 0 ? "−" : ""}${inr2(Math.abs(l.amount))}</b>${l.adjustmentId ? `<button class="btn sm ghost" data-st="adj-del" data-id="${l.adjustmentId}">Remove</button>` : ""}</div>`).join("")}
      <div class="item"><div class="grow"><b>Net pay</b></div><b class="num" style="font-size:20px">${inr2(c.net)}</b></div></div>
    <div class="reg-strip">${c.days.map((d) => `<span class="cc cc-${d.code}" title="${d.date}: ${CODES[d.code]}${d.late ? ", late " + d.late + " min" : ""}">${+d.date.slice(8)}<br>${SHORT[d.code] || "&nbsp;"}</span>`).join("")}</div>
    <div class="modal-foot"><button class="btn" data-close>Close</button><button class="btn primary" id="slip-print">Print payslip</button></div>`, { wide: true });
  m.querySelector("#slip-print").onclick = () => printHTML(slipHTML(s, c), `Payslip ${s.name}`);
}
function paidForm(s) {
  const c = monthCalc(s);
  formModal({ title: `Mark paid · ${s.name}`, submitLabel: `Mark ${inr2(c.net)} as paid`, values: { paid_on: todayIST(), paid_mode: "UPI" },
    fields: [{ key: "paid_on", label: "Paid on", type: "date", required: true }, { key: "paid_mode", label: "Paid by", type: "select", options: ["UPI", "Cash", "Bank transfer", "Cheque"] }],
    onSave: async (v) => { const { days, ...data } = c; await q(sb.from("salary_slips").upsert({ business_id: ctx().BID, staff_id: s.id, month: S.d.ym + "-01", data: { ...data, codes: days.map((d) => d.code) }, net: c.net, paid: true, paid_on: v.paid_on, paid_mode: v.paid_mode }, { onConflict: "staff_id,month" }));
      toast("Marked as paid"); await load(); drawSalary(); } });
}
export async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"; sc.onload = res; sc.onerror = () => rej(new Error("Couldn't load the Excel tool. Check your internet, or use CSV.")); document.head.appendChild(sc); });
  return window.XLSX;
}
export function downloadCSV(rows, name) {
  const csv = rows.map((r) => r.map((v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function exportSalary(kind) {
  const head = ["Name", "Role", "Pay type", "Rate", "Present", "Half days", "Absent", "Paid leave", "Unpaid leave", "Weekly off", "Holidays", "Late marks", "Late cut", "OT hours", "OT pay", "Additions", "Deductions", "Net pay", "Paid on", "Paid by"];
  const rows = (S.d.staff || []).filter((s) => s.active || S.d.att.some((r) => r.staff_id === s.id)).map((s) => {
    const c = monthCalc(s), slip = S.d.slips.find((x) => x.staff_id === s.id && x.paid);
    const adds = c.lines.filter((l) => l.adjustmentId && l.amount > 0).reduce((t, l) => t + l.amount, 0), cuts = c.lines.filter((l) => l.adjustmentId && l.amount < 0).reduce((t, l) => t - l.amount, 0);
    return [s.name, s.designation, s.pay_type, +s.pay_rate, c.counts.P, c.counts.H, c.counts.A, c.counts.L, c.counts.UL, c.counts.WO, c.counts.HO, c.lateCount, c.latePenalty, c.otHours, c.otPay, adds, cuts, c.net, slip?.paid_on || "", slip?.paid_mode || ""];
  });
  const name = `Salary ${ymLabel(S.d.ym)}`;
  if (kind === "csv") return downloadCSV([head, ...rows], name + ".csv");
  const X = await loadXLSX(); const ws = X.utils.aoa_to_sheet([head, ...rows]); ws["!cols"] = head.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, "Salary"); X.writeFile(wb, name + ".xlsx");
}

/* =================== register with the portal =================== */
export function registerStaff(api) {
  A = api;
  api.VIEWS.staff = () => `<div id="st-view"><div class="loading"><span class="spinner"></span></div></div>`;
  api.after.staff = async () => { const want = S.tab === "today" ? ymNow() : S.ym || ymNow(); S.ym = want; try { await load(want); drawStaff(); } catch (e) { $("#st-view").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; } };
  api.VIEWS.salary = () => `<div id="sal-view"><div class="loading"><span class="spinner"></span></div></div>`;
  api.after.salary = async () => { S.ym = S.ym || ymNow(); try { await load(S.ym); drawSalary(); } catch (e) { $("#sal-view").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; } };
}
