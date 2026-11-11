// Sales agent portal: their referral codes, businesses they brought in, commissions and payouts. Read-only.
import { sb, q } from "./sb.js";
import { $, esc, inr2, fmtDate, ico, shell, copy } from "./ui.js";

export async function mount(ctx, me) {
  window.addEventListener("hashchange", () => { if (location.hash === "#signout") ctx.signOut(); });
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-copy]"); if (b) copy(b.dataset.copy, "Link copied"); });
  $("#nav").innerHTML = shell({ brandSub: "Sales partner", groups: [{ label: "", items: [["home", "My earnings", "rupee"], ["signout", "Sign out", "out"]] }], current: "home",
    footer: `<div class="who-box"><b>${esc(me.name)}</b><span>${+me.pct}% commission</span></div>` });
  const link = (c) => `${location.origin}/?ref=${encodeURIComponent(c)}`;
  const kpi = (l, v, s = "") => `<div class="card kpi"><div class="label">${l}</div><div class="value num">${v}</div><div class="sub">${s}</div></div>`;
  $("#main").innerHTML = `<div class="page-head"><div><h1>Hi ${esc(me.name.split(" ")[0])} 👋</h1><p>You earn ${+me.pct}% of the plan and add-on payments of businesses that sign up with your code${me.months ? `, for their first ${me.months} months` : ", every time they renew"}.</p></div></div>
    <div class="grid g4">${kpi("Businesses", me.businesses.length, `${me.businesses.filter((b) => b.status === "active").length} paying`)}${kpi("Earned, to be paid", inr2(me.due))}${kpi("Paid to you", inr2(me.paid), me.payouts[0] ? "last " + fmtDate(me.payouts[0].paid_on) : "")}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Your codes</h2></div>
      ${me.codes.length ? `<div class="list">${me.codes.map((c) => `<div class="item"><div class="grow"><b>${esc(c.code)}</b><span class="muted small">${+c.off ? `${+c.off}% off for the business (comes out of your ${+me.pct}%)` : "No discount"} · used ${c.used} times</span></div><button class="btn sm" data-copy="${esc(link(c.code))}">${ico("copy")} Copy sign-up link</button></div>`).join("")}</div>` : `<div class="empty">Ask Branditude for your code.</div>`}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Businesses you brought in</h2></div>
      ${me.businesses.length ? `<div class="list">${me.businesses.map((b) => `<div class="item"><div class="grow"><b>${esc(b.name)}</b><span class="muted small">${esc(b.city || "")}${b.since ? " · since " + fmtDate(b.since) : ""}</span></div><span class="pill ${b.status === "active" ? "good" : ""}">${b.status === "active" ? "Paying" : b.status === "trial" ? "On trial" : "Not paying yet"}</span></div>`).join("")}</div>` : `<div class="empty">None yet. Share your link to get started.</div>`}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Commissions</h2></div>
      ${me.commissions.length ? `<div class="list">${me.commissions.map((c) => `<div class="item"><div class="grow"><b>${esc(c.business)}</b><span class="muted small">${fmtDate(c.at)} · ${+c.pct}%</span></div><b class="num">${inr2(c.amount)}</b><span class="pill ${c.status === "paid" ? "good" : "warn"}">${c.status === "paid" ? "Paid" : "To be paid"}</span></div>`).join("")}</div>` : `<div class="empty">No commissions yet.</div>`}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Payouts</h2></div>
      ${me.payouts.length ? `<div class="list">${me.payouts.map((p) => `<div class="item"><div class="grow">${fmtDate(p.paid_on)}${p.utr ? ` · UTR ${esc(p.utr)}` : ""}</div><b class="num">${inr2(p.amount)}</b></div>`).join("")}</div>` : `<div class="empty">No payouts yet.</div>`}</div>`;
}
