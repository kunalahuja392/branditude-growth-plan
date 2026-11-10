// Business portal: Accounts & GST (#accounts).
// Owners record income and expenses in plain words; underneath every entry is a balanced double entry,
// so the P&L, balance sheet, GST summary and trial balance always agree, and the books export to Tally.
import { sb, q } from "./sb.js";
import { $, $$, esc, inr, inr2, toast, openModal, closeModal, confirmBox, fmtDate, hbars } from "./ui.js";
import { downloadCSV } from "./staff.js";

let A;
const S = { tab: "overview", period: "fy", from: null, to: null, heads: [], bal: [], vouchers: [], q: "", f: "all", ready: false };
const ctx = () => A.ctx();
const BID = () => ctx().BID;
const can = () => ctx().canWrite;

/* ---------- categories: kinds, classes and their Tally groups ---------- */
export const CLASSES = {
  income: [["sales", "Sales of goods or services"], ["other_income", "Other income (interest, rent received, commission)"]],
  expense: [["operating", "Regular running expense (rent, bills, salaries)"], ["purchase", "Stock & raw material bought for sale"], ["direct", "Direct cost of what you sell (packing, delivery, job work)"],
    ["finance", "Interest & bank charges"], ["depreciation", "Depreciation (wear and tear of assets)"]],
  asset: [["fixed", "Long-term asset (furniture, equipment, vehicle)"], ["cash", "Cash"], ["bank", "Bank / UPI account"], ["receivable", "Money people owe you"],
    ["advance", "Advances given"], ["deposit", "Deposits (rent deposit, security)"], ["stock", "Stock in hand"], ["investment", "Investments (FD, shares)"]],
  liability: [["loan", "Loan taken"], ["payable", "Money you owe suppliers"], ["tax", "Taxes (GST)"], ["other_liability", "Other dues"]],
  equity: [["capital", "Owner's money put in"], ["drawings", "Owner's money taken out"]],
};
const KIND = { income: "Income", expense: "Expense", asset: "Asset", liability: "Liability", equity: "Owner's equity" };
const TALLY = { sales: "Sales Accounts", other_income: "Indirect Incomes", purchase: "Purchase Accounts", direct: "Direct Expenses", operating: "Indirect Expenses", finance: "Indirect Expenses",
  depreciation: "Indirect Expenses", fixed: "Fixed Assets", cash: "Cash-in-Hand", bank: "Bank Accounts", receivable: "Sundry Debtors", advance: "Loans & Advances (Asset)", deposit: "Deposits (Asset)",
  stock: "Stock-in-Hand", investment: "Investments", loan: "Loans (Liability)", payable: "Sundry Creditors", tax: "Duties & Taxes", other_liability: "Current Liabilities", capital: "Capital Account", drawings: "Capital Account" };
const classLabel = (k, c) => (CLASSES[k]?.find((x) => x[0] === c) || [, c])[1];
const RATES = [0, 3, 5, 12, 18, 28, 40];

// Entry types an owner chooses from
const ENTRIES = {
  income: { t: "Money in: sale or income", head: (h) => h.kind === "income", money: "in", gst: true, verb: "Received in" },
  expense: { t: "Money out: expense or purchase", head: (h) => h.kind === "expense", money: "out", gst: true, verb: "Paid from" },
  asset: { t: "Bought an asset", sub: "furniture, equipment, deposit", head: (h) => h.kind === "asset" && !["cash", "bank", "receivable"].includes(h.class), money: "out", gst: true, verb: "Paid from" },
  capital_in: { t: "Owner put money in", head: (h) => h.class === "capital", money: "in", verb: "Received in" },
  drawings: { t: "Owner took money out", head: (h) => h.class === "drawings", money: "out", verb: "Paid from" },
  loan_in: { t: "Took a loan", head: (h) => h.kind === "liability" && h.class === "loan", money: "in", verb: "Received in" },
  loan_out: { t: "Repaid a loan", head: (h) => h.kind === "liability" && h.class === "loan", money: "out", verb: "Paid from" },
  transfer: { t: "Moved money / settled dues", sub: "customer paid, paid a supplier, cash to bank", head: (h) => ["cash", "bank", "payable"].includes(h.class), money: "any", verb: "From", headLabel: "To" },
  opening: { t: "Opening balance", sub: "what you had when you started using this", head: (h) => !["income", "expense", "equity"].includes(h.kind) && h.class !== "tax", money: "none" },
};
const ENTRY_LABEL = { income: "Income", expense: "Expense", asset: "Asset bought", capital_in: "Capital in", drawings: "Drawings", loan_in: "Loan taken", loan_out: "Loan repaid",
  transfer: "Transfer", opening: "Opening balance", salary: "Salary", advance: "Staff advance" };
const SOURCE = { visits: "From visits", salary: "From salary", advance: "From advances" };

/* ---------- periods (Indian financial year Apr–Mar) ---------- */
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
function periodRange(p) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), fyStart = m >= 3 ? y : y - 1;
  const q0 = Math.floor(((m + 9) % 12) / 3), qStartMonth = (q0 * 3 + 3) % 12, qStartYear = qStartMonth > m ? y - 1 : y;
  switch (p) {
    case "month": return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case "lastmonth": return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case "quarter": return [iso(new Date(qStartYear, qStartMonth, 1)), iso(new Date(qStartYear, qStartMonth + 3, 0))];
    case "lastfy": return [`${fyStart - 1}-04-01`, `${fyStart}-03-31`];
    case "custom": return [S.from, S.to];
    default: return [`${fyStart}-04-01`, `${fyStart + 1}-03-31`];
  }
}
const PERIODS = [["month", "This month"], ["lastmonth", "Last month"], ["quarter", "This quarter"], ["fy", "This financial year"], ["lastfy", "Last financial year"], ["custom", "Custom dates"]];
const periodText = () => `${fmtDate(S.from)} – ${fmtDate(S.to)}`;

/* ---------- data ---------- */
async function load() {
  [S.from, S.to] = periodRange(S.period);
  if (!S.ready) { if (can()) await q(sb.rpc("acc_setup", { p_business: BID() })).catch(() => {}); S.ready = true; }
  const [heads, bal, vouchers] = await Promise.all([
    q(sb.from("acc_heads").select("*").eq("business_id", BID()).order("sort").order("name")),
    q(sb.rpc("acc_balances", { p_business: BID(), p_from: S.from, p_to: S.to })),
    q(sb.from("acc_vouchers").select("*").eq("business_id", BID()).gte("vdate", S.from).lte("vdate", S.to).order("vdate", { ascending: false }).order("created_at", { ascending: false }).limit(5000)),
  ]);
  Object.assign(S, { heads, bal, vouchers });
}
const H = (id) => S.heads.find((h) => h.id === id);
const sys = (k) => S.heads.find((h) => h.system_key === k);
const money = () => S.heads.filter((h) => h.active && ["cash", "bank"].includes(h.class));
const B = (id) => S.bal.find((b) => b.id === id) || { p_dr: 0, p_cr: 0, c_dr: 0, c_cr: 0, o_dr: 0, o_cr: 0 };
// natural-side amounts
const per = (b) => (["income", "liability", "equity"].includes(b.kind) ? +b.p_cr - +b.p_dr : +b.p_dr - +b.p_cr);
const clo = (b) => (["income", "liability", "equity"].includes(b.kind) ? +b.c_cr - +b.c_dr : +b.c_dr - +b.c_cr);
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const r2 = (n) => Math.round(n * 100) / 100;

