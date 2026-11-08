// Customer portal (optional): loyalty cards, offers, visit history, feedback. Everything is managed by the business.
import { sb, q } from "./sb.js";
import { $, esc, inr, fmtDate, fmtDT, toast, openModal, closeModal, ico, shell, loyaltyCard, prettyPhone, rwLabel } from "./ui.js";
import { mountReviewHelper } from "./review-helper.js";

let C, D = {};
const ROUTES = [{ label: "", items: [["cards", "My cards", "card"], ["offers", "Offers", "tag"], ["visits", "My visits", "chart"], ["me", "My profile", "users"], ["signout", "Sign out", "out"]] }];
const route = () => { const h = location.hash.slice(1); return ROUTES[0].items.some((r) => r[0] === h) ? h : "cards"; };

export async function mount(ctx) {
  C = ctx;
  window.addEventListener("hashchange", () => { if (location.hash === "#signout") return C.signOut(); render(); });
  const [biz, me, progs, rewards, visits, coupons] = await Promise.all([
    q(sb.rpc("my_businesses")), q(sb.from("customers").select("*")), q(sb.from("loyalty_programs").select("*")),
    q(sb.from("loyalty_rewards").select("*").order("visit_no")), q(sb.from("visits").select("*").order("created_at", { ascending: false }).limit(200)), q(sb.from("coupons").select("*")),
  ]);
  Object.assign(D, { biz, me, progs, rewards, visits, coupons });
  render();
}
function render() {
  $("#nav").innerHTML = shell({ brandSub: "My rewards", groups: ROUTES, current: route(), footer: `<div class="who-box"><b>${esc(C.profile.full_name || "Welcome")}</b><span>${esc(prettyPhone(C.profile.phone || C.user.phone || ""))}</span></div>` });
  $("#main").innerHTML = VIEWS[route()](); $("#main").scrollTop = 0;
}
const head = (t, p) => `<div class="page-head"><div><h1>${t}</h1>${p ? `<p>${p}</p>` : ""}</div></div>`;
const empty = `<div class="card empty" style="padding:40px 20px"><p style="font-size:40px">🎟️</p><p><b>No cards yet.</b></p><p>When you visit a business that uses Branditude Growth Plan, ask them to log your visit with this phone number. Your loyalty card shows up here.</p></div>`;
const VIEWS = {
  cards() {
    if (!D.biz.length) return head("My cards") + empty;
    return head("My loyalty cards", "Your stamps and rewards at each place you visit. The business adds a stamp every time you visit.") + `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">${D.biz.map((b) => {
      const me = D.me.find((c) => c.business_id === b.id), prog = D.progs.find((p) => p.business_id === b.id), rw = D.rewards.filter((r) => r.business_id === b.id);
      return `<div class="card" style="display:flex;flex-direction:column;gap:12px;align-items:center">
        ${prog?.enabled ? loyaltyCard({ bizName: b.name, prog, rewards: rw, customer: me || {} }) : `<div class="card empty" style="width:100%"><b>${esc(b.name)}</b><br>No loyalty card here yet.</div>`}
        <div style="width:100%" class="small muted">${esc(b.icon || "")} ${esc(b.category || "")}${b.city ? " · " + esc(b.city) : ""} · ${me?.visits || 0} visits</div>
        ${rw.length ? `<details style="width:100%"><summary class="small" style="cursor:pointer;font-weight:600">All rewards on this card</summary><div class="list">${rw.map((r) => `<div class="item small"><span class="grow">Visit ${r.visit_no}</span><b>${esc(rwLabel(r))}</b></div>`).join("")}</div></details>` : ""}
        <div class="row" style="width:100%"><button class="btn sm" data-c="rate" data-id="${b.id}">${ico("smile")} Rate your last visit</button>${b.google_review_link ? `<a class="btn sm" href="${esc(b.google_review_link)}" target="_blank" rel="noopener">${ico("star")} Review on Google</a>` : ""}</div></div>`; }).join("")}</div>`;
  },
  offers() {
    const live = D.coupons.filter((k) => k.active && (!k.expiry || k.expiry >= new Date().toISOString().slice(0, 10)) && (!k.usage_limit || k.used < k.usage_limit));
    return head("Offers for you", "Show the code at the counter when you pay.") + (live.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${live.map((k) => `<div class="coupon">
      <div class="muted small">${esc(D.biz.find((b) => b.id === k.business_id)?.name || "")}</div><span class="code">${esc(k.code)}</span><div class="deal">${k.type === "percent" ? +k.value + "% off" : inr(k.value) + " off"}${+k.min_bill ? ` on bills over ${inr(k.min_bill)}` : ""}</div>
      <div class="muted small">${esc(k.title || "")}${k.expiry ? " · till " + fmtDate(k.expiry) : ""}</div></div>`).join("")}</div>` : `<div class="card empty">No offers right now. Check back after your next visit.</div>`);
  },
  visits() {
    return head("My visits") + (D.visits.length ? `<div class="card"><div class="list">${D.visits.map((v) => `<div class="item"><div class="grow"><b>${esc(D.biz.find((b) => b.id === v.business_id)?.name || "")}</b><span class="muted small">${fmtDT(v.created_at)}${v.loyalty_reward ? " · 🎁 " + esc(v.loyalty_reward) : ""}${v.coupon_code ? " · code " + esc(v.coupon_code) : ""}</span></div><span class="num">${inr(v.net)}</span>${+v.discount ? `<span class="pill good">saved ${inr(v.discount)}</span>` : ""}</div>`).join("")}</div></div>` : `<div class="card empty">No visits yet.</div>`);
  },
  me() {
    return head("My profile") + `<form id="me" class="card" style="max-width:520px"><div class="field"><label for="me-name">Your name</label><input id="me-name" value="${esc(C.profile.full_name || "")}"></div>
      <dl class="kv" style="margin-top:14px"><dt>Phone</dt><dd>${esc(prettyPhone(C.user.phone || ""))}</dd></dl>
      <div class="modal-foot" style="justify-content:flex-start"><button class="btn primary">Save</button></div></form>
      <p class="small muted" style="margin-top:12px">Businesses only see what they record about your visits. To remove your data from a business, ask that business.</p>`;
  },
};
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "me") return; e.preventDefault();
  try { await q(sb.from("profiles").update({ full_name: $("#me-name").value.trim() }).eq("id", C.user.id)); C.profile.full_name = $("#me-name").value.trim(); toast("Saved"); render(); } catch (err) { toast(err.message, "error"); }
});
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-c]"); if (!el || !C) return;
  if (el.dataset.c === "rate") {
    const b = D.biz.find((x) => x.id === el.dataset.id); let rating = 0;
    const m = openModal(`<div class="modal-head"><h2>How was ${esc(b.name)}?</h2><button class="btn ghost" data-close>Close</button></div>
      <div class="k-stars" style="margin:0">${[1, 2, 3, 4, 5].map((n) => `<button class="k-star" data-n="${n}" style="padding:10px 4px" aria-label="${n} stars"><span>★</span><b class="num">${n}</b></button>`).join("")}</div>
      <div id="rate-more" style="margin-top:14px"></div>`);
    m.querySelectorAll("[data-n]").forEach((s) => (s.onclick = () => {
      rating = +s.dataset.n; m.querySelectorAll("[data-n]").forEach((x) => (x.style.borderColor = +x.dataset.n <= rating ? "var(--accent)" : ""));
      if (rating >= 4 && b.google_review_link) {   // their own words → tidied options → copy → Google
        const go = (text) => { q(sb.rpc("submit_feedback", { p_slug: b.slug, p_rating: rating, p_tags: [], p_text: text || "", p_name: C.profile.full_name || "", p_phone: "", p_opened_google: true })).catch(() => {});
          window.open(b.google_review_link, "_blank", "noopener"); closeModal(); toast(text ? "Copied! Paste it on Google." : "Opening Google reviews…"); };
        return mountReviewHelper(m.querySelector("#rate-more"), { slug: b.slug, bizName: b.name, link: b.google_review_link, compact: true, onSkip: () => go(""), onOpen: (t) => go(t) });
      }
      const quiet = b.google_review_link ? `<p class="k-quiet">You can also <a href="${esc(b.google_review_link)}" target="_blank" rel="noopener" id="rate-g">post a public review on Google</a>.</p>` : "";
      m.querySelector("#rate-more").innerHTML = rating >= 4
        ? `<p>Thank you for the rating!</p><div class="modal-foot" style="justify-content:flex-start"><button class="btn primary" id="rate-send">Send my rating</button></div>`
        : `<p><b>We're sorry we let you down.</b> Please tell the owner what went wrong. It goes straight to them, privately, and they read every message.</p><textarea id="rate-text" placeholder="Tell the owner what happened"></textarea><div class="modal-foot" style="justify-content:flex-start"><button class="btn primary" id="rate-send">Send privately to the owner</button></div>${quiet}`;
      const send = async (opened) => { try { await q(sb.rpc("submit_feedback", { p_slug: b.slug, p_rating: rating, p_tags: [], p_text: m.querySelector("#rate-text")?.value || "", p_name: C.profile.full_name || "", p_phone: "", p_opened_google: !!opened })); closeModal(); toast("Thanks for your feedback"); } catch (err) { toast(err.message, "error"); } };
      m.querySelector("#rate-send").onclick = () => send(false);
      const gl = m.querySelector("#rate-g"); if (gl) gl.addEventListener("click", () => send(true));
    }));
  }
});
