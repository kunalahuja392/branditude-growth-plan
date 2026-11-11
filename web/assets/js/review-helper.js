// Review helper for happy customers (4–5★).
// Step 1: "What did you like?" chips (the business's keywords + plain ones). The customer ticks what they really liked.
// Step 2: three suggestions built ONLY from their picks (or their own words, tidied), they pick one and edit it.
// Step 3: copy, open Google, paste. Nothing is posted for them, and every suggestion is editable.
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

const PLAIN = ["Friendly staff", "Quick service", "Clean place", "Good value", "Nice ambience"];
const low = (t) => (/^[A-Z]{2,}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));
const list = (a) => (a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
// Built-in suggestions (used when AI is off): three varied drafts from the picked chips only.
// One or two mention the locality or city naturally; at least one never does. Wording is randomised per customer.
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
export function suggestReviews(bizName, picks, rating = 5, place = {}) {
  const p = picks.map(low); if (!p.length) return [];
  const five = rating >= 5, good = five ? rnd(["excellent", "amazing", "really great"]) : rnd(["really good", "very nice", "good"]);
  const loc = place.locality || "", city = place.city || "", one = p[0], rest = p.slice(1), be = p.length > 1 ? "were" : "was";
  const inLoc = loc ? ` in ${loc}` : city ? ` in ${city}` : "", inCity = city ? ` in ${city}` : "";
  const a = rnd([`${five ? "Loved" : "Liked"} my visit to ${bizName}.`, `Visited ${bizName} today.`, `Had a ${five ? "lovely" : "nice"} time at ${bizName}.`])
    + ` The ${list(p)} ${be} ${good}. ` + rnd(["Will definitely come back!", "Will be back soon.", "Totally worth it."]);
  const b = `${rnd(["One of my favourite places", "A great spot", "My go-to place"])}${inLoc}. The ${one} ${rnd(["stood out", "is a must-try", "never disappoints"])}`
    + (rest.length ? `, and I also liked the ${list(rest)}` : "") + `. ${rnd(["Recommended.", "Highly recommend it.", "Do try it."])}`;
  const c = `${good.charAt(0).toUpperCase() + good.slice(1)} ${list(p)} at ${bizName}${Math.random() < 0.5 ? inCity : ""}. ${rnd(["Thank you!", "Thanks to the team!", "Keep it up!"])}`;
  return [a, b, c].sort(() => Math.random() - 0.5).map((text, i) => ({ key: "s" + i, label: `Suggestion ${i + 1}`, text: text.replace(/\s+/g, " ").trim() }));
}
// AI first (varied, SEO-friendly, mentions the area sometimes), built-in if AI is off or busy
export async function getSuggestions(slug, bizName, picks, rating, place) {
  try {
    const { data, error } = await sb.functions.invoke("review-suggest", { body: { slug, picks, rating } });
    if (!error && data?.suggestions?.length) return data.suggestions.map((x, i) => ({ key: "a" + i, label: x.label || `Suggestion ${i + 1}`, text: x.text }));
  } catch {}
  return suggestReviews(bizName, picks, rating, place);
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  try { const a = document.createElement("textarea"); a.value = t; a.style.position = "fixed"; a.style.opacity = "0"; document.body.appendChild(a); a.select(); const ok = document.execCommand("copy"); a.remove(); return ok; } catch { return false; }
}

/* Renders the helper into `el`.
   opts: { slug, bizName, link, compact, onSkip(), onOpen(text) }  — onOpen/onSkip should record feedback and open Google. */
export function mountReviewHelper(el, opts) {
  const H = opts.compact ? "h2" : "h1", hc = opts.compact ? "" : "k-q", sc = opts.compact ? "muted" : "k-sub", bc = opts.compact ? "btn" : "btn k-btn";
  let text = "", options = [], pick = 0, picks = [], chips = null, mode = "own", place = {};
  const like = async () => {
    if (!chips) { try { const { data } = await sb.rpc("review_chips", { p_slug: opts.slug }); const kw = Array.isArray(data) ? data : data?.chips || []; place = { city: data?.city || "", locality: data?.locality || "" }; chips = [...kw, ...PLAIN].filter((c, i, a) => a.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i).slice(0, 12); } catch { chips = PLAIN; } }
    el.innerHTML = `<${H} class="${hc}">So glad you enjoyed it! 😊</${H}>
      <p class="${sc}">What did you like at ${esc(opts.bizName)}? Tap all that apply and we'll suggest a review you can edit.</p>
      <div class="chips k-chips rh-chips">${chips.map((c) => `<button class="chip" data-c="${esc(c)}" aria-pressed="${picks.includes(c)}">${esc(c)}</button>`).join("")}</div>
      <p class="err" id="rh-err"></p>
      <div class="k-actions rh-actions"><button class="${bc} primary" id="rh-sug">Suggest a review</button><button class="${bc}" id="rh-own">Write my own</button><button class="${bc} ghost" id="rh-skip">Skip, go to Google</button></div>`;
    el.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { const c = b.dataset.c; picks = picks.includes(c) ? picks.filter((x) => x !== c) : [...picks, c]; b.setAttribute("aria-pressed", picks.includes(c)); }));
    el.querySelector("#rh-skip").onclick = () => opts.onSkip();
    el.querySelector("#rh-own").onclick = () => { mode = "own"; write(); };
    el.querySelector("#rh-sug").onclick = async (e) => {
      if (!picks.length) { el.querySelector("#rh-err").textContent = "Tap at least one thing you liked, or write your own."; return; }
      e.target.disabled = true; e.target.textContent = "Writing suggestions…";
      mode = "sug"; options = await getSuggestions(opts.slug, opts.bizName, picks, opts.rating || 5, place); pick = 0; choose();
    };
  };
  const write = () => {
    el.innerHTML = `<${H} class="${hc}">So glad you enjoyed it! 😊</${H}>
      <p class="${sc}">Would you share a few words about ${esc(opts.bizName)} on Google? Write it your way. We'll only fix spelling and grammar, and you choose what gets posted.</p>
      <textarea id="rh-text" class="rh-text" maxlength="1500" placeholder="What did you like about your visit?" aria-label="Your review in your own words">${esc(text)}</textarea>
      <p class="err" id="rh-err"></p>
      <div class="k-actions rh-actions"><button class="${bc} primary" id="rh-go">Tidy my words</button><button class="${bc} ghost" id="rh-skip">Back</button></div>`;
    el.querySelector("#rh-skip").onclick = like;
    el.querySelector("#rh-go").onclick = async (e) => {
      text = el.querySelector("#rh-text").value.trim();
      if (text.length < 8) { el.querySelector("#rh-err").textContent = "Write a few words first, or tap Skip."; return; }
      e.target.disabled = true; e.target.textContent = "Tidying…";
      options = await reviewOptions(opts.slug, text); pick = 0; choose();
    };
  };
  const choose = () => {
    el.innerHTML = `<${H} class="${hc}">Pick the one you like</${H}>
      <p class="${sc}">${mode === "sug" ? "Edit it so it says what you really think. It's your review." : "All of these are your own words. You can edit the one you pick."}</p>
      <div class="rh-opts" role="radiogroup" aria-label="Review versions">${options.map((o, i) => `<button class="rh-opt" role="radio" aria-checked="${i === pick}" data-i="${i}"><small>${esc(o.label)}</small><span>${esc(o.text)}</span></button>`).join("")}</div>
      <textarea id="rh-final" class="rh-text" maxlength="4000" aria-label="Review to post">${esc(options[pick].text)}</textarea>
      <p class="small muted rh-hint">We'll copy it for you. On Google, tap the stars, then long-press the box and paste.</p>
      <div class="k-actions rh-actions"><button class="${bc} primary" id="rh-copy">Copy &amp; open Google</button><button class="${bc} ghost" id="rh-back">${mode === "sug" ? "Back" : "Change my words"}</button></div>`;
    el.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { pick = +b.dataset.i; choose(); }));
    el.querySelector("#rh-back").onclick = mode === "sug" ? like : write;
    el.querySelector("#rh-copy").onclick = (e) => {
      const t = el.querySelector("#rh-final").value.trim() || options[pick].text;
      copyText(t);                 // don't await: opening Google must happen inside the tap
      e.target.textContent = "Copied ✓ Opening Google…";
      opts.onOpen(t);
    };
  };
  like();
}