/* ---------- statements ---------- */
function pnl() {
  const rows = (cls) => S.bal.filter((b) => cls.includes(b.class) && Math.abs(per(b)) >= 0.005).map((b) => ({ id: b.id, name: b.name, v: per(b) }));
  const sales = rows(["sales"]), other = rows(["other_income"]), cogs = rows(["purchase", "direct"]), opex = rows(["operating"]), fin = rows(["finance", "depreciation"]);
  const t = (r) => sum(r, (x) => x.v);
  const revenue = t(sales), gross = revenue - t(cogs), net = gross + t(other) - t(opex) - t(fin);
  return { sales, other, cogs, opex, fin, revenue, gross, net, totalIncome: revenue + t(other), totalExp: t(cogs) + t(opex) + t(fin) };
}
function sheet() {
  const nz = (b) => Math.abs(clo(b)) >= 0.005;
  const assets = S.bal.filter((b) => b.kind === "asset" && nz(b)).map((b) => ({ id: b.id, name: b.name, cls: b.class, v: clo(b) }));
  const taxNet = sum(S.bal.filter((b) => b.class === "tax"), clo);       // + = GST payable, − = GST credit
  const liabs = S.bal.filter((b) => b.kind === "liability" && b.class !== "tax" && nz(b)).map((b) => ({ id: b.id, name: b.name, cls: b.class, v: clo(b) }));
  if (taxNet < -0.005) assets.push({ name: "GST credit to claim", cls: "tax", v: -taxNet, tax: true }); else if (taxNet > 0.005) liabs.push({ name: "GST payable", cls: "tax", v: taxNet, tax: true });
  const capital = sum(S.bal.filter((b) => b.class === "capital"), clo), drawings = -sum(S.bal.filter((b) => b.class === "drawings"), clo);
  const profitToDate = sum(S.bal.filter((b) => b.kind === "income"), clo) - sum(S.bal.filter((b) => b.kind === "expense"), clo);
  const ta = sum(assets, (x) => x.v), tl = sum(liabs, (x) => x.v), te = capital - drawings + profitToDate;
  return { assets, liabs, capital, drawings, profitToDate, ta, tl, te, balanced: Math.abs(ta - tl - te) < 0.01 };
}
function gst() {
  const out = {}, inp = {}, b2b = [];
  for (const v of S.vouchers) {
    if (!(+v.gst > 0)) continue;
    const side = v.entry === "income" ? out : ["expense", "asset"].includes(v.entry) ? inp : null; if (!side) continue;
    const k = `${+v.gst_rate}`; side[k] = side[k] || { rate: +v.gst_rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, n: 0 };
    const r = side[k]; r.taxable += +v.taxable; r.n++;
    if (v.igst) r.igst += +v.gst; else { const h = r2(+v.gst / 2); r.cgst += h; r.sgst += +v.gst - h; }
    if (v.entry === "income" && v.gstin) b2b.push(v);
  }
  const zeroOut = sum(S.vouchers.filter((v) => v.entry === "income" && !(+v.gst > 0)), (v) => +v.taxable);
  const tot = (o) => Object.values(o).reduce((t, r) => ({ taxable: t.taxable + r.taxable, cgst: t.cgst + r.cgst, sgst: t.sgst + r.sgst, igst: t.igst + r.igst }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
  const O = tot(out), I = tot(inp);
  return { out: Object.values(out).sort((a, b) => a.rate - b.rate), inp: Object.values(inp).sort((a, b) => a.rate - b.rate), O, I, b2b, zeroOut,
    net: { cgst: O.cgst - I.cgst, sgst: O.sgst - I.sgst, igst: O.igst - I.igst, all: O.cgst + O.sgst + O.igst - I.cgst - I.sgst - I.igst } };
}

/* ---------- UI ---------- */
const TABS = [["overview", "Overview"], ["entries", "Entries"], ["pnl", "Profit & loss"], ["bs", "Balance sheet"], ["gst", "GST"], ["tb", "Trial balance"], ["heads", "Categories"], ["export", "Export & Tally"]];
const amt = (n, cls = "") => `<td class="num ${cls}" style="text-align:right;white-space:nowrap">${n < 0 ? "−" : ""}${inr2(Math.abs(n))}</td>`;
const link = (id, name) => (id ? `<a href="#accounts" data-ac="ledger" data-id="${id}">${esc(name)}</a>` : esc(name));

function draw() {
  const el = $("#acc-view"); if (!el) return;
  const actions = can() ? `<button class="btn primary" data-ac="new" data-id="income">+ Money in</button><button class="btn primary" data-ac="new" data-id="expense">− Money out</button><button class="btn" data-ac="more">More entries</button>` : "";
  el.innerHTML = A.head("Accounts & GST", "Add what comes in and goes out. Profit & loss, balance sheet and GST reports build themselves, and you can send everything to your CA or Tally.", actions) + `
    <div class="row acc-bar" style="margin-bottom:12px;gap:8px;flex-wrap:wrap">
      <select id="ac-period" aria-label="Period" style="width:auto">${PERIODS.map(([k, l]) => `<option value="${k}" ${S.period === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      ${S.period === "custom" ? `<input type="date" id="ac-from" value="${S.from}" aria-label="From" style="width:auto"><input type="date" id="ac-to" value="${S.to}" aria-label="To" style="width:auto">` : `<span class="muted small">${periodText()}</span>`}
    </div>
    <div class="chips acc-tabs" role="tablist" style="margin-bottom:16px">${TABS.map(([k, l]) => `<button class="chip" role="tab" data-ac="tab" data-id="${k}" aria-pressed="${S.tab === k}">${l}</button>`).join("")}</div>
    <div id="ac-body">${VIEW[S.tab]()}</div>`;
}
const VIEW = {
  overview() {
    const P = pnl(), sh = sheet(), cash = sum(S.bal.filter((b) => ["cash", "bank"].includes(b.class)), clo), G = gst();
    const owed = sum(S.bal.filter((b) => b.class === "receivable"), clo), owe = sum(S.bal.filter((b) => b.class === "payable"), clo);
    const exp = S.bal.filter((b) => b.kind === "expense" && per(b) > 0).map((b) => ({ label: b.name, value: per(b) })).sort((a, b) => b.value - a.value).slice(0, 8);
    const recent = S.vouchers.slice(0, 8);
    return `<div class="grid g4">${A.kpi("Income", inr(P.totalIncome), "this period")}${A.kpi("Expenses", inr(P.totalExp), "this period")}
      ${A.kpi(P.net >= 0 ? "Profit" : "Loss", `<span style="color:${P.net >= 0 ? "var(--good)" : "var(--bad)"}">${inr(Math.abs(P.net))}</span>`, P.revenue && Math.abs(P.net) <= P.revenue ? `${Math.round((P.net / P.revenue) * 100)}% margin on sales` : "this period")}
      ${A.kpi("Cash + bank now", inr(cash), `${owed > 0 ? inr(owed) + " owed to you" : ""}${owed > 0 && owe > 0 ? " · " : ""}${owe > 0 ? inr(owe) + " you owe" : ""}`)}</div>
      <div class="grid g2" style="margin-top:16px">
        <div class="card"><div class="card-head"><h2>Where the money went</h2></div>${exp.length ? hbars(exp, inr) : `<div class="empty">No expenses in this period yet.</div>`}</div>
        <div class="card"><div class="card-head"><h2>GST this period</h2><button class="btn sm ghost" data-ac="tab" data-id="gst">Details</button></div>
          <div class="list"><div class="item"><div class="grow">GST on sales</div><b class="num">${inr2(G.O.cgst + G.O.sgst + G.O.igst)}</b></div>
          <div class="item"><div class="grow">GST paid on purchases (credit)</div><b class="num">${inr2(G.I.cgst + G.I.sgst + G.I.igst)}</b></div>
          <div class="item"><div class="grow"><b>${G.net.all >= 0 ? "To pay" : "Extra credit"}</b></div><b class="num">${inr2(Math.abs(G.net.all))}</b></div></div></div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Latest entries</h2><button class="btn sm ghost" data-ac="tab" data-id="entries">See all</button></div>
        ${recent.length ? `<div class="list">${recent.map(vRow).join("")}</div>` : `<div class="empty">Nothing here yet. Start with <b>Money in</b> or <b>Money out</b>, or bring in sales from your logged visits under <i>Entries</i>.</div>`}</div>
      ${!sh.balanced ? `<div class="banner" style="margin-top:16px"><p>The balance sheet is off by ${inr2(sh.ta - sh.tl - sh.te)}. Contact Branditude.</p></div>` : ""}`;
  },
  entries() {
    const qv = S.q.trim().toLowerCase();
    const list = S.vouchers.filter((v) => (S.f === "all" || (S.f === "in" ? v.entry === "income" : S.f === "out" ? ["expense", "asset", "salary", "advance"].includes(v.entry) : S.f === "auto" ? v.source !== "manual" : true))
      && (!qv || [H(v.head_id)?.name, H(v.money_id)?.name, v.party, v.narration, v.invoice_no, ENTRY_LABEL[v.entry]].join(" ").toLowerCase().includes(qv)));
    return `<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px"><input type="search" id="ac-q" placeholder="Search category, party, note" value="${esc(S.q)}" style="flex:1;min-width:200px">
      <select id="ac-f" style="width:auto">${[["all", "All entries"], ["in", "Money in"], ["out", "Money out"], ["auto", "Added automatically"]].map(([k, l]) => `<option value="${k}" ${S.f === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      ${can() ? `<button class="btn" data-ac="import-visits">Bring in sales from visits</button>${A.can("attendance") ? `<button class="btn" data-ac="import-salary">Bring in paid salaries</button>` : ""}` : ""}</div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Entry</th><th>Category</th><th>Paid / received</th><th style="text-align:right">GST</th><th style="text-align:right">Total</th><th></th></tr></thead><tbody>
      ${list.length ? list.slice(0, 800).map((v) => `<tr><td style="white-space:nowrap">${fmtDate(v.vdate)}<br><span class="muted small">${esc(v.vtype)} #${v.number}</span></td>
        <td>${esc(ENTRY_LABEL[v.entry])}${v.source !== "manual" ? `<br><span class="pill info">${SOURCE[v.source] || v.source}</span>` : ""}${v.party ? `<br><span class="small">${esc(v.party)}</span>` : ""}</td>
        <td>${link(v.head_id, H(v.head_id)?.name || "")}${v.narration ? `<br><span class="muted small">${esc(v.narration)}</span>` : ""}</td><td>${link(v.money_id, H(v.money_id)?.name || (v.entry === "opening" ? "Opening" : ""))}</td>
        ${amt(+v.gst)}${amt(+v.total)}<td style="text-align:right;white-space:nowrap">${can() && v.source === "manual" ? `<button class="btn sm ghost" data-ac="edit" data-id="${v.id}">Edit</button>` : ""}${can() && ["manual", "visits", "salary"].includes(v.source) ? `<button class="btn sm ghost danger" data-ac="del" data-id="${v.id}" aria-label="Delete">✕</button>` : ""}</td></tr>`).join("")
        : `<tr><td colspan="7"><div class="empty">No entries match.</div></td></tr>`}</tbody></table></div>`;
  },
  pnl() {
    const P = pnl(), sec = (title, rows) => rows.length ? `<tr class="sec"><td colspan="2"><b>${title}</b></td></tr>${rows.map((r) => `<tr><td style="padding-left:18px">${link(r.id, r.name)}</td>${amt(r.v)}</tr>`).join("")}` : "";
    return `<div class="card statement"><div class="card-head"><h2>Profit & loss · ${periodText()}</h2><button class="btn sm" data-ac="csv" data-id="pnl">Download CSV</button></div>
      <table>${sec("Sales", P.sales)}<tr class="tot"><td>Total sales</td>${amt(P.revenue)}</tr>
      ${sec("Less: stock, raw material & direct costs", P.cogs)}<tr class="tot"><td>Gross profit</td>${amt(P.gross)}</tr>
      ${sec("Add: other income", P.other)}${sec("Less: running expenses", P.opex)}${sec("Less: interest, bank charges & depreciation", P.fin)}
      <tr class="grand"><td>${P.net >= 0 ? "Net profit" : "Net loss"}</td>${amt(P.net)}</tr></table>
      <p class="small muted" style="margin-top:12px">Stock bought is counted as an expense when bought. If you keep a lot of unsold stock, ask your CA to adjust for closing stock at year end.</p></div>`;
  },
  bs() {
    const sh = sheet(), grp = (rows, kind) => Object.entries(rows.reduce((g, r) => ((g[r.cls] = g[r.cls] || []).push(r), g), {}))
      .map(([c, rs]) => `<tr class="sec"><td colspan="2"><b>${c === "tax" ? "GST" : esc(classLabel(kind, c))}</b></td></tr>${rs.map((r) => `<tr><td style="padding-left:18px">${link(r.id, r.name)}</td>${amt(r.v)}</tr>`).join("")}`).join("");
    return `<div class="card statement"><div class="card-head"><h2>Balance sheet · as on ${fmtDate(S.to)}</h2>${sh.balanced ? `<span class="pill good">✓ Balanced</span>` : `<span class="pill bad">Not balanced</span>`}<button class="btn sm" data-ac="csv" data-id="bs">Download CSV</button></div>
      <div class="grid g2"><table><tr class="head"><td colspan="2"><b>What the business owns</b></td></tr>${grp(sh.assets, "asset") || `<tr><td class="muted">Nothing yet</td><td></td></tr>`}<tr class="grand"><td>Total assets</td>${amt(sh.ta)}</tr></table>
      <table><tr class="head"><td colspan="2"><b>What the business owes</b></td></tr>${grp(sh.liabs, "liability") || `<tr><td class="muted">Nothing owed</td><td></td></tr>`}<tr class="tot"><td>Total owed</td>${amt(sh.tl)}</tr>
        <tr class="head"><td colspan="2"><b>Owner's equity</b></td></tr><tr><td style="padding-left:18px">Capital put in</td>${amt(sh.capital)}</tr><tr><td style="padding-left:18px">Less: taken out</td>${amt(-sh.drawings)}</tr>
        <tr><td style="padding-left:18px">Profit kept in the business (to date)</td>${amt(sh.profitToDate)}</tr><tr class="tot"><td>Total equity</td>${amt(sh.te)}</tr>
        <tr class="grand"><td>Total owed + equity</td>${amt(sh.tl + sh.te)}</tr></table></div></div>`;
  },
  gst() {
    const G = gst(), t = (rows, T) => `<table><thead><tr><th>Rate</th><th style="text-align:right">Taxable value</th><th style="text-align:right">CGST</th><th style="text-align:right">SGST</th><th style="text-align:right">IGST</th><th style="text-align:right">Total GST</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${r.rate}% <span class="muted small">(${r.n})</span></td>${amt(r.taxable)}${amt(r.cgst)}${amt(r.sgst)}${amt(r.igst)}${amt(r.cgst + r.sgst + r.igst)}</tr>`).join("") || `<tr><td colspan="6" class="muted">None in this period</td></tr>`}
      <tr class="tot"><td>Total</td>${amt(T.taxable)}${amt(T.cgst)}${amt(T.sgst)}${amt(T.igst)}${amt(T.cgst + T.sgst + T.igst)}</tr></tbody></table>`;
    return `<div class="grid g4" style="margin-bottom:16px">${A.kpi("GST on sales", inr2(G.O.cgst + G.O.sgst + G.O.igst), inr(G.O.taxable) + " taxable")}${A.kpi("Input credit", inr2(G.I.cgst + G.I.sgst + G.I.igst), inr(G.I.taxable) + " taxable")}
      ${A.kpi(G.net.all >= 0 ? "GST to pay" : "Credit carried forward", inr2(Math.abs(G.net.all)), `CGST ${inr2(G.net.cgst)} · SGST ${inr2(G.net.sgst)} · IGST ${inr2(G.net.igst)}`)}${A.kpi("Sales without GST", inr(G.zeroOut), "exempt / nil-rated / not registered")}</div>
      <div class="card"><div class="card-head"><h2>Outward supplies: sales (GSTR-1, GSTR-3B 3.1)</h2><button class="btn sm" data-ac="csv" data-id="gst">Download CSV</button></div><div class="table-wrap">${t(G.out, G.O)}</div></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>Input tax credit: purchases & expenses (GSTR-3B 4)</h2></div><div class="table-wrap">${t(G.inp, G.I)}</div>
        <p class="small muted" style="margin-top:8px">Claim credit only for bills that show in your GSTR-2B. Credit on some items (like food and personal use) isn't allowed.</p></div>
      <div class="card" style="margin-top:16px"><div class="card-head"><h2>B2B sales with GSTIN (GSTR-1 table 4)</h2><button class="btn sm" data-ac="csv" data-id="b2b">Download CSV</button></div>
        ${G.b2b.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>GSTIN</th><th>Rate</th><th style="text-align:right">Taxable</th><th style="text-align:right">GST</th></tr></thead><tbody>
        ${G.b2b.map((v) => `<tr><td>${fmtDate(v.vdate)}</td><td>${esc(v.invoice_no || "#" + v.number)}</td><td>${esc(v.party)}</td><td class="num">${esc(v.gstin)}</td><td>${+v.gst_rate}%${v.igst ? " IGST" : ""}</td>${amt(+v.taxable)}${amt(+v.gst)}</tr>`).join("")}</tbody></table></div>` : `<div class="empty">No sales with a customer GSTIN in this period.</div>`}</div>
      <p class="small muted" style="margin-top:12px">A summary to help you or your CA file returns. Check it against your sales and purchase bills before filing.</p>`;
  },
  tb() {
    const rows = S.bal.filter((b) => Math.abs(+b.c_dr - +b.c_cr) >= 0.005).map((b) => { const d = +b.c_dr - +b.c_cr; return { ...b, dr: d > 0 ? d : 0, cr: d < 0 ? -d : 0 }; });
    const dr = sum(rows, (r) => r.dr), cr = sum(rows, (r) => r.cr);
    return `<div class="card statement"><div class="card-head"><h2>Trial balance · as on ${fmtDate(S.to)}</h2>${Math.abs(dr - cr) < 0.01 ? `<span class="pill good">✓ Totals match</span>` : ""}<button class="btn sm" data-ac="csv" data-id="tb">Download CSV</button></div>
      <div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Tally group</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${link(r.id, r.name)}</td><td class="small">${KIND[r.kind]}</td><td class="small muted">${TALLY[r.class]}</td>${r.dr ? amt(r.dr) : "<td></td>"}${r.cr ? amt(r.cr) : "<td></td>"}</tr>`).join("") || `<tr><td colspan="5" class="muted">No entries yet</td></tr>`}
      <tr class="grand"><td colspan="3">Total</td>${amt(dr)}${amt(cr)}</tr></tbody></table></div></div>`;
  },
  heads() {
    return `<p class="muted" style="margin-bottom:12px">Every entry goes into a category. The type of each category decides where it shows: in profit & loss (income and expenses) or in the balance sheet (assets, loans, capital). Add your own, like <i>Swiggy commission</i> or <i>Generator diesel</i>.</p>
      ${can() ? `<button class="btn primary" data-ac="head-new" style="margin-bottom:14px">+ Add a category</button>` : ""}
      ${Object.keys(KIND).map((k) => { const hs = S.heads.filter((h) => h.kind === k); return `<div class="card" style="margin-bottom:14px"><div class="card-head"><h2>${KIND[k]}</h2></div><div class="list">
        ${hs.map((h) => `<div class="item"><div class="grow"><b>${esc(h.name)}</b>${h.active ? "" : ' <span class="pill">Hidden</span>'}<span class="muted small">${esc(classLabel(k, h.class))}${+h.gst_rate ? ` · usual GST ${+h.gst_rate}%` : ""} · Tally: ${TALLY[h.class]}</span></div>
          <span class="num small">${inr(clo(B(h.id)))}</span>${can() && h.class !== "tax" ? `<button class="btn sm ghost" data-ac="head-edit" data-id="${h.id}">Edit</button>` : ""}</div>`).join("")}</div></div>`; }).join("")}`;
  },
  export() {
    return `<div class="grid g2">
      <div class="card"><div class="card-head"><h2>Tally Prime / Tally ERP 9</h2></div>
        <p class="small">Two files for ${periodText()}. In Tally, open your company, then <b>Import → Masters</b> and pick the masters file, then <b>Import → Transactions</b> and pick the vouchers file.</p>
        <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn primary" data-ac="tally" data-id="masters">1. Download masters (ledgers)</button><button class="btn primary" data-ac="tally" data-id="vouchers">2. Download vouchers</button></div>
        <p class="small muted" style="margin-top:10px">Ledgers are created under Tally's standard groups (Sales Accounts, Indirect Expenses, Sundry Creditors, Duties & Taxes…). GST is split into CGST, SGST and IGST ledgers. Import into a test company first if you already have ledgers with the same names.</p></div>
      <div class="card"><div class="card-head"><h2>Excel / CSV for your CA</h2></div><div class="list">
        ${[["daybook", "Day book: every entry with its debit and credit lines"], ["pnl", "Profit & loss"], ["bs", "Balance sheet"], ["tb", "Trial balance"], ["gst", "GST summary by rate"], ["b2b", "B2B sales with GSTIN"]]
          .map(([k, l]) => `<div class="item"><div class="grow">${l}</div><button class="btn sm" data-ac="csv" data-id="${k}">Download</button></div>`).join("")}</div></div></div>`;
  },
};
const vRow = (v) => `<div class="item"><div class="grow"><b>${esc(H(v.head_id)?.name || ENTRY_LABEL[v.entry])}</b><span class="muted small">${fmtDate(v.vdate)} · ${esc(ENTRY_LABEL[v.entry])}${v.party ? " · " + esc(v.party) : ""}${v.source !== "manual" ? " · " + (SOURCE[v.source] || "") : ""}</span></div>
  <b class="num" style="color:${v.entry === "income" ? "var(--good)" : "inherit"}">${v.entry === "income" ? "+" : ""}${inr2(+v.total)}</b></div>`;

/* ---------- entry form ---------- */
function entryForm(entry, v = null) {
  const E = ENTRIES[entry]; if (!E) return;
  const heads = S.heads.filter((h) => h.active && E.head(h)), mo = money();
  const moneyOpts = E.money === "in" ? [...mo, ...(entry === "income" ? [sys("debtors")] : [])] : E.money === "out" ? [...mo, ...(["expense", "asset"].includes(entry) ? [sys("creditors")] : [])]
    : S.heads.filter((h) => h.active && ["cash", "bank", "receivable", "payable"].includes(h.class));
  const label = (h) => h.system_key === "debtors" ? "Not received yet (customer owes you)" : h.system_key === "creditors" ? "Not paid yet (you owe the supplier)" : h.name;
  const group = (hs) => Object.entries(hs.reduce((g, h) => ((g[h.class] = g[h.class] || []).push(h), g), {})).map(([c, list]) => `<optgroup label="${esc(classLabel(list[0].kind, c))}">${list.map((h) => `<option value="${h.id}" ${v?.head_id === h.id ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</optgroup>`).join("");
  const today = iso(new Date());
  const m = openModal(`<div class="modal-head"><h2>${v ? "Edit entry" : esc(E.t)}</h2><button class="btn ghost" data-close>Close</button></div>
    <form id="ae-f"><div class="fields">
      <div class="field"><label for="ae-date">Date</label><input id="ae-date" type="date" required value="${v?.vdate || (today > S.to ? S.to : today)}"></div>
      <div class="field"><label for="ae-head">${E.headLabel || (entry === "opening" ? "Account" : "Category")}</label><select id="ae-head" required>${group(heads)}${entry !== "opening" && entry !== "transfer" ? `<option value="__new">+ New category…</option>` : ""}</select></div>
      <div class="field"><label for="ae-amt">${E.gst ? "Amount" : "Amount ₹"}</label><input id="ae-amt" type="number" min="0.01" step="0.01" required inputmode="decimal" value="${v ? (+v.taxable).toFixed(2) : ""}"></div>
      ${E.money !== "none" ? `<div class="field"><label for="ae-money">${E.verb}</label><select id="ae-money" required>${moneyOpts.filter(Boolean).map((h) => `<option value="${h.id}" ${v?.money_id === h.id ? "selected" : ""}>${esc(label(h))}</option>`).join("")}</select></div>` : ""}
      ${E.gst ? `<div class="field"><label for="ae-rate">GST rate</label><select id="ae-rate">${RATES.map((r) => `<option value="${r}" ${+(v?.gst_rate ?? 0) === r ? "selected" : ""}>${r ? r + "%" : "No GST"}</option>`).join("")}</select></div>
        <div class="field" id="ae-gstopts"><label>&nbsp;</label><label class="check" style="margin:0"><input type="checkbox" id="ae-incl" ${v ? "" : "checked"}> Amount includes GST</label><label class="check" style="margin:0"><input type="checkbox" id="ae-igst" ${v?.igst ? "checked" : ""}> Other state (IGST)</label></div>` : ""}
      ${entry !== "opening" ? `<div class="field"><label for="ae-party">${entry === "income" ? "Customer" : entry === "transfer" ? "Who (optional)" : "Paid to / supplier"} <span class="muted">(optional)</span></label><input id="ae-party" value="${esc(v?.party || "")}"></div>` : ""}
      ${E.gst ? `<div class="field ae-g"><label for="ae-gstin">Their GSTIN <span class="muted">(optional)</span></label><input id="ae-gstin" maxlength="15" style="text-transform:uppercase" value="${esc(v?.gstin || "")}"></div>
        <div class="field ae-g"><label for="ae-inv">Bill / invoice no. <span class="muted">(optional)</span></label><input id="ae-inv" value="${esc(v?.invoice_no || "")}"></div>` : ""}
      <div class="field" style="grid-column:1/-1"><label for="ae-note">Note <span class="muted">(optional)</span></label><input id="ae-note" value="${esc(v?.narration || "")}"></div>
    </div>
    <div id="ae-sum" class="note" style="margin-top:12px"></div><p class="err" id="ae-err"></p>
    <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${v ? "Save changes" : "Save entry"}</button></div></form>`, { wide: true });
  const g = (id) => m.querySelector(id);
  const calc = () => {
    const raw = +g("#ae-amt").value || 0, rate = E.gst ? +g("#ae-rate").value : 0, incl = E.gst && g("#ae-incl")?.checked;
    const taxable = rate && incl ? r2(raw / (1 + rate / 100)) : raw, tax = rate ? r2(taxable * rate / 100) : 0;
    if (E.gst) { g("#ae-gstopts").style.display = rate ? "" : "none"; m.querySelectorAll(".ae-g").forEach((x) => (x.style.display = rate ? "" : "none")); }
    const ig = E.gst && g("#ae-igst")?.checked;
    g("#ae-sum").innerHTML = raw ? (rate ? `Value ${inr2(taxable)} + GST ${inr2(tax)} ${ig ? "(IGST)" : `(CGST ${inr2(r2(tax / 2))} + SGST ${inr2(tax - r2(tax / 2))})`} = <b>${inr2(taxable + tax)}</b>` : `Total <b>${inr2(raw)}</b>`) : "Enter the amount.";
    return { taxable, rate };
  };
  const setRateFromHead = () => { const h = H(g("#ae-head").value); if (E.gst && h && !v) g("#ae-rate").value = String(+h.gst_rate || 0); calc(); };
  m.addEventListener("input", calc); m.addEventListener("change", (e) => { if (e.target.id === "ae-head") { if (e.target.value === "__new") return headForm(null, ENTRIES[entry], (id) => { entryForm(entry); const sel = $("#ae-head"); if (sel && id) { sel.value = id; sel.dispatchEvent(new Event("change", { bubbles: true })); } }); setRateFromHead(); } else calc(); });
  setRateFromHead();
  g("#ae-f").onsubmit = async (e) => {
    e.preventDefault(); const btn = m.querySelector("button.primary"); btn.disabled = true; const { taxable, rate } = calc();
    try {
      await q(sb.rpc("acc_post", { p_business: BID(), p: { id: v?.id || null, entry, date: g("#ae-date").value, head_id: g("#ae-head").value, money_id: g("#ae-money")?.value || null, amount: taxable,
        gst_rate: rate, igst: !!(E.gst && g("#ae-igst")?.checked), party: g("#ae-party")?.value.trim() || "", gstin: g("#ae-gstin")?.value.trim() || "", invoice_no: g("#ae-inv")?.value.trim() || "", narration: g("#ae-note").value.trim() } }));
      closeModal(); toast(v ? "Entry updated" : "Saved"); await refresh();
    } catch (err) { g("#ae-err").textContent = err.message; btn.disabled = false; }
  };
}
function moreMenu() {
  openModal(`<div class="modal-head"><h2>Add an entry</h2><button class="btn ghost" data-close>Close</button></div>
    <div class="list">${Object.entries(ENTRIES).map(([k, E]) => `<button class="item" data-ac="new" data-id="${k}" style="text-align:left;width:100%;background:none;border-left:0;border-right:0;cursor:pointer"><div class="grow"><b>${esc(E.t)}</b>${E.sub ? `<span class="muted small">${esc(E.sub)}</span>` : ""}</div><span aria-hidden="true">›</span></button>`).join("")}</div>`);
}
function headForm(h, E = null, after = null) {
  const kinds = E ? Object.keys(KIND).filter((k) => S.heads.some((x) => x.kind === k && E.head(x))) : Object.keys(KIND);
  const kind0 = h?.kind || kinds[0], used = h && S.bal.some((b) => b.id === h.id && (+b.c_dr || +b.c_cr));
  const m = openModal(`<div class="modal-head"><h2>${h ? "Edit category" : "New category"}</h2><button class="btn ghost" data-close>Close</button></div>
    <form id="ah-f"><div class="fields">
      <div class="field" style="grid-column:1/-1"><label for="ah-name">Name</label><input id="ah-name" required maxlength="80" value="${esc(h?.name || "")}" placeholder="e.g. Swiggy commission"></div>
      <div class="field"><label for="ah-kind">It is</label><select id="ah-kind" ${h?.system_key || used ? "disabled" : ""}>${kinds.map((k) => `<option value="${k}" ${kind0 === k ? "selected" : ""}>${KIND[k]}</option>`).join("")}</select></div>
      <div class="field"><label for="ah-class">Type</label><select id="ah-class" ${h?.system_key || used ? "disabled" : ""}></select></div>
      <div class="field"><label for="ah-rate">Usual GST rate</label><select id="ah-rate">${RATES.map((r) => `<option value="${r}" ${+(h?.gst_rate || 0) === r ? "selected" : ""}>${r ? r + "%" : "No GST"}</option>`).join("")}</select></div>
      ${h ? `<div class="field"><label>&nbsp;</label><label class="check" style="margin:0"><input type="checkbox" id="ah-active" ${h.active ? "checked" : ""}> Show in lists</label></div>` : ""}
    </div><p class="small muted" id="ah-tally" style="margin-top:8px"></p><p class="err" id="ah-err"></p>
    <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
  const fill = () => { const k = m.querySelector("#ah-kind").value, cur = h?.class; m.querySelector("#ah-class").innerHTML = CLASSES[k].filter(([c]) => !E || S.heads.some((x) => x.class === c && E.head(x)) || !h).map(([c, l]) => `<option value="${c}" ${cur === c ? "selected" : ""}>${esc(l)}</option>`).join(""); tally(); };
  const tally = () => (m.querySelector("#ah-tally").textContent = "Tally group: " + TALLY[m.querySelector("#ah-class").value]);
  m.querySelector("#ah-kind").onchange = fill; m.querySelector("#ah-class").onchange = tally; fill();
  m.querySelector("#ah-f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const id = await q(sb.rpc("acc_head_save", { p_business: BID(), p: { id: h?.id || null, name: m.querySelector("#ah-name").value.trim(), kind: m.querySelector("#ah-kind").value, class: m.querySelector("#ah-class").value,
        gst_rate: +m.querySelector("#ah-rate").value, active: h ? m.querySelector("#ah-active").checked : true } }));
      closeModal(); toast("Category saved"); await refresh(false); if (after) after(id); else draw();
    } catch (err) { m.querySelector("#ah-err").textContent = err.message; }
  };
}

/* ---------- ledger for one account ---------- */
async function ledger(id) {
  const h = H(id); if (!h) return;
  const lines = await q(sb.from("acc_lines").select("voucher_id,vdate,dr,cr").eq("head_id", id).gte("vdate", S.from).lte("vdate", S.to).order("vdate"));
  const b = B(id), natural = ["income", "liability", "equity"].includes(h.kind) ? -1 : 1;
  const bs = ["asset", "liability", "equity"].includes(h.kind);
  let run = bs ? natural * (+b.o_dr - +b.o_cr) : 0;
  const vs = Object.fromEntries(S.vouchers.map((v) => [v.id, v]));
  openModal(`<div class="modal-head"><h2>${esc(h.name)}</h2><button class="btn ghost" data-close>Close</button></div>
    <p class="muted small">${esc(KIND[h.kind])} · ${esc(classLabel(h.kind, h.class))} · ${periodText()}</p>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Date</th><th>Entry</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th><th style="text-align:right">Balance</th></tr></thead><tbody>
    ${["asset", "liability", "equity"].includes(h.kind) ? `<tr><td colspan="4">Opening balance</td>${amt(run)}</tr>` : ""}
    ${lines.map((l) => { run += natural * (+l.dr - +l.cr); const v = vs[l.voucher_id]; return `<tr><td>${fmtDate(l.vdate)}</td><td class="small">${esc(v ? ENTRY_LABEL[v.entry] + (v.party ? " · " + v.party : "") + (v.narration ? " · " + v.narration : "") : "")}</td>${+l.dr ? amt(+l.dr) : "<td></td>"}${+l.cr ? amt(+l.cr) : "<td></td>"}${amt(run)}</tr>`; }).join("") || `<tr><td colspan="5" class="muted">No entries in this period</td></tr>`}
    </tbody></table></div>`, { wide: true });
}

/* ---------- imports ---------- */
function importVisits() {
  const mo = money();
  const m = openModal(`<div class="modal-head"><h2>Bring in sales from visits</h2><button class="btn ghost" data-close>Close</button></div>
    <p>Adds one sales entry per day from the bills you logged (${periodText()}). Running it again updates those days, so nothing is counted twice.</p>
    <div class="fields" style="margin-top:12px"><div class="field"><label for="iv-money">Money received in</label><select id="iv-money">${mo.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="iv-rate">GST on your sales</label><select id="iv-rate">${RATES.map((r) => `<option value="${r}" ${r === 5 ? "selected" : ""}>${r ? r + "%" : "No GST / not registered"}</option>`).join("")}</select></div>
      <div class="field" style="grid-column:1/-1"><label class="check"><input type="checkbox" id="iv-incl" checked> Bill amounts already include GST</label></div></div>
    <p class="err" id="iv-err"></p><div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="iv-go">Bring in sales</button></div>`);
  m.querySelector("#iv-go").onclick = async () => {
    try { const n = await q(sb.rpc("acc_import_visits", { p_business: BID(), p_from: S.from, p_to: S.to, p_money: m.querySelector("#iv-money").value, p_gst_rate: +m.querySelector("#iv-rate").value, p_inclusive: m.querySelector("#iv-incl").checked }));
      closeModal(); toast(n ? `Added sales for ${n} day${n === 1 ? "" : "s"}` : "No logged bills in this period"); await refresh(); }
    catch (err) { m.querySelector("#iv-err").textContent = err.message; }
  };
}
function importSalary() {
  const mo = money();
  const m = openModal(`<div class="modal-head"><h2>Bring in paid salaries</h2><button class="btn ghost" data-close>Close</button></div>
    <p>Adds each salary marked as paid (${periodText()}) as a salary expense. Advance cuts reduce the staff advance instead of being counted twice.</p>
    <div class="field" style="margin-top:12px"><label for="is-money">Paid from</label><select id="is-money">${mo.map((h) => `<option value="${h.id}" ${h.class === "bank" ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></div>
    <p class="err" id="is-err"></p><div class="modal-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="is-go">Bring in salaries</button></div>`);
  m.querySelector("#is-go").onclick = async () => {
    try { const n = await q(sb.rpc("acc_import_salary", { p_business: BID(), p_from: S.from, p_to: S.to, p_money: m.querySelector("#is-money").value }));
      closeModal(); toast(n ? `Added ${n} salary payment${n === 1 ? "" : "s"}` : "No paid salaries in this period"); await refresh(); }
    catch (err) { m.querySelector("#is-err").textContent = err.message; }
  };
}

/* ---------- exports ---------- */
const fname = (k, ext) => `${ctx().D.biz.slug || "business"}-${k}-${S.from}-to-${S.to}.${ext}`;
async function dayLines() {
  const lines = await q(sb.from("acc_lines").select("voucher_id,head_id,dr,cr").eq("business_id", BID()).gte("vdate", S.from).lte("vdate", S.to).limit(20000));
  const by = {}; lines.forEach((l) => (by[l.voucher_id] = by[l.voucher_id] || []).push(l)); return by;
}
async function csv(k) {
  if (k === "pnl") { const P = pnl(); return downloadCSV([["Profit & loss", periodText()], [], ["Sales"], ...P.sales.map((r) => [r.name, r2(r.v)]), ["Total sales", r2(P.revenue)],
    ["Stock & direct costs"], ...P.cogs.map((r) => [r.name, r2(r.v)]), ["Gross profit", r2(P.gross)], ["Other income"], ...P.other.map((r) => [r.name, r2(r.v)]),
    ["Running expenses"], ...P.opex.map((r) => [r.name, r2(r.v)]), ["Interest, bank charges & depreciation"], ...P.fin.map((r) => [r.name, r2(r.v)]), [P.net >= 0 ? "Net profit" : "Net loss", r2(P.net)]], fname("profit-and-loss", "csv")); }
  if (k === "bs") { const s = sheet(); return downloadCSV([["Balance sheet as on", S.to], [], ["Assets"], ...s.assets.map((r) => [r.name, r2(r.v)]), ["Total assets", r2(s.ta)], [],
    ["Liabilities"], ...s.liabs.map((r) => [r.name, r2(r.v)]), ["Total liabilities", r2(s.tl)], ["Capital", r2(s.capital)], ["Drawings", r2(-s.drawings)], ["Profit to date", r2(s.profitToDate)], ["Total equity", r2(s.te)], ["Liabilities + equity", r2(s.tl + s.te)]], fname("balance-sheet", "csv")); }
  if (k === "tb") return downloadCSV([["Account", "Type", "Tally group", "Debit", "Credit"], ...S.bal.filter((b) => Math.abs(+b.c_dr - +b.c_cr) >= 0.005).map((b) => { const d = r2(+b.c_dr - +b.c_cr); return [b.name, KIND[b.kind], TALLY[b.class], d > 0 ? d : "", d < 0 ? -d : ""]; })], fname("trial-balance", "csv"));
  if (k === "gst") { const G = gst(), rows = (t, list) => list.map((r) => [t, r.rate, r2(r.taxable), r2(r.cgst), r2(r.sgst), r2(r.igst), r2(r.cgst + r.sgst + r.igst)]);
    return downloadCSV([["Type", "Rate %", "Taxable value", "CGST", "SGST", "IGST", "Total GST"], ...rows("Sales (output)", G.out), ...rows("Purchases (input credit)", G.inp), [], ["Net GST payable", "", "", r2(G.net.cgst), r2(G.net.sgst), r2(G.net.igst), r2(G.net.all)]], fname("gst-summary", "csv")); }
  if (k === "b2b") { const G = gst(); return downloadCSV([["GSTIN of recipient", "Receiver name", "Invoice number", "Invoice date", "Invoice value", "Rate", "Taxable value", "IGST", "CGST", "SGST"],
    ...G.b2b.map((v) => { const h = r2(+v.gst / 2); return [v.gstin, v.party, v.invoice_no || v.number, v.vdate, r2(+v.total), +v.gst_rate, r2(+v.taxable), v.igst ? r2(+v.gst) : "", v.igst ? "" : h, v.igst ? "" : r2(+v.gst - h)]; })], fname("b2b-sales", "csv")); }
  if (k === "daybook") { const by = await dayLines(); const out = [["Date", "Voucher type", "No.", "Entry", "Party", "GSTIN", "Invoice", "Note", "Account", "Debit", "Credit"]];
    [...S.vouchers].reverse().forEach((v) => (by[v.id] || []).forEach((l) => out.push([v.vdate, v.vtype, v.number, ENTRY_LABEL[v.entry], v.party, v.gstin, v.invoice_no, v.narration, H(l.head_id)?.name || "", +l.dr || "", +l.cr || ""])));
    return downloadCSV(out, fname("day-book", "csv")); }
}
const x = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const envelope = (report, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME></REQUESTDESC><REQUESTDATA>\n${body}\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
const DUTY = { gst_out_c: "Central Tax", gst_in_c: "Central Tax", gst_out_s: "State Tax", gst_in_s: "State Tax", gst_out_i: "Integrated Tax", gst_in_i: "Integrated Tax" };
const TALLY_VTYPE = { sales: "Sales", purchase: "Purchase", receipt: "Receipt", payment: "Payment", journal: "Journal", contra: "Contra" };
function save(text, name, type = "application/xml") { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
async function tally(kind) {
  if (kind === "masters") {
    const body = S.heads.filter((h) => h.name !== "Cash").map((h) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${x(h.name)}" ACTION="Create"><NAME.LIST><NAME>${x(h.name)}</NAME></NAME.LIST><PARENT>${x(TALLY[h.class])}</PARENT>`
      + (DUTY[h.system_key] ? `<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>${DUTY[h.system_key]}</GSTDUTYHEAD>` : "") + `<ISBILLWISEON>No</ISBILLWISEON></LEDGER></TALLYMESSAGE>`).join("\n");
    return save(envelope("All Masters", body), fname("tally-masters", "xml"));
  }
  const by = await dayLines(), d8 = (s) => s.replace(/-/g, "");
  const body = [...S.vouchers].reverse().map((v) => { const ls = by[v.id] || []; const party = H(v.money_id)?.name || H(v.head_id)?.name || "";
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${TALLY_VTYPE[v.vtype]}" ACTION="Create"><DATE>${d8(v.vdate)}</DATE><EFFECTIVEDATE>${d8(v.vdate)}</EFFECTIVEDATE><VOUCHERTYPENAME>${TALLY_VTYPE[v.vtype]}</VOUCHERTYPENAME><VOUCHERNUMBER>${v.number}</VOUCHERNUMBER>`
      + (v.invoice_no ? `<REFERENCE>${x(v.invoice_no)}</REFERENCE>` : "") + `<PARTYLEDGERNAME>${x(party)}</PARTYLEDGERNAME><NARRATION>${x([v.party, v.gstin && "GSTIN " + v.gstin, v.narration].filter(Boolean).join(" · "))}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`
      + ls.map((l) => { const dr = +l.dr > 0, a = dr ? +l.dr : +l.cr; return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(H(l.head_id)?.name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${dr ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${(dr ? -a : a).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`; }).join("")
      + `</VOUCHER></TALLYMESSAGE>`; }).join("\n");
  save(envelope("Vouchers", body), fname("tally-vouchers", "xml"));
}

/* ---------- events ---------- */
async function refresh(redraw = true) { await load(); if (redraw) draw(); }
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-ac]"); if (!el || !A || !A.isRoute("accounts")) return;
  const a = el.dataset.ac, id = el.dataset.id;
  if (el.tagName === "A") e.preventDefault();
  try {
    if (a === "tab") { S.tab = id; closeModal(); draw(); }
    if (a === "new") { closeModal(); entryForm(id); }
    if (a === "more") moreMenu();
    if (a === "edit") { const v = S.vouchers.find((x) => x.id === id); entryForm(v.entry, v); }
    if (a === "del") { if (!(await confirmBox("Delete this entry?", "It's removed from all reports.", "Delete", { danger: true }))) return; await q(sb.rpc("acc_delete", { p_business: BID(), p_id: id })); toast("Deleted"); await refresh(); }
    if (a === "ledger") { closeModal(); await ledger(id); }
    if (a === "head-new") headForm(null);
    if (a === "head-edit") headForm(H(id));
    if (a === "import-visits") importVisits();
    if (a === "import-salary") importSalary();
    if (a === "csv") await csv(id);
    if (a === "tally") await tally(id);
  } catch (err) { toast(err.message, "error"); }
});
document.addEventListener("change", async (e) => {
  if (!A || !A.isRoute("accounts")) return;
  const t = e.target;
  if (t.id === "ac-period") { S.period = t.value; if (t.value === "custom") { [S.from, S.to] = periodRange("fy"); } await refresh(); }
  if (t.id === "ac-from" || t.id === "ac-to") { S[t.id === "ac-from" ? "from" : "to"] = t.value; if (S.from && S.to && S.from <= S.to) await refresh(); }
  if (t.id === "ac-f") { S.f = t.value; $("#ac-body").innerHTML = VIEW.entries(); }
});
document.addEventListener("input", (e) => { if (e.target.id === "ac-q" && A?.isRoute("accounts")) { S.q = e.target.value; const pos = e.target.selectionStart; $("#ac-body").innerHTML = VIEW.entries(); const i = $("#ac-q"); i.focus(); i.setSelectionRange(pos, pos); } });

export function registerAccounts(api) {
  A = api;
  api.VIEWS.accounts = () => `<div id="acc-view"><div class="loading"><span class="spinner"></span></div></div>`;
  api.after.accounts = async () => { try { await load(); draw(); } catch (e) { $("#acc-view").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; } };
}
