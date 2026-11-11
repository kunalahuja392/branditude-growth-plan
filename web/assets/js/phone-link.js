// "Mobile login" card: link a mobile number to this login so you can sign in with a WhatsApp code.
import { sb } from "./sb.js";
import { esc, toast, prettyPhone, phoneInput, readPhone, phoneOk, phoneHint } from "./ui.js";

export function phoneLinkHTML(user) {
  const ph = user?.phone || "";
  return `<div class="card" style="max-width:820px;margin-top:16px" id="pl-card"><div class="card-head"><h2>Mobile login</h2>${ph ? '<span class="pill good">On</span>' : ""}</div>
    <p class="small muted" style="margin-top:-6px">${ph ? `You can sign in with a WhatsApp code sent to <b class="num">${esc(prettyPhone(ph))}</b>, as well as your email and password.` : "Add your mobile number to sign in with a code on WhatsApp instead of typing your password."}</p>
    <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap" id="pl-row"><div style="max-width:320px;flex:1">${phoneInput("pl-phone", { placeholder: "98xxxxxxxx" })}</div><button class="btn" id="pl-send" type="button">${ph ? "Change number" : "Send code"}</button></div>
    <div class="row" style="gap:8px;margin-top:8px" id="pl-otp" hidden><input id="pl-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="max-width:140px" aria-label="Code from WhatsApp"><button class="btn primary" id="pl-verify" type="button">Verify</button></div>
    <p class="err" id="pl-err"></p></div>`;
}
export function bindPhoneLink(onDone) {
  const $ = (s) => document.querySelector(s); if (!$("#pl-card")) return;
  let phone = "";
  $("#pl-send").onclick = async (e) => {
    $("#pl-err").textContent = ""; const n = readPhone("pl-phone");
    if (!phoneOk(n)) { $("#pl-err").textContent = phoneHint(n); return; }
    phone = "+" + n; e.target.disabled = true;
    const { error } = await sb.auth.updateUser({ phone });
    e.target.disabled = false;
    if (error) { $("#pl-err").textContent = /already/i.test(error.message) ? "This number is already used by another login." : error.message; return; }
    $("#pl-otp").hidden = false; $("#pl-code").focus(); toast("Code sent on WhatsApp to " + phone);
  };
  $("#pl-verify").onclick = async (e) => {
    $("#pl-err").textContent = ""; const token = $("#pl-code").value.replace(/\D/g, "");
    if (!phone) { $("#pl-err").textContent = "Tap Send code first."; return; }
    if (token.length !== 6) { $("#pl-err").textContent = "Enter the 6-digit code from WhatsApp."; return; }
    e.target.disabled = true;
    const { error } = await sb.auth.verifyOtp({ phone, token, type: "phone_change" });
    e.target.disabled = false;
    if (error) { $("#pl-err").textContent = "That code didn't work. Check it and try again."; return; }
    toast("Mobile login is on"); onDone && onDone();
  };
}
