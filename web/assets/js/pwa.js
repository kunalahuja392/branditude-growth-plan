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

// "Install app / Add to Home Screen" popup, worded for this device.
// Chrome/Edge (Android, Windows, Mac) get the browser's own install prompt; iPhone/iPad get Safari's Share steps.
// Shows once, then not again for 7 days after "Not now". Never shows inside the installed app.
(function () {
  const onApp = /\/app\.html$/.test(location.pathname), onStore = /^\/(index\.html)?$/.test(location.pathname);
  if (!onApp && !onStore) return;
  const KEY = "bgp_install_popup_until";
  const snoozed = () => { try { return +(localStorage.getItem(KEY) || 0) > Date.now() || localStorage.getItem("bgp_installed"); } catch { return false; } };
  if (snoozed()) return;
  const ua = navigator.userAgent, plat = navigator.userAgentData?.platform || navigator.platform || "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(plat) && navigator.maxTouchPoints > 1);
  const iosSafari = ios && !/CriOS|FxiOS|EdgiOS|GSA\//.test(ua);
  const android = /Android/i.test(ua), win = /Win/i.test(plat), mac = !ios && /Mac/i.test(plat);
  const where = ios || android ? "home screen" : win ? "Start menu and desktop" : "Dock";
  let el = null, shown = false;
  const css = `.bgp-pop-back{position:fixed;inset:0;z-index:70;background:rgba(10,14,30,.55);display:grid;place-items:center;padding:16px;animation:bgpFade .25s ease}
  .bgp-pop{width:min(420px,100%);background:#fff;color:#10183a;border-radius:24px;padding:26px 24px 20px;box-shadow:0 30px 80px rgba(0,0,0,.4);font:500 15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;animation:bgpUp .35s cubic-bezier(.2,.8,.2,1)}
  .bgp-pop img{width:72px;height:72px;border-radius:18px;box-shadow:0 10px 24px rgba(240,122,26,.35)}
  .bgp-pop h2{font:800 21px/1.25 system-ui,sans-serif;margin:14px 0 6px;letter-spacing:-.01em}
  .bgp-pop p{margin:0;color:#464f6c}
  .bgp-pop ul{list-style:none;padding:0;margin:14px 0 4px;display:flex;justify-content:center;gap:8px;flex-wrap:wrap}
  .bgp-pop ul li{font-size:12.5px;font-weight:700;background:#eceef4;color:#464f6c;border-radius:99px;padding:5px 10px}
  .bgp-pop ol{text-align:left;margin:16px 0 0;padding:14px 16px 14px 36px;background:#f4f5f9;border-radius:16px;display:grid;gap:8px;color:#10183a}
  .bgp-pop .shr{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:6px;background:#fff;border:1px solid #e2e4ec;vertical-align:-6px;margin:0 2px}
  .bgp-pop .row{display:flex;gap:10px;margin-top:20px}
  .bgp-pop button{flex:1;border:0;border-radius:14px;padding:13px 14px;font:700 15px system-ui,sans-serif;cursor:pointer}
  .bgp-pop .go{background:#f07a1a;color:#fff;box-shadow:0 10px 24px -8px rgba(240,122,26,.8)}
  .bgp-pop .no{background:#eceef4;color:#10183a}
  .bgp-pop button:focus-visible{outline:3px solid #2b4cff;outline-offset:2px}
  @media (max-width:520px){.bgp-pop-back{place-items:end center;padding:0}.bgp-pop{border-radius:24px 24px 0 0;padding-bottom:max(20px,env(safe-area-inset-bottom));animation:bgpSheet .35s cubic-bezier(.2,.8,.2,1)}}
  @keyframes bgpFade{from{opacity:0}}@keyframes bgpUp{from{opacity:0;transform:translateY(18px) scale(.97)}}@keyframes bgpSheet{from{transform:translateY(100%)}}
  @media (prefers-reduced-motion:reduce){.bgp-pop-back,.bgp-pop{animation:none}}`;
  const shareIc = `<span class="shr" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0a84ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 12v8h14v-8"/></svg></span>`;
  function steps() {
    if (iosSafari) return `<ol><li>Tap ${shareIc} <b>Share</b> at the bottom of Safari.</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>. Branditude appears on your home screen.</li></ol>`;
    if (ios) return `<ol><li>Open <b>scale.branditudeglobal.com</b> in <b>Safari</b>.</li><li>Tap ${shareIc} <b>Share</b>, then <b>Add to Home Screen</b>.</li></ol>`;
    if (android) return `<ol><li>Tap the <b>⋮</b> menu at the top right.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li></ol>`;
    if (mac && /Safari/.test(ua) && !/Chrome|Edg/.test(ua)) return `<ol><li>In the menu bar choose <b>File</b>.</li><li>Click <b>Add to Dock</b>.</li></ol>`;
    return "";
  }
  const close = (snooze) => { el?.remove(); el = null; if (snooze) try { localStorage.setItem(KEY, String(Date.now() + 7 * 864e5)); } catch {} };
  function show(canPrompt) {
    if (shown || el || snoozed() || window.bgpInstall.state().installed || document.querySelector(".modal-back,.back")) return;
    const how = canPrompt ? "" : steps(); if (!canPrompt && !how) return;   // nothing useful to offer on this browser
    shown = true;
    if (!document.getElementById("bgp-pop-css")) { const s = document.createElement("style"); s.id = "bgp-pop-css"; s.textContent = css; document.head.append(s); }
    el = document.createElement("div"); el.className = "bgp-pop-back";
    el.innerHTML = `<div class="bgp-pop" role="dialog" aria-modal="true" aria-labelledby="bgp-pop-t"><img src="/assets/icons/icon-192.png" alt="">
      <h2 id="bgp-pop-t">${canPrompt ? "Install the Branditude app" : "Add Branditude to your " + where}</h2>
      <p>${onApp ? "Open your dashboard in one tap, full-screen and faster." : "Your reviews, customers and offers in one tap, full-screen and faster."}</p>
      <ul><li>One-tap open</li><li>No browser bar</li><li>Loads faster</li></ul>${how}
      <div class="row">${canPrompt ? `<button class="no" type="button">Not now</button><button class="go" type="button">Install app</button>` : `<button class="no" type="button">Got it</button>`}</div></div>`;
    el.addEventListener("click", (e) => { if (e.target === el) close(true); });
    el.querySelector(".no").onclick = () => close(true);
    const go = el.querySelector(".go");
    if (go) go.onclick = async () => { const r = await window.bgpInstall.prompt(); close(r !== "accepted"); };
    el.addEventListener("keydown", (e) => { if (e.key === "Escape") close(true); });
    document.body.append(el); if (matchMedia("(hover: hover)").matches) (go || el.querySelector(".no")).focus();
  }
  const wait = onApp ? 4000 : 12000;
  addEventListener("load", () => setTimeout(() => window.bgpInstall.onChange((st) => (st.installed ? close(false) : show(st.canPrompt))), wait));
  window.bgpInstall.showPopup = () => { shown = false; try { localStorage.removeItem(KEY); } catch {} show(window.bgpInstall.state().canPrompt); };
})();
