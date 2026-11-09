// Business portal: QR menu (#menu) and live orders (#orders)
import { sb, q } from "./sb.js";
import { $, esc, inr, inr2, toast, openModal, closeModal, confirmBox, formModal, ico, copy, ago } from "./ui.js";
import { printHTML, loadXLSX, downloadCSV } from "./staff.js";

const FOOD = { veg: "Veg", nonveg: "Non-veg", egg: "Egg", na: "Not applicable" };
let A;
const M = { tab: "items", d: null, search: "", preview: null, mode: "merge" };
const O = { list: [], seen: null, timer: null, sound: true };
const ctx = () => A.ctx();
const can = () => ctx().canWrite;
const slug = () => ctx().D.biz.slug;
const menuLink = (tableId) => new URL(`m.html?b=${encodeURIComponent(slug())}${tableId ? `&t=${tableId}` : ""}`, location.href).href;
export const foodMark = (t) => (t === "veg" || t === "nonveg" || t === "egg" ? `<span class="fmark fm-${t}" title="${FOOD[t]}"></span>` : "");

async function load() {
  const BID = ctx().BID;
  const [settings, cats, items, tables] = await Promise.all([
    q(sb.from("menu_settings").select("*").eq("business_id", BID).maybeSingle()),
    q(sb.from("menu_categories").select("*").eq("business_id", BID).order("sort").order("name")),
    q(sb.from("menu_items").select("*").eq("business_id", BID).order("sort").order("name")),
    q(sb.from("dining_tables").select("*").eq("business_id", BID).order("sort").order("label")),
  ]);
  M.d = { settings: settings || { ordering_on: true, show_prices: true, note: "" }, cats, items, tables };
}

