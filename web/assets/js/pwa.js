// Registers the service worker and exposes the browser's install prompt to the page.
// window.bgpInstall.prompt() returns "accepted" | "dismissed" | "unavailable".
let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((f) => f(state()));
const standalone = () => matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches || navigator.standalone === true;
const state = () => ({ canPrompt: !!deferred, installed: standalone() });
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; notify(); });
addEventListener("appinstalled", () => { deferred = null; try { localStorage.setItem("bgp_installed", "1"); } catch {} notify(); });
if ("serviceWorker" in navigator && location.protocol === "https:") addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
window.bgpInstall = {
  state, onChange: (f) => { listeners.add(f); f(state()); },
  async prompt() { if (!deferred) return "unavailable"; deferred.prompt(); const { outcome } = await deferred.userChoice; deferred = null; notify(); return outcome; },
};

// Dashboard nudge: a small "Install app" card in the signed-in app, worded for this device.
// Android/Windows/Mac Chromium use the browser's own prompt; iPhone/iPad get the Share steps.
(function () {
  if (!/\/app\.html$/.test(location.pathname)) return;
  const KEY = "bgp_install_nudge_hidden";
  try { if (localStorage.getItem(KEY) || localStorage.getItem("bgp_installed")) return; } catch {}
  const ua = navigator.userAgent, plat = navigator.userAgentData?.platform || navigator.platform || "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(plat) && navigator.maxTouchPoints > 1);
  const iosSafari = ios && !/CriOS|FxiOS|EdgiOS/.test(ua);
  const where = ios ? "home screen" : /Android/i.test(ua) ? "home screen" : /Win/i.test(plat) ? "Start menu" : "Dock";
  let el = null;
  const css = `.bgp-nudge{position:fixed;z-index:60;right:16px;bottom:max(16px,env(safe-area-inset-bottom));max-width:340px;background:#10183a;color:#f6f7fb;border-radius:18px;padding:16px 16px 14px;box-shadow:0 20px 50px rgba(0,0,0,.35);font:500 14px/1.45 system-ui,sans-serif;display:grid;grid-template-columns:44px 1fr;gap:4px 12px;animation:bgpIn .35s cubic-bezier(.2,.8,.2,1)}
  .bgp-nudge img{width:44px;height:44px;border-radius:11px;grid-row:span 2}.bgp-nudge b{font-size:15px}.bgp-nudge p{margin:0;color:#aab2cc}
  .bgp-nudge .row{grid-column:1/-1;display:flex;gap:8px;margin-top:10px}.bgp-nudge button{flex:1;border:0;border-radius:11px;padding:10px 12px;font:700 14px system-ui,sans-serif;cursor:pointer}
  .bgp-nudge .go{background:#f07a1a;color:#fff}.bgp-nudge .no{background:rgba(255,255,255,.1);color:#fff}
  @media (max-width:520px){.bgp-nudge{left:12px;right:12px;max-width:none;bottom:max(84px,env(safe-area-inset-bottom))}}
  @keyframes bgpIn{from{opacity:0;transform:translateY(16px)}}@media (prefers-reduced-motion:reduce){.bgp-nudge{animation:none}}`;
  const hide = (forever) => { el?.remove(); el = null; if (forever) try { localStorage.setItem(KEY, "1"); } catch {} };
  const show = (canPrompt) => {
    if (el || window.bgpInstall.state().installed) return;
    if (!canPrompt && !iosSafari) return; // nothing useful to offer on this browser
    if (!document.getElementById("bgp-nudge-css")) { const s = document.createElement("style"); s.id = "bgp-nudge-css"; s.textContent = css; document.head.append(s); }
    el = document.createElement("div"); el.className = "bgp-nudge"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Install the app");
    el.innerHTML = canPrompt
      ? `<img src="/assets/icons/icon-192.png" alt=""><b>Install Branditude Growth</b><p>Open it from your ${where} like any app, full-screen and faster.</p><div class="row"><button class="go" type="button">Install app</button><button class="no" type="button">Not now</button></div>`
      : `<img src="/assets/icons/icon-192.png" alt=""><b>Add to your home screen</b><p>Tap <b>Share</b> ⬆︎ at the bottom of Safari, then <b>Add to Home Screen</b>.</p><div class="row"><button class="no" type="button">Got it</button></div>`;
    el.querySelector(".no").onclick = () => hide(true);
    const go = el.querySelector(".go"); if (go) go.onclick = async () => { const r = await window.bgpInstall.prompt(); hide(r === "accepted"); };
    document.body.append(el);
  };
  addEventListener("load", () => setTimeout(() => window.bgpInstall.onChange((st) => (st.installed ? hide(false) : show(st.canPrompt))), 4000));
})();
