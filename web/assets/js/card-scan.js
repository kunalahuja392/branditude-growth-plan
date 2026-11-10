// Scan a customer's digital loyalty card QR with the device camera. Resolves to the card token, or null.
// Uses the built-in BarcodeDetector (Android Chrome) and falls back to jsQR (iPhone Safari, desktop).
import { openModal, closeModal, esc } from "./ui.js";

const tokenFrom = (text) => {
  const s = String(text || "").trim();
  try { const u = new URL(s); const t = u.searchParams.get("t"); if (t) return t; } catch {}
  return /^[a-f0-9]{16,40}$/i.test(s) ? s.toLowerCase() : null;
};

let jsQR = null;
async function loadJsQR() {
  if (jsQR) return jsQR;
  const m = await import("https://esm.sh/jsqr@1.4.0");
  return (jsQR = m.default || m);
}

export function scanCard() {
  return new Promise((resolve) => {
    let stream = null, done = false, raf = 0;
    const finish = (tok) => {
      if (done) return; done = true; cancelAnimationFrame(raf);
      try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
      closeModal(); resolve(tok);
    };
    const m = openModal(`<div class="modal-head"><h2>Scan loyalty card</h2><button class="btn ghost" data-x>Close</button></div>
      <div class="scan-box"><video id="sc-v" playsinline muted></video><div class="scan-frame" aria-hidden="true"></div></div>
      <p class="small muted" id="sc-msg" style="text-align:center;margin-top:10px">Point the camera at the QR on the customer's card.</p>
      <form id="sc-f" class="row" style="margin-top:12px;gap:8px"><input id="sc-code" placeholder="Or paste the card link" aria-label="Card link or code" style="flex:1"><button class="btn">Find</button></form>
      <p class="err" id="sc-err"></p>`);
    m.querySelector("[data-x]").onclick = () => finish(null);
    m.querySelector("#sc-f").onsubmit = (e) => { e.preventDefault(); const t = tokenFrom(m.querySelector("#sc-code").value); if (t) finish(t); else m.querySelector("#sc-err").textContent = "That doesn't look like a card link."; };
    // stop the camera if the modal is closed some other way
    const obs = new MutationObserver(() => { if (!document.body.contains(m)) { obs.disconnect(); finish(null); } });
    obs.observe(document.body, { childList: true, subtree: true });

    (async () => {
      const v = m.querySelector("#sc-v"), msg = m.querySelector("#sc-msg");
      if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = "This browser can't open the camera. Paste the card link below instead."; return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }); }
      catch (e) { msg.innerHTML = e.name === "NotAllowedError" ? "Camera permission was blocked. Allow the camera for this site in your browser settings, or paste the card link below." : "Couldn't open the camera: " + esc(e.message); return; }
      if (done) return finish(null);
      v.srcObject = stream; await v.play().catch(() => {});
      let detect;
      if ("BarcodeDetector" in window) {
        try { const bd = new window.BarcodeDetector({ formats: ["qr_code"] }); detect = async () => (await bd.detect(v))[0]?.rawValue; } catch {}
      }
      if (!detect) {
        try { const fn = await loadJsQR(); const c = document.createElement("canvas"), x = c.getContext("2d", { willReadFrequently: true });
          detect = async () => { const w = v.videoWidth, h = v.videoHeight; if (!w) return null; const s = Math.min(1, 640 / w); c.width = w * s; c.height = h * s;
            x.drawImage(v, 0, 0, c.width, c.height); const r = fn(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: "dontInvert" }); return r?.data; };
        } catch { msg.textContent = "Scanner couldn't load. Paste the card link below instead."; return; }
      }
      let last = 0;
      const tick = async (t) => {
        if (done) return;
        if (t - last > 180) { last = t; try { const raw = await detect(); const tok = raw && tokenFrom(raw); if (tok) { navigator.vibrate?.(60); return finish(tok); } if (raw) msg.textContent = "That QR isn't a loyalty card. Try the card's QR."; } catch {} }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();
  });
}
