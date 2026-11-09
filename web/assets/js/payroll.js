// Salary engine. Pure functions (no DOM, no network) so the same rules run in the portal and in tests.
// Times are Indian Standard Time (UTC+5:30, no daylight saving).

export const DEFAULT_SETTINGS = {
  grace_minutes: 10, late_allowed: 3, late_rule: "half_day_per", late_rule_value: 3,
  count_early_leave: true, early_grace_minutes: 10,
  half_day_below_hours: 6, absent_below_hours: 3, deduction_basis: "day",
  month_days: "calendar", fixed_days: 30, paid_leaves: 1, absent_uses_leave: true,
  paid_weekly_off: true, paid_holidays: true, sandwich_rule: false, offday_work_pay: true,
  overtime_on: false, overtime_after_min: 30, overtime_multiplier: 1, missed_checkout: "full",
};

export const CODES = {
  P: "Present", H: "Half day", A: "Absent", L: "Paid leave", PL: "Paid leave", UL: "Unpaid leave",
  WO: "Weekly off", HO: "Holiday", NJ: "Not joined yet", F: "Upcoming",
};

const IST_MIN = 330;
export function ist(iso) {
  const d = new Date(new Date(iso).getTime() + IST_MIN * 6e4);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
export const todayIST = () => ist(new Date().toISOString()).date;
const tmin = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const r2 = (n) => Math.round((+n + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");

export function monthDates(year, month) { // month: 1–12
  const n = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`);
}
const dow = (date) => new Date(date + "T00:00:00Z").getUTCDay();

export function shiftMinutes(staff) {
  let s = tmin(staff.shift_start), e = tmin(staff.shift_end);
  if (e <= s) e += 1440; // night shift
  return { start: s, end: e, expected: Math.max(30, e - s - (+staff.break_minutes || 0)) };
}

/* One day for one staff member → { code, worked, late, early, ot, … } */
export function classifyDay(st, staff, rec, { date, today, isOff, isHol }) {
  const sh = shiftMinutes(staff);
  const base = { date, code: "A", worked: 0, late: 0, early: 0, ot: 0, short: 0, inTime: null, outTime: null, note: rec?.note || "", override: false, missedOut: false, inProgress: false, offWork: false };
  if (date > today) return { ...base, code: "F" };
  if (staff.joined_on && date < staff.joined_on && !rec?.check_in && !rec?.mark) return { ...base, code: "NJ" };

  if (rec?.mark) {
    const map = { present: "P", half_day: "H", absent: "A", leave: "L", paid_leave: "PL", unpaid_leave: "UL", holiday: "HO", week_off: "WO" };
    const code = map[rec.mark] || "A";
    return { ...base, code, override: true, worked: code === "P" ? sh.expected : code === "H" ? sh.expected / 2 : 0, offWork: (isOff || isHol) && (code === "P" || code === "H") };
  }
  if (!rec?.check_in) {
    if (date === today && !isHol && !isOff) return { ...base, code: "F", pending: true }; // today, not checked in yet: not absent until the day is over
    return { ...base, code: isHol ? "HO" : isOff ? "WO" : "A" };
  }

  const tin = ist(rec.check_in); const out = rec.check_out ? ist(rec.check_out) : null;
  const d = { ...base, inTime: tin.min, outTime: out ? out.min : null, offWork: isOff || isHol };
  const lateRaw = tin.min - sh.start;
  d.late = lateRaw > (+st.grace_minutes || 0) ? lateRaw : 0;

  if (!out) {
    if (date === today) return { ...d, code: "P", inProgress: true };
    d.missedOut = true;
    if (st.missed_checkout === "absent") return { ...d, code: "A" };
    if (st.missed_checkout === "half") return { ...d, code: "H", worked: sh.expected / 2 };
    return { ...d, code: "P", worked: sh.expected };
  }
  const span = (new Date(rec.check_out) - new Date(rec.check_in)) / 6e4;
  const worked = Math.max(0, span - (span > (+staff.break_minutes || 0) * 2 ? (+staff.break_minutes || 0) : 0));
  d.worked = worked;
  const outMin = out.min + (out.date > tin.date ? 1440 : 0);
  const earlyRaw = sh.end - outMin;
  d.early = st.count_early_leave && earlyRaw > (+st.early_grace_minutes || 0) ? earlyRaw : 0;
  const extra = worked - sh.expected;
  d.ot = extra >= (+st.overtime_after_min || 0) && extra > 0 ? extra : 0;

  if (worked < (+st.absent_below_hours || 0) * 60) return { ...d, code: "A" };
  if (st.deduction_basis === "hour") return { ...d, code: "P", short: Math.max(0, sh.expected - worked) };
  if (worked < (+st.half_day_below_hours || 0) * 60) return { ...d, code: "H" };
  return { ...d, code: "P" };
}

/* Whole month for one staff member */
export function computeStaffMonth({ settings, staff, records = [], holidays = [], adjustments = [], year, month, today = todayIST() }) {
  const st = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const dates = monthDates(year, month);
  const hol = new Set(holidays.map((h) => (typeof h === "string" ? h : h.day)));
  const offs = new Set((staff.weekly_off || []).map(Number));
  const byDay = Object.fromEntries(records.filter((r) => r.staff_id === staff.id).map((r) => [r.day, r]));
  const sh = shiftMinutes(staff);

  const days = dates.map((date) => classifyDay(st, staff, byDay[date], { date, today, isOff: offs.has(dow(date)), isHol: hol.has(date) }));

  // Sandwich rule: a weekly off / holiday between two unpaid working days counts as absent
  if (st.sandwich_rule) {
    const unpaid = (c) => c === "A" || c === "UL";
    days.forEach((d, i) => {
      if (d.override || !(d.code === "WO" || d.code === "HO")) return;
      let p = i - 1; while (p >= 0 && (days[p].code === "WO" || days[p].code === "HO")) p--;
      let n = i + 1; while (n < days.length && (days[n].code === "WO" || days[n].code === "HO")) n++;
      if (p >= 0 && n < days.length && unpaid(days[p].code) && unpaid(days[n].code)) { d.code = "A"; d.sandwich = true; }
    });
  }
  // Paid leave allowance: marked leaves first, then (optionally) absences
  let quota = +st.paid_leaves || 0;
  days.forEach((d) => { if (d.code === "L") { if (quota >= 1) quota -= 1; else d.code = "UL"; } });
  if (st.absent_uses_leave) days.forEach((d) => { if (d.code === "A" && !d.sandwich && quota >= 1) { d.code = "L"; d.coveredAbsence = true; quota -= 1; } });

  const count = (c) => days.filter((d) => d.code === c).length;
  const c = { P: count("P"), H: count("H"), A: count("A"), L: count("L") + count("PL"), UL: count("UL"), WO: count("WO"), HO: count("HO"), NJ: count("NJ"), F: count("F") };
  const offInMonth = dates.filter((d) => offs.has(dow(d))).length, holInMonth = dates.filter((d) => hol.has(d) && !offs.has(dow(d))).length;
  const offdayWorked = days.filter((d) => d.offWork && (d.code === "P" || d.code === "H")).reduce((s, d) => s + (d.code === "H" ? 0.5 : 1), 0);

  const lateDays = days.filter((d) => !d.override && (d.code === "P" || d.code === "H") && (d.late > 0 || d.early > 0));
  const excess = lateDays.slice(+st.late_allowed || 0);
  const otMin = st.overtime_on ? days.reduce((s, d) => s + (d.ot || 0), 0) : 0;
  const shortMin = st.deduction_basis === "hour" ? days.reduce((s, d) => s + (d.short || 0), 0) : 0;
  const workedMin = days.reduce((s, d) => s + (d.code === "P" || d.code === "H" ? (d.inProgress ? 0 : d.worked) : 0), 0);

  const rate = +staff.pay_rate || 0, type = staff.pay_type || "monthly";
  let basis = dates.length, dayRate = 0, hourRate = 0, gross = 0;
  const lines = [];
  if (type === "monthly") {
    basis = st.month_days === "fixed" ? +st.fixed_days : st.month_days === "working" ? Math.max(1, dates.length - offInMonth - holInMonth) : dates.length;
    dayRate = rate / basis; hourRate = dayRate / (sh.expected / 60); gross = rate;
    lines.push({ label: "Monthly salary", amount: rate });
    const working = st.month_days === "working";
    const unpaid = [["A", c.A, "absent"], ["UL", c.UL, "unpaid leave"], ["NJ", c.NJ, "before joining"]];
    if (!working && !st.paid_weekly_off) unpaid.push(["WO", c.WO, "weekly off (unpaid)"]);
    if (!working && !st.paid_holidays) unpaid.push(["HO", c.HO, "holiday (unpaid)"]);
    for (const [, n, label] of unpaid) if (n) lines.push({ label: `${n} day${n > 1 ? "s" : ""} ${label} × ${r2(dayRate)}`, amount: -n * dayRate });
    if (c.H) lines.push({ label: `${c.H} half day${c.H > 1 ? "s" : ""} × ${r2(dayRate / 2)}`, amount: -c.H * dayRate / 2 });
    if (st.offday_work_pay && offdayWorked) lines.push({ label: `Worked on ${offdayWorked} off day${offdayWorked !== 1 ? "s" : ""}/holiday × ${r2(dayRate)}`, amount: offdayWorked * dayRate });
  } else if (type === "daily") {
    dayRate = rate; hourRate = rate / (sh.expected / 60);
    const paidDays = c.P + c.H * 0.5 + c.L;
    gross = paidDays * rate;
    lines.push({ label: `${paidDays} paid day${paidDays !== 1 ? "s" : ""} × ${r2(rate)}`, amount: gross });
  } else {
    hourRate = rate; dayRate = rate * sh.expected / 60;
    const hrs = workedMin / 60 + c.L * sh.expected / 60;
    gross = hrs * rate;
    lines.push({ label: `${r2(hrs)} hours × ${r2(rate)}`, amount: gross });
  }

  let latePenalty = 0, lateNote = "";
  if (type !== "hourly" && st.deduction_basis === "day" && excess.length && st.late_rule !== "none") {
    const N = Math.max(1, +st.late_rule_value || 1);
    if (st.late_rule === "half_day_per") { const k = Math.floor(excess.length / N); latePenalty = k * 0.5 * dayRate; lateNote = `${k} half-day cut${k !== 1 ? "s" : ""} (every ${N} extra late)`; }
    if (st.late_rule === "full_day_per") { const k = Math.floor(excess.length / N); latePenalty = k * dayRate; lateNote = `${k} day cut${k !== 1 ? "s" : ""} (every ${N} extra late)`; }
    if (st.late_rule === "fixed_per_late") { latePenalty = excess.length * (+st.late_rule_value || 0); lateNote = `${excess.length} × ${r2(+st.late_rule_value)}`; }
    if (st.late_rule === "per_minute") { const m = excess.reduce((s, d) => s + d.late + d.early, 0); latePenalty = (m * hourRate / 60) * (+st.late_rule_value || 1); lateNote = `${m} min × ${r2(hourRate / 60)}/min${+st.late_rule_value !== 1 ? ` × ${st.late_rule_value}` : ""}`; }
    if (latePenalty) lines.push({ label: `Late/early: ${lateDays.length} marks, ${+st.late_allowed} allowed → ${lateNote}`, amount: -latePenalty });
  }
  let shortCut = 0;
  if (type !== "hourly" && shortMin > 0) { shortCut = (shortMin / 60) * hourRate; lines.push({ label: `Short hours: ${r2(shortMin / 60)} h × ${r2(hourRate)}`, amount: -shortCut }); }
  let otPay = 0;
  if (otMin > 0) {
    const mult = +st.overtime_multiplier || 1;
    otPay = (otMin / 60) * hourRate * (type === "hourly" ? mult - 1 : mult);
    if (otPay) lines.push({ label: `Overtime: ${r2(otMin / 60)} h × ${r2(hourRate)}${mult !== 1 ? ` × ${mult}` : ""}${type === "hourly" ? " (extra over normal rate)" : ""}`, amount: otPay });
  }
  for (const a of adjustments.filter((a) => a.staff_id === staff.id)) {
    const sign = a.kind === "bonus" || a.kind === "allowance" ? 1 : -1;
    lines.push({ label: `${a.kind[0].toUpperCase() + a.kind.slice(1)}${a.note ? ": " + a.note : ""}`, amount: sign * +a.amount, adjustmentId: a.id });
  }
  lines.forEach((l) => (l.amount = r2(l.amount)));
  const net = r2(lines.reduce((s, l) => s + l.amount, 0));
  return {
    staffId: staff.id, name: staff.name, payType: type, rate, basis, dayRate: r2(dayRate), hourRate: r2(hourRate), expectedHours: r2(sh.expected / 60),
    days, counts: c, lateCount: lateDays.length, lateAllowed: +st.late_allowed, latePenalty: r2(latePenalty), otHours: r2(otMin / 60), otPay: r2(otPay),
    shortHours: r2(shortMin / 60), workedHours: r2(workedMin / 60), offdayWorked, lines, net, inProgress: dates.some((d) => d >= today),
  };
}

export function computePayroll({ settings, staff, records, holidays, adjustments, year, month, today }) {
  return staff.map((s) => computeStaffMonth({ settings, staff: s, records, holidays, adjustments, year, month, today }));
}