/* =================== Menu =================== */
function drawMenu() {
  const el = $("#menu-view"); if (!el) return;
  const tabs = [["items", "Menu items"], ["tables", "Tables & QR codes"], ["import", "Bulk upload (Excel)"], ["settings", "Settings"]];
  el.innerHTML = A.head("QR menu", "Your menu with photos. Each table gets its own QR code; customers scan it, browse and order, and the order appears on the Orders screen.",
    `<a class="btn" href="${esc(menuLink())}" target="_blank" rel="noopener">Open menu</a><button class="btn primary" data-mn="item-new" ${can() ? "" : "disabled"}>${ico("plus")} Add item</button>`) +
    `<div class="tabs" role="tablist" style="margin-bottom:16px;max-width:720px">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${M.tab === k}" data-mn-tab="${k}">${l}</button>`).join("")}</div>
     <div id="mn-body">${({ items: tabItems, tables: tabTables, import: tabImport, settings: tabSettings })[M.tab]()}</div>`;
  if (M.tab === "tables") renderTableQRs();
  if (M.tab === "import") wireImport();
}

function tabItems() {
  const { cats, items } = M.d, s = M.search.toLowerCase();
  const match = (i) => !s || i.name.toLowerCase().includes(s) || (i.description || "").toLowerCase().includes(s);
  const groups = [...cats.map((c) => [c, items.filter((i) => i.category_id === c.id && match(i))]), [null, items.filter((i) => !i.category_id && match(i))]].filter(([c, l]) => c || l.length);
  if (!items.length && !cats.length) return `<div class="card empty"><p>Your menu is empty.</p><div class="row" style="justify-content:center"><button class="btn primary" data-mn="item-new" ${can() ? "" : "disabled"}>Add the first item</button><button class="btn" data-mn-tab="import">Upload from Excel</button></div></div>`;
  return `<div class="row" style="margin-bottom:12px"><input id="mn-search" placeholder="Search items" value="${esc(M.search)}" style="max-width:280px"><button class="btn sm" data-mn="cat-new" ${can() ? "" : "disabled"}>${ico("plus")} Category</button>
      <span class="small muted" style="margin-left:auto">${items.length} items · ${items.filter((i) => !i.available).length} sold out</span></div>
    ${groups.map(([c, list]) => `<div class="card" style="margin-bottom:14px;${c && !c.active ? "opacity:.6" : ""}"><div class="card-head"><h2>${c ? esc(c.name) : "No category"} <span class="muted small">${list.length}</span></h2>
      ${c ? `<div class="row">${c.active ? "" : '<span class="pill">Hidden</span>'}<button class="btn sm ghost" data-mn="cat-edit" data-id="${c.id}">Edit</button></div>` : ""}</div>
      ${list.length ? `<div class="list">${list.map((i) => `<div class="item mn-item">
        <div class="mn-thumb">${i.image_url ? `<img src="${esc(i.image_url)}" alt="" loading="lazy">` : `<span>${esc(i.name.slice(0, 1))}</span>`}</div>
        <div class="grow"><b>${foodMark(i.food_type)} ${esc(i.name)}${i.bestseller ? ' <span class="pill acc">Bestseller</span>' : ""}</b><span class="muted small">${esc(i.description || "")}</span></div>
        <b class="num">${inr2(i.price)}</b>
        <label class="check small" title="Show as available"><input type="checkbox" data-mn="avail" data-id="${i.id}" ${i.available ? "checked" : ""} ${can() ? "" : "disabled"}> ${i.available ? "Available" : "Sold out"}</label>
        <button class="btn sm ghost" data-mn="item-edit" data-id="${i.id}">Edit</button></div>`).join("")}</div>` : `<div class="empty small">No items${s ? " match" : ""}.</div>`}</div>`).join("")}`;
}

function tabTables() {
  const t = M.d.tables;
  return `<div class="card" style="margin-bottom:16px"><form id="tbl-form" class="row" style="flex-wrap:wrap;align-items:flex-end">
      <div class="field"><label for="tb-prefix">Name</label><input id="tb-prefix" value="Table " style="width:130px"></div>
      <div class="field"><label for="tb-from">From</label><input id="tb-from" type="number" min="1" value="${t.length + 1}" style="width:90px"></div>
      <div class="field"><label for="tb-to">To</label><input id="tb-to" type="number" min="1" value="${t.length + 10}" style="width:90px"></div>
      <button class="btn primary" ${can() ? "" : "disabled"}>Add tables</button>
      <button type="button" class="btn" data-mn="print-all" ${t.length ? "" : "disabled"}>Print all QR codes</button></form>
      <p class="small muted" style="margin-top:8px">Creates "Table 1", "Table 2"… Use any names: "Garden 1", "AC hall 3", "Room 204".</p></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">
      <div class="card tbl-card"><b>Counter / takeaway</b><div class="tbl-qr" data-qr="${esc(menuLink())}"></div><span class="small muted">No table number. Use at the counter or on the door.</span>
        <div class="row"><button class="btn sm" data-mn="qr-png" data-label="Counter">Download</button><button class="btn sm ghost" data-mn="qr-copy" data-link="${esc(menuLink())}">Copy link</button></div></div>
      ${t.map((x) => `<div class="card tbl-card" style="${x.active ? "" : "opacity:.55"}"><b>${esc(x.label)}${x.active ? "" : " · hidden"}</b><div class="tbl-qr" data-qr="${esc(menuLink(x.id))}"></div>
        <div class="row"><button class="btn sm" data-mn="qr-png" data-label="${esc(x.label)}">Download</button><button class="btn sm ghost" data-mn="qr-copy" data-link="${esc(menuLink(x.id))}">Copy link</button><button class="btn sm ghost" data-mn="tbl-edit" data-id="${x.id}">Edit</button></div></div>`).join("")}
    </div>`;
}
function renderTableQRs() { if (!window.QRCode) return; document.querySelectorAll(".tbl-qr[data-qr]").forEach((el) => { el.innerHTML = ""; new QRCode(el, { text: el.dataset.qr, width: 150, height: 150, colorDark: "#16203a", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M }); }); }
const qrData = (card) => card.querySelector(".tbl-qr canvas")?.toDataURL("image/png") || card.querySelector(".tbl-qr img")?.src;

/* ---------- Excel / CSV import ---------- */
const COLS = [
  ["Category", "Yes", "Starters", "Created if it doesn't exist. Items show in the order categories first appear."],
  ["Item name", "Yes", "Paneer tikka", "Same category + name updates the existing item."],
  ["Price", "Yes", "240", "Numbers only, no ₹ sign."],
  ["Description", "No", "Smoky cottage cheese, mint chutney", "Short line shown under the name."],
  ["Type", "No", "Veg", "Veg, Non-veg, Egg, or leave blank."],
  ["Image link", "No", "https://…/paneer.jpg", "A web link to a photo. You can also add photos later in the app."],
  ["Available", "No", "Yes", "Yes / No. Blank = Yes."],
  ["Bestseller", "No", "No", "Yes / No."],
  ["Sort order", "No", "10", "Smaller numbers show first inside a category."],
];
function tabImport() {
  return `<div class="grid g2"><div class="card"><div class="card-head"><h2>1. Download the template</h2></div>
      <p class="small">Fill one row per dish. Keep the first row (the column names) as it is.</p>
      <div class="row"><a class="btn primary" href="assets/templates/menu-template.xlsx" download>Excel template (.xlsx)</a><a class="btn" href="assets/templates/menu-template.csv" download>CSV template</a>
        <button class="btn ghost" data-mn="export-menu" ${M.d.items.length ? "" : "disabled"}>Download my current menu</button></div>
      <p class="small muted" style="margin-top:8px">Tip: download your current menu, change prices in Excel, and upload it again to update everything at once.</p></div>
    <div class="card"><div class="card-head"><h2>2. Upload the filled file</h2></div>
      <input type="file" id="imp-file" accept=".xlsx,.xls,.csv" ${can() ? "" : "disabled"}>
      <div class="field" style="margin-top:12px"><label>When importing</label>
        <label class="check"><input type="radio" name="imp-mode" value="merge" ${M.mode === "merge" ? "checked" : ""}> Add new dishes and update matching ones (keeps everything else)</label>
        <label class="check"><input type="radio" name="imp-mode" value="replace" ${M.mode === "replace" ? "checked" : ""}> Replace my whole menu with this file</label></div></div></div>
    <div id="imp-preview" style="margin-top:16px">${M.preview ? previewHTML() : ""}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>File format</h2></div><div class="table-wrap"><table><thead><tr><th>Column</th><th>Required</th><th>Example</th><th>Notes</th></tr></thead><tbody>
      ${COLS.map(([c, r, e, n]) => `<tr><td><b>${c}</b></td><td>${r}</td><td class="small">${esc(e)}</td><td class="small muted">${n}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted" style="margin-top:8px">Column names can be in any order and aren't case-sensitive. "Name", "Dish" and "Rate" also work.</p></div>`;
}
const ALIASES = { category: ["category", "section", "menu section"], name: ["item name", "item", "name", "dish", "dish name"], price: ["price", "rate", "mrp", "amount"],
  description: ["description", "desc", "details"], type: ["type", "veg/non-veg", "veg", "food type"], image: ["image link", "image", "image url", "photo", "photo link"],
  available: ["available", "in stock"], bestseller: ["bestseller", "best seller", "popular"], sort: ["sort order", "sort", "order"] };
const yes = (v, dflt) => { const s = String(v ?? "").trim().toLowerCase(); if (!s) return dflt; return ["yes", "y", "true", "1", "available", "haan"].includes(s); };
function parseType(v) { const s = String(v ?? "").trim().toLowerCase().replace(/[\s_-]/g, ""); if (!s) return "na"; if (s.startsWith("non") || s === "nv") return "nonveg"; if (s.startsWith("egg")) return "egg"; if (s.startsWith("veg") || s === "v") return "veg"; return null; }
export function parseCSV(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; continue; }
    if (ch === '"') inQ = true; else if (ch === ",") { row.push(cur); cur = ""; } else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}
