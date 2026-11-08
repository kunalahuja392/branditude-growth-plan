// Review helper for happy customers (4–5★): the customer writes in THEIR OWN words, we tidy spelling/grammar
// (AI if switched on, otherwise a simple local tidy), they pick a version, it's copied and Google opens.
// We never add keywords or claims and never write the review for them — Google doesn't allow directing review content.
import { sb } from "./sb.js";
import { esc } from "./ui.js";

export function tidyLocal(t) {
  let s = String(t || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.replace(/\bi\b/g, "I").replace(/\s+([,.!?])/g, "$1").replace(/([,.!?])(?=[A-Za-z])/g, "$1 ")
    .replace(/!{2,}/g, "!").replace(/\?{2,}/g, "?").replace(/\.{4,}/g, "...")
    .replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  if (!/[.!?…)]$/.test(s)) s += ".";
  return s;
}
const sentences = (s) => s.match(/[^.!?]+[.!?]+/g) || [s];

// → [{ key, label, text }] (deduplicated; the customer's original is always last)
export async function reviewOptions(slug, text) {
  const original = String(text || "").trim();
  let short = "", detailed = "";
  try {
    const { data, error } = await sb.functions.invoke("review-polish", { body: { slug, text: original } });
    if (!error && data && !data.fallback) ({ short = "", detailed = "" } = data);
  } catch {}
  if (!short && !detailed) {
    detailed = tidyLocal(original);
    const ss = sentences(detailed);
    short = ss.length > 2 ? ss.slice(0, 2).join(" ").trim() : "";
  }
  const out = [], seen = new Set();
  for (const [key, label, t] of [["short", "Short", short], ["detailed", "Tidied up", detailed], ["original", "Exactly as you wrote it", original]]) {
    const n = (t || "").trim(); if (!n || seen.has(n.toLowerCase())) continue; seen.add(n.toLowerCase()); out.push({ key, label, text: n });
  }
  return out;
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  try { const a = document.createElement("textarea"); a.value = t; a.style.position = "fixed"; a.style.opacity = "0"; document.body.appendChild(a); a.select(); const ok = document.execCommand("copy"); a.remove(); return ok; } catch { return false; }
}

/* Renders the helper into `el`.
   opts: { slug, bizName, link, compact, onSkip(), onOpen(text) }  — onOpen/onSkip should record feedback and open Google. */
export function mountReviewHelper(el, opts) {
  const H = opts.compact ? "h2" : "h1", hc = opts.compact ? "" : "k-q", sc = opts.compact ? "muted" : "k-sub", bc = opts.compact ? "btn" : "btn k-btn";
  let text = "", options = [], pick = 0;
  const write = () => {
    el.innerHTML = `<${H} class="${hc}">So glad you enjoyed it! 😊</${H}>
      <p class="${sc}">Would you share a few words about ${esc(opts.bizName)} on Google? Write it your way. We'll only fix spelling and grammar, and you choose what gets posted.</p>
      <textarea id="rh-text" class="rh-text" maxlength="1500" placeholder="What did you like about your visit?" aria-label="Your review in your own words">${esc(text)}</textarea>
      <p class="err" id="rh-err"></p>
      <div class="k-actions rh-actions"><button class="${bc} primary" id="rh-go">Tidy my words</button><button class="${bc} ghost" id="rh-skip">Skip, go to Google</button></div>`;
    el.querySelector("#rh-skip").onclick = () => opts.onSkip();
    el.querySelector("#rh-go").onclick = async (e) => {
      text = el.querySelector("#rh-text").value.trim();
      if (text.length < 8) { el.querySelector("#rh-err").textContent = "Write a few words first, or tap Skip."; return; }
      e.target.disabled = true; e.target.textContent = "Tidying…";
      options = await reviewOptions(opts.slug, text); pick = 0; choose();
    };
  };
  const choose = () => {
    el.innerHTML = `<${H} class="${hc}">Pick the one you like</${H}>
      <p class="${sc}">All of these are your own words. You can edit the one you pick.</p>
      <div class="rh-opts" role="radiogroup" aria-label="Review versions">${options.map((o, i) => `<button class="rh-opt" role="radio" aria-checked="${i === pick}" data-i="${i}"><small>${esc(o.label)}</small><span>${esc(o.text)}</span></button>`).join("")}</div>
      <textarea id="rh-final" class="rh-text" maxlength="4000" aria-label="Review to post">${esc(options[pick].text)}</textarea>
      <p class="small muted rh-hint">We'll copy it for you. On Google, tap the stars, then long-press the box and paste.</p>
      <div class="k-actions rh-actions"><button class="${bc} primary" id="rh-copy">Copy &amp; open Google</button><button class="${bc} ghost" id="rh-back">Change my words</button></div>`;
    el.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { pick = +b.dataset.i; choose(); }));
    el.querySelector("#rh-back").onclick = write;
    el.querySelector("#rh-copy").onclick = (e) => {
      const t = el.querySelector("#rh-final").value.trim() || options[pick].text;
      copyText(t);                 // don't await: opening Google must happen inside the tap
      e.target.textContent = "Copied ✓ Opening Google…";
      opts.onOpen(t);
    };
  };
  write();
}