export function normaliseRows(aoa, existing) {
  if (!aoa.length) throw new Error("The file is empty");
  const head = aoa[0].map((h) => String(h ?? "").trim().toLowerCase().replace(/\*$/, "").trim());
  const col = Object.fromEntries(Object.entries(ALIASES).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
  if (col.name < 0 || col.price < 0) throw new Error("Couldn't find the 'Item name' and 'Price' columns. Use the template's first row.");
  const keyOf = (cat, name) => `${cat.trim().toLowerCase()}|${name.trim().toLowerCase()}`;
  const seen = new Set();
  return aoa.slice(1).map((r, i) => {
    const g = (k) => (col[k] >= 0 ? r[col[k]] : "");
    const row = { line: i + 2, category: String(g("category") ?? "").trim() || "Others", name: String(g("name") ?? "").trim(), description: String(g("description") ?? "").trim(),
      price: Number(String(g("price") ?? "").replace(/[₹,\s]/g, "")), food_type: parseType(g("type")), image_url: String(g("image") ?? "").trim(),
      available: yes(g("available"), true), bestseller: yes(g("bestseller"), false), sort: g("sort") === "" || g("sort") == null ? 100 : Number(g("sort")), errors: [] };
    if (!row.name) row.errors.push("Item name missing");
    if (!Number.isFinite(row.price) || row.price < 0 || String(g("price") ?? "").trim() === "") row.errors.push("Price must be a number");
    if (row.food_type === null) row.errors.push("Type must be Veg, Non-veg or Egg");
    if (row.image_url && !/^https?:\/\//i.test(row.image_url)) row.errors.push("Image link must start with http");
    if (!Number.isFinite(row.sort)) row.sort = 100;
    const k = keyOf(row.category, row.name);
    if (row.name && seen.has(k)) row.errors.push("Same dish appears twice in the file");
    seen.add(k); row.match = existing.get(k) || null; return row;
  });
}
function previewHTML() {
  const p = M.preview, ok = p.rows.filter((r) => !r.errors.length), bad = p.rows.length - ok.length, upd = ok.filter((r) => r.match).length;
  return `<div class="card"><div class="card-head"><h2>Check before importing · ${esc(p.file)}</h2><div class="row"><button class="btn" data-mn="imp-cancel">Cancel</button><button class="btn primary" data-mn="imp-go" ${ok.length && can() ? "" : "disabled"}>Import ${ok.length} dish${ok.length === 1 ? "" : "es"}</button></div></div>
    <p class="small">${ok.length - upd} new · ${upd} will be updated${bad ? ` · <b style="color:var(--bad)">${bad} row${bad === 1 ? "" : "s"} with problems will be skipped</b>` : ""}${M.mode === "replace" ? ` · <b>Your current menu (${M.d.items.length} items) will be replaced.</b>` : ""}</p>
    <div class="table-wrap"><table><thead><tr><th>Row</th><th>Category</th><th>Item</th><th>Price</th><th>Type</th><th>Available</th><th>Result</th></tr></thead><tbody>
    ${p.rows.slice(0, 300).map((r) => `<tr style="${r.errors.length ? "background:var(--bad-soft)" : ""}"><td class="num">${r.line}</td><td>${esc(r.category)}</td><td>${esc(r.name)}${r.image_url ? " 📷" : ""}</td><td class="num">${Number.isFinite(r.price) ? inr2(r.price) : "—"}</td>
      <td>${r.food_type ? FOOD[r.food_type] : "?"}</td><td>${r.available ? "Yes" : "No"}</td><td>${r.errors.length ? `<span style="color:var(--bad)">${esc(r.errors.join("; "))}</span>` : r.match ? '<span class="pill info">Update</span>' : '<span class="pill good">New</span>'}</td></tr>`).join("")}
    </tbody></table></div>${p.rows.length > 300 ? `<p class="small muted">Showing the first 300 of ${p.rows.length} rows.</p>` : ""}</div>`;
}
function wireImport() {
  const f = $("#imp-file"); if (!f) return;
  document.querySelectorAll('[name="imp-mode"]').forEach((r) => (r.onchange = () => { M.mode = r.value; if (M.preview) $("#imp-preview").innerHTML = previewHTML(); }));
  f.onchange = async () => {
    const file = f.files[0]; if (!file) return;
    try {
      let aoa;
      if (/\.csv$/i.test(file.name)) aoa = parseCSV(await file.text());
      else { const X = await loadXLSX(); const wb = X.read(await file.arrayBuffer()); aoa = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false }); }
      const catName = Object.fromEntries(M.d.cats.map((c) => [c.id, c.name]));
      const existing = new Map(M.d.items.map((i) => [`${(catName[i.category_id] || "Others").toLowerCase()}|${i.name.toLowerCase()}`, i]));
      M.preview = { file: file.name, rows: normaliseRows(aoa, M.mode === "replace" ? new Map() : existing) };
      $("#imp-preview").innerHTML = previewHTML();
    } catch (e) { toast(e.message, "error"); f.value = ""; }
  };
}
async function runImport() {
  const BID = ctx().BID, rows = M.preview.rows.filter((r) => !r.errors.length);
  if (M.mode === "replace" && !(await confirmBox("Replace your whole menu?", `This deletes your current ${M.d.items.length} items and their photos links, then adds the ${rows.length} dishes from the file. Past orders are kept.`, "Replace menu", { danger: true }))) return;
  if (M.mode === "replace") { await q(sb.from("menu_items").delete().eq("business_id", BID)); await q(sb.from("menu_categories").delete().eq("business_id", BID)); M.d.cats = []; }
  const catId = new Map(M.d.cats.map((c) => [c.name.toLowerCase(), c.id]));
  const newCats = [...new Set(rows.map((r) => r.category))].filter((n) => !catId.has(n.toLowerCase()));
  const base = Math.max(0, ...M.d.cats.map((c) => c.sort || 0));
  if (newCats.length) (await q(sb.from("menu_categories").insert(newCats.map((name, i) => ({ business_id: BID, name, sort: base + (i + 1) * 10 }))).select("id,name"))).forEach((c) => catId.set(c.name.toLowerCase(), c.id));
  const toRow = (r) => ({ business_id: BID, category_id: catId.get(r.category.toLowerCase()), name: r.name, description: r.description, price: r.price, food_type: r.food_type, available: r.available, bestseller: r.bestseller, sort: r.sort, ...(r.image_url ? { image_url: r.image_url } : {}), updated_at: new Date().toISOString() });
  const fresh = rows.filter((r) => !r.match), upd = rows.filter((r) => r.match);
  for (let i = 0; i < fresh.length; i += 200) await q(sb.from("menu_items").insert(fresh.slice(i, i + 200).map(toRow)));
  for (const r of upd) await q(sb.from("menu_items").update(toRow(r)).eq("id", r.match.id));
  toast(`Imported: ${fresh.length} new, ${upd.length} updated`); M.preview = null; M.tab = "items"; await load(); drawMenu();
}
async function exportMenu() {
  const catName = Object.fromEntries(M.d.cats.map((c) => [c.id, c.name]));
  const rows = [COLS.map((c) => c[0]), ...M.d.items.map((i) => [catName[i.category_id] || "Others", i.name, +i.price, i.description, { veg: "Veg", nonveg: "Non-veg", egg: "Egg" }[i.food_type] || "", i.image_url, i.available ? "Yes" : "No", i.bestseller ? "Yes" : "No", i.sort])];
  try { const X = await loadXLSX(); const ws = X.utils.aoa_to_sheet(rows); ws["!cols"] = [16, 26, 8, 40, 9, 40, 10, 10, 10].map((w) => ({ wch: w })); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, "Menu"); X.writeFile(wb, "My menu.xlsx"); }
  catch { downloadCSV(rows, "My menu.csv"); }
}

function tabSettings() {
  const s = M.d.settings;
  return `<div class="card" style="max-width:640px"><form id="mset-form" class="fields">
    <label class="check" style="grid-column:1/-1"><input type="checkbox" id="ms-order" ${s.ordering_on ? "checked" : ""}> Customers can place orders from the table</label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" id="ms-prices" ${s.show_prices ? "checked" : ""}> Show prices on the menu</label>
    <div class="field" style="grid-column:1/-1"><label for="ms-note">Note at the bottom of the menu</label><input id="ms-note" value="${esc(s.note || "")}" placeholder="All prices include GST · Please tell us about allergies"></div>
    <div class="row" style="grid-column:1/-1"><button class="btn primary" ${can() ? "" : "disabled"}>Save</button></div></form>
    <p class="small muted" style="margin-top:10px">With ordering off, the QR still shows your menu with photos, and customers order with the staff as usual.</p></div>`;
}

/* ---------- item form with photo ---------- */
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file); const k = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
}
function itemForm(it = {}) {
  const cats = M.d.cats, isNew = !it.id;
  const m = openModal(`<div class="modal-head"><h2>${isNew ? "Add item" : "Edit item"}</h2><button class="btn ghost" data-close>Close</button></div>
    <form id="it-form"><div class="fields">
      <div class="field"><label for="it-name">Name</label><input id="it-name" required value="${esc(it.name || "")}"></div>
      <div class="field"><label for="it-price">Price ₹</label><input id="it-price" type="number" min="0" step="0.5" required value="${esc(it.price ?? "")}"></div>
      <div class="field"><label for="it-cat">Category</label><select id="it-cat">${cats.map((c) => `<option value="${c.id}" ${it.category_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}<option value="__new" ${!cats.length ? "selected" : ""}>+ New category…</option></select>
        <input id="it-newcat" placeholder="New category name" style="margin-top:6px;${cats.length ? "display:none" : ""}"></div>
      <div class="field"><label for="it-type">Type</label><select id="it-type">${Object.entries(FOOD).map(([k, l]) => `<option value="${k}" ${(it.food_type || "veg") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field" style="grid-column:1/-1"><label for="it-desc">Description</label><input id="it-desc" value="${esc(it.description || "")}" placeholder="Short line shown under the name"></div>
      <div class="field" style="grid-column:1/-1"><label>Photo</label><div class="row" style="align-items:flex-start"><div class="mn-thumb big" id="it-prev">${it.image_url ? `<img src="${esc(it.image_url)}" alt="">` : "<span>No photo</span>"}</div>
        <div class="grow" style="display:grid;gap:6px"><input type="file" id="it-file" accept="image/*"><input id="it-url" placeholder="or paste an image link (https://…)" value="${esc(it.image_url || "")}">${it.image_url ? '<button type="button" class="btn sm ghost" id="it-rmimg" style="justify-self:start">Remove photo</button>' : ""}
        <span class="small muted">Photos are resized automatically. Square or landscape photos look best.</span></div></div></div>
      <label class="check"><input type="checkbox" id="it-avail" ${it.available !== false ? "checked" : ""}> Available</label>
      <label class="check"><input type="checkbox" id="it-best" ${it.bestseller ? "checked" : ""}> Mark as bestseller</label>
      <div class="field"><label for="it-sort">Sort order</label><input id="it-sort" type="number" value="${esc(it.sort ?? 100)}"></div></div>
      <p class="err" id="it-err"></p>
      <div class="modal-foot">${isNew ? "" : '<button type="button" class="btn ghost" id="it-del" style="margin-right:auto;color:var(--bad)">Delete</button>'}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" ${can() ? "" : "disabled"}>${isNew ? "Add item" : "Save"}</button></div></form>`, { wide: true });
  const sel = m.querySelector("#it-cat"), nc = m.querySelector("#it-newcat"), file = m.querySelector("#it-file"), url = m.querySelector("#it-url"), prev = m.querySelector("#it-prev");
  sel.onchange = () => (nc.style.display = sel.value === "__new" ? "" : "none");
  file.onchange = () => { const f = file.files[0]; if (f) { prev.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`; url.value = ""; } };
  url.oninput = () => { if (url.value.startsWith("http")) prev.innerHTML = `<img src="${esc(url.value)}" alt="">`; };
  const rm = m.querySelector("#it-rmimg"); if (rm) rm.onclick = () => { url.value = ""; file.value = ""; prev.innerHTML = "<span>No photo</span>"; };
  const del = m.querySelector("#it-del"); if (del) del.onclick = async () => { if (!(await confirmBox(`Delete ${it.name}?`, "Past orders keep their details.", "Delete", { danger: true }))) return; await q(sb.from("menu_items").delete().eq("id", it.id)); toast("Deleted"); await load(); drawMenu(); };
  m.querySelector("#it-form").onsubmit = async (e) => {
    e.preventDefault(); const btn = e.submitter || m.querySelector('.modal-foot .primary'); btn.disabled = true; const err = m.querySelector("#it-err"); err.textContent = "";
    try {
      const BID = ctx().BID; let category_id = sel.value;
      if (category_id === "__new") {
        const name = nc.value.trim(); if (!name) throw new Error("Enter the new category name");
        const ex = M.d.cats.find((c) => c.name.toLowerCase() === name.toLowerCase());
        category_id = ex ? ex.id : (await q(sb.from("menu_categories").insert({ business_id: BID, name, sort: (Math.max(0, ...M.d.cats.map((c) => c.sort || 0)) + 10) }).select("id").single())).id;
      }
      let image_url = url.value.trim();
      if (file.files[0]) {
        btn.textContent = "Uploading photo…";
        const blob = await shrinkImage(file.files[0]); const path = `${BID}/${crypto.randomUUID()}.jpg`;
        const { error } = await sb.storage.from("menu").upload(path, blob, { contentType: "image/jpeg", upsert: false }); if (error) throw error;
        image_url = sb.storage.from("menu").getPublicUrl(path).data.publicUrl;
      }
      if (image_url && !/^https?:\/\//.test(image_url)) throw new Error("Image link must start with https://");
      const row = { business_id: BID, category_id, name: m.querySelector("#it-name").value.trim(), price: +m.querySelector("#it-price").value || 0, food_type: m.querySelector("#it-type").value,
        description: m.querySelector("#it-desc").value.trim(), image_url, available: m.querySelector("#it-avail").checked, bestseller: m.querySelector("#it-best").checked, sort: +m.querySelector("#it-sort").value || 100, updated_at: new Date().toISOString() };
      if (isNew) await q(sb.from("menu_items").insert(row)); else await q(sb.from("menu_items").update(row).eq("id", it.id));
      closeModal(); toast(isNew ? "Item added" : "Saved"); await load(); drawMenu();
    } catch (ex) { err.textContent = ex.message || String(ex); btn.disabled = false; btn.textContent = isNew ? "Add item" : "Save"; }
  };
}
function catForm(c = {}) {
  formModal({ title: c.id ? "Edit category" : "New category", values: { active: true, sort: (Math.max(0, ...M.d.cats.map((x) => x.sort || 0)) + 10), ...c },
    fields: [{ key: "name", label: "Name", required: true }, { key: "sort", label: "Order (smaller shows first)", type: "number" }, { key: "active", label: "Show on the menu", type: "checkbox" }],
    extraFoot: c.id ? `<button type="button" class="btn ghost" data-mn="cat-del" data-id="${c.id}" style="margin-right:auto;color:var(--bad)">Delete</button>` : "",
    onSave: async (v) => { const row = { name: v.name, sort: v.sort ?? 100, active: v.active };
      try { if (c.id) await q(sb.from("menu_categories").update(row).eq("id", c.id)); else await q(sb.from("menu_categories").insert({ ...row, business_id: ctx().BID })); }
      catch (e) { throw new Error(/menu_cat_uq|duplicate/i.test(e.message) ? "You already have a category with this name" : e.message); }
      toast("Saved"); await load(); drawMenu(); } });
}
function tableForm(t) {
  formModal({ title: `Edit ${t.label}`, values: t, fields: [{ key: "label", label: "Name", required: true }, { key: "sort", label: "Order", type: "number" }, { key: "active", label: "QR works (untick to stop orders from this table)", type: "checkbox" }],
    extraFoot: `<button type="button" class="btn ghost" data-mn="tbl-del" data-id="${t.id}" style="margin-right:auto;color:var(--bad)">Delete</button>`,
    onSave: async (v) => { await q(sb.from("dining_tables").update({ label: v.label, sort: v.sort ?? 100, active: v.active }).eq("id", t.id)); toast("Saved"); await load(); drawMenu(); } });
}

/* =================== Orders (kitchen screen) =================== */
const NEXT = { new: ["preparing", "Start preparing"], preparing: ["ready", "Mark ready"], ready: ["served", "Served"] };
async function loadOrders() {
  const since = new Date(Date.now() - 18 * 3600e3).toISOString();
  const orders = await q(sb.from("orders").select("*, order_items(name,qty,price,food_type)").eq("business_id", ctx().BID).gte("created_at", since).order("created_at", { ascending: false }).limit(300));
  const fresh = orders.filter((o) => o.status === "new").map((o) => o.id);
  if (O.seen && fresh.some((id) => !O.seen.has(id))) { beep(); toast("New order received"); }
  O.seen = new Set(orders.map((o) => o.id)); O.list = orders;
  A.setOrderBadge?.(fresh.length);
}
let actx;
function beep() {
  if (!O.sound) return;
  try { actx = actx || new AudioContext(); [0, 0.25].forEach((t) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.0001, actx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.3, actx.currentTime + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + t + 0.2); o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.22); }); } catch {}
}
function orderCard(o) {
  const n = NEXT[o.status];
  return `<div class="card order-card st-${o.status}"><div class="row" style="justify-content:space-between"><b>#${o.order_no} · ${esc(o.table_label || "Counter")}</b><span class="small muted">${minsAgo(o.created_at)}</span></div>
    <div class="list small">${(o.order_items || []).map((i) => `<div class="oi">${foodMark(i.food_type)}<b>${i.qty} ×</b> ${esc(i.name)}</div>`).join("")}</div>
    ${o.note ? `<div class="note small">📝 ${esc(o.note)}</div>` : ""}${o.customer_name || o.customer_phone ? `<div class="small muted">${esc(o.customer_name)} ${o.customer_phone ? "· " + esc(o.customer_phone) : ""}</div>` : ""}
    <div class="row" style="justify-content:space-between"><b class="num">${inr2(o.total)}</b><div class="row">${o.status !== "served" && o.status !== "cancelled" ? `<button class="btn sm ghost" data-or="cancelled" data-id="${o.id}">Cancel</button>` : ""}<button class="btn sm ghost" data-or="kot" data-id="${o.id}">Print</button>${n ? `<button class="btn sm primary" data-or="${n[0]}" data-id="${o.id}" ${can() ? "" : "disabled"}>${n[1]}</button>` : ""}</div></div></div>`;
}
const minsAgo = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : ago(iso); };
function drawOrders() {
  const el = $("#orders-view"); if (!el) return;
  const today = new Date().toDateString(), todays = O.list.filter((o) => new Date(o.created_at).toDateString() === today);
  const sales = todays.filter((o) => o.status !== "cancelled").reduce((t, o) => t + +o.total, 0), open = O.list.filter((o) => ["new", "preparing", "ready"].includes(o.status));
  const col = (st, title) => { const l = O.list.filter((o) => o.status === st).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); return `<div class="ocol"><h3>${title} <span class="pill ${st === "new" ? "acc" : ""}">${l.length}</span></h3>${l.map(orderCard).join("") || '<div class="empty small">None</div>'}</div>`; };
  const done = O.list.filter((o) => o.status === "served" || o.status === "cancelled");
  el.innerHTML = A.head("Orders", "Orders from table QR codes appear here within seconds, with a sound. Keep this screen open in the kitchen or at the counter.",
    `<label class="check small"><input type="checkbox" id="or-sound" ${O.sound ? "checked" : ""}> Sound</label><a class="btn" href="#menu">Edit menu</a>`) +
    `<div class="grid g4" style="margin-bottom:16px">${A.kpi("Orders today", todays.filter((o) => o.status !== "cancelled").length, "")}${A.kpi("Sales today", inr(sales), "from QR orders")}${A.kpi("Average order", inr(todays.length ? sales / Math.max(1, todays.filter((o) => o.status !== "cancelled").length) : 0), "")}${A.kpi("Open now", open.length, "not served yet")}</div>
    <div class="oboard">${col("new", "New")}${col("preparing", "Preparing")}${col("ready", "Ready to serve")}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h2>Completed (last 18 hours)</h2></div>${done.length ? `<div class="list">${done.map((o) => `<div class="item"><div class="grow"><b>#${o.order_no} · ${esc(o.table_label)}</b><span class="muted small">${(o.order_items || []).map((i) => `${i.qty}× ${esc(i.name)}`).join(", ")}</span></div><span class="pill ${o.status === "served" ? "good" : "bad"}">${o.status}</span><b class="num">${inr2(o.total)}</b></div>`).join("")}</div>` : '<div class="empty">No completed orders yet.</div>'}</div>`;
  const snd = $("#or-sound"); if (snd) snd.onchange = () => { O.sound = snd.checked; try { localStorage.setItem("bgp_order_sound", O.sound ? "1" : "0"); } catch {} if (O.sound) beep(); };
}
function kot(o) {
  printHTML(`<div style="font-family:ui-monospace,monospace;width:72mm;font-size:14px"><b style="font-size:18px">${esc(ctx().D.biz.name)}</b><br>Order #${o.order_no} · ${esc(o.table_label)}<br>${new Date(o.created_at).toLocaleString("en-IN")}<hr>
    ${(o.order_items || []).map((i) => `<div style="display:flex;justify-content:space-between"><span>${i.qty} × ${esc(i.name)}</span><span>${inr2(i.qty * i.price)}</span></div>`).join("")}<hr>
    <div style="display:flex;justify-content:space-between"><b>Total</b><b>${inr2(o.total)}</b></div>${o.note ? `<p>Note: ${esc(o.note)}</p>` : ""}</div>`, `Order ${o.order_no}`);
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const tab = e.target.closest("[data-mn-tab]"); if (tab && $("#menu-view")) { M.tab = tab.dataset.mnTab; return drawMenu(); }
  const el = e.target.closest("[data-mn]"); if (!el) { const or = e.target.closest("[data-or]"); if (or) return onOrder(or); return; }
  if (el.matches('input[type="checkbox"]')) return;
  const a = el.dataset.mn, id = el.dataset.id;
  try {
    if (a === "item-new") return itemForm({ category_id: M.d?.cats[0]?.id });
    if (a === "item-edit") return itemForm(M.d.items.find((i) => i.id === id));
    if (a === "cat-new") return catForm();
    if (a === "cat-edit") return catForm(M.d.cats.find((c) => c.id === id));
    if (a === "cat-del") { const n = M.d.items.filter((i) => i.category_id === id).length; if (!(await confirmBox("Delete this category?", n ? `Its ${n} item(s) move to "No category".` : "", "Delete", { danger: true }))) return; await q(sb.from("menu_categories").delete().eq("id", id)); closeModal(); await load(); return drawMenu(); }
    if (a === "tbl-edit") return tableForm(M.d.tables.find((t) => t.id === id));
    if (a === "tbl-del") { if (!(await confirmBox("Delete this table?", "Its QR code stops working. Past orders are kept.", "Delete", { danger: true }))) return; await q(sb.from("dining_tables").delete().eq("id", id)); closeModal(); await load(); return drawMenu(); }
    if (a === "qr-copy") return copy(el.dataset.link, "Link");
    if (a === "qr-png") { const card = el.closest(".tbl-card"), src = qrData(card); const link = document.createElement("a"); link.href = src; link.download = `QR ${el.dataset.label}.png`; link.click(); return; }
    if (a === "print-all") {
      const cards = [...document.querySelectorAll(".tbl-card")].slice(1).filter((c, i) => M.d.tables[i]?.active).map((c, i) => ({ label: c.querySelector("b").textContent.replace(" · hidden", ""), src: qrData(c) }));
      return printHTML(`<style>.g{display:grid;grid-template-columns:repeat(2,1fr);gap:10mm}.c{border:2px solid #16203a;border-radius:6mm;padding:8mm;text-align:center;page-break-inside:avoid;font-family:system-ui,sans-serif}.c img{width:55mm;height:55mm}.c h2{margin:0;font-size:20px}.c h3{margin:4px 0 8px;font-size:26px}.c p{margin:6px 0 0;font-size:14px}</style>
        <div class="g">${cards.map((c) => `<div class="c"><h2>${esc(ctx().D.biz.name)}</h2><h3>${esc(c.label)}</h3><img src="${c.src}"><p>Scan to see the menu &amp; order</p></div>`).join("")}</div>`, "Table QR codes");
    }
    if (a === "imp-cancel") { M.preview = null; return drawMenu(); }
    if (a === "imp-go") { el.disabled = true; el.textContent = "Importing…"; return await runImport(); }
    if (a === "export-menu") return exportMenu();
  } catch (err) { toast(err.message, "error"); if (a === "imp-go") { el.disabled = false; el.textContent = "Import"; } }
});
document.addEventListener("change", async (e) => {
  const el = e.target; if (!el.matches?.('[data-mn="avail"]')) return;
  try { await q(sb.from("menu_items").update({ available: el.checked, updated_at: new Date().toISOString() }).eq("id", el.dataset.id)); const it = M.d.items.find((i) => i.id === el.dataset.id); it.available = el.checked; el.parentElement.lastChild.textContent = el.checked ? " Available" : " Sold out"; toast(`${it.name}: ${el.checked ? "available" : "sold out"}`); }
  catch (err) { el.checked = !el.checked; toast(err.message, "error"); }
});
document.addEventListener("input", (e) => { if (e.target.id !== "mn-search") return; M.search = e.target.value; const pos = e.target.selectionStart; $("#mn-body").innerHTML = tabItems(); const s = $("#mn-search"); s.focus(); s.setSelectionRange(pos, pos); });
document.addEventListener("submit", async (e) => {
  const id = e.target.id; if (id !== "tbl-form" && id !== "mset-form") return; e.preventDefault();
  try {
    if (id === "tbl-form") {
      const prefix = $("#tb-prefix").value, from = +$("#tb-from").value, to = +$("#tb-to").value;
      if (!(from >= 1 && to >= from && to - from < 200)) throw new Error("Check the numbers (up to 200 tables at a time)");
      const have = new Set(M.d.tables.map((t) => t.label.toLowerCase()));
      const rows = []; for (let n = from; n <= to; n++) { const label = `${prefix}${n}`.trim(); if (!have.has(label.toLowerCase())) rows.push({ business_id: ctx().BID, label, sort: n }); }
      if (!rows.length) throw new Error("Those tables already exist");
      await q(sb.from("dining_tables").insert(rows)); toast(`${rows.length} table${rows.length > 1 ? "s" : ""} added`); await load(); drawMenu();
    } else {
      await q(sb.from("menu_settings").upsert({ business_id: ctx().BID, ordering_on: $("#ms-order").checked, show_prices: $("#ms-prices").checked, note: $("#ms-note").value.trim(), updated_at: new Date().toISOString() }));
      toast("Saved"); await load(); drawMenu();
    }
  } catch (err) { toast(err.message, "error"); }
});
async function onOrder(el) {
  const o = O.list.find((x) => x.id === el.dataset.id); if (!o) return; const st = el.dataset.or;
  if (st === "kot") return kot(o);
  if (st === "cancelled" && !(await confirmBox(`Cancel order #${o.order_no}?`, "", "Cancel order", { danger: true }))) return;
  try { el.disabled = true; await q(sb.from("orders").update({ status: st, updated_at: new Date().toISOString() }).eq("id", o.id)); o.status = st; drawOrders(); A.setOrderBadge?.(O.list.filter((x) => x.status === "new").length); }
  catch (err) { el.disabled = false; toast(err.message, "error"); }
}

/* =================== register =================== */
export function registerMenu(api) {
  A = api;
  try { O.sound = localStorage.getItem("bgp_order_sound") !== "0"; } catch {}
  api.VIEWS.menu = () => `<div id="menu-view"><div class="loading"><span class="spinner"></span></div></div>`;
  api.after.menu = async () => { try { await load(); drawMenu(); } catch (e) { $("#menu-view").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; } };
  api.VIEWS.orders = () => `<div id="orders-view"><div class="loading"><span class="spinner"></span></div></div>`;
  api.after.orders = async () => {
    try { await loadOrders(); drawOrders(); } catch (e) { $("#orders-view").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
    clearInterval(O.timer);
    O.timer = setInterval(async () => { if (!A.isRoute("orders")) return clearInterval(O.timer); const a = document.activeElement; try { await loadOrders(); if (!document.querySelector(".modal")) drawOrders(); } catch {} }, 8000);
  };
}
// Lightweight count of new orders for the menu badge (any page)
export async function newOrderCount(BID) {
  const { count } = await sb.from("orders").select("id", { count: "exact", head: true }).eq("business_id", BID).eq("status", "new");
  return count || 0;
}
