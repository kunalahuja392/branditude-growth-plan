// Local test harness: serves web/ and answers a supabase-js-shaped client by running SQL
// against a local Postgres (with the Supabase auth stub), as the signed-in user's role.
// Usage: node tests/fake-supabase/server.mjs <port> <webRoot>
import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = +process.argv[2] || 8787, ROOT = process.argv[3] || "web";
const PSQL = ["-h", "/tmp", "-p", "5544", "-U", "postgres", "-d", "bgp", "-At", "-q", "-v", "ON_ERROR_STOP=1"];
const lit = (v) => (v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error("bad identifier " + s); return '"' + s + '"'; };
function val(v) {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return lit("{" + v.map((x) => (x === null ? "NULL" : '"' + String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"')).join(",") + "}");
  if (typeof v === "object") return lit(JSON.stringify(v));
  if (typeof v === "boolean") return v ? "true" : "false";
  return lit(v);
}
function run(sql, user) {
  const pre = user ? `set role authenticated; select set_config('request.jwt.claim.sub', ${lit(user)}, false) \\g /dev/null\n` : `set role anon;\n`;
  try { const out = execFileSync("psql", [...PSQL], { input: pre + sql + ";\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("\n").pop();
    return { data: out === "" ? null : JSON.parse(out) }; }
  catch (e) { const m = String(e.stderr || e.message).match(/ERROR:\s+(.*)/); return { error: { message: m ? m[1] : String(e.stderr || e.message) } }; }
}
const asAdmin = (sql) => run(sql.replace(/^/, ""), null).data;
const rawAdmin = (sql) => { const out = execFileSync("psql", [...PSQL], { input: sql + ";\n", encoding: "utf8" }).trim().split("\n").pop(); return out ? JSON.parse(out) : null; };

// FK map for embeds
const FKS = rawAdmin(`select coalesce(json_agg(json_build_object('t',c.conrelid::regclass::text,'col',a.attname,'rt',c.confrelid::regclass::text,'rcol',ra.attname,
  'pk',(select bool_or(a.attnum = any(p.conkey)) from pg_constraint p where p.conrelid=c.conrelid and p.contype='p' and array_length(p.conkey,1)=1))),'[]')
  from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1] join pg_attribute ra on ra.attrelid=c.confrelid and ra.attnum=c.confkey[1]
  where c.contype='f' and c.connamespace='public'::regnamespace`).map((f) => ({ ...f, t: f.t.replace(/^public\./, ""), rt: f.rt.replace(/^public\./, "") }));

function splitTop(s) { const out = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
function cols(table, alias, sel) {
  return splitTop(sel || "*").map((c) => {
    const m = c.match(/^(\w+)\((.*)\)$/s);
    if (!m) return c === "*" ? `${alias}.*` : `${alias}.${ident(c)}`;
    const rel = m[1], inner = m[2], ra = alias + "_" + rel;
    let fk = FKS.find((f) => f.t === table && f.rt === rel);
    if (fk) return `(select to_jsonb(${ra}x) from (select ${cols(rel, ra, inner)} from public.${ident(rel)} ${ra} where ${ra}.${ident(fk.rcol)} = ${alias}.${ident(fk.col)}) ${ra}x) as ${ident(rel)}`;
    fk = FKS.find((f) => f.t === rel && f.rt === table);
    if (!fk) throw new Error(`no relationship ${table} -> ${rel}`);
    if (fk.pk) return `(select to_jsonb(${ra}x) from (select ${cols(rel, ra, inner)} from public.${ident(rel)} ${ra} where ${ra}.${ident(fk.col)} = ${alias}.${ident(fk.rcol)}) ${ra}x) as ${ident(rel)}`;
    return `(select coalesce(jsonb_agg(to_jsonb(${ra}x)),'[]') from (select ${cols(rel, ra, inner)} from public.${ident(rel)} ${ra} where ${ra}.${ident(fk.col)} = ${alias}.${ident(fk.rcol)}) ${ra}x) as ${ident(rel)}`;
  }).join(", ");
}
function where(f) {
  if (!f.length) return "";
  return " where " + f.map(([op, c, v]) => {
    const col = "t0." + ident(c);
    if (op === "eq") return v === null ? `${col} is null` : `${col} = ${val(v)}`;
    if (op === "neq") return `${col} <> ${val(v)}`;
    if (op === "gte") return `${col} >= ${val(v)}`; if (op === "lte") return `${col} <= ${val(v)}`; if (op === "gt") return `${col} > ${val(v)}`; if (op === "lt") return `${col} < ${val(v)}`;
    if (op === "in") return v.length ? `${col} in (${v.map(val).join(",")})` : "false";
    throw new Error("op " + op);
  }).join(" and ");
}
function handle(req) {
  const { user, op } = req;
  if (op.kind === "rpc") {
    const args = Object.entries(op.args || {}).map(([k, v]) => `${ident(k)} => ${val(v)}`).join(", ");
    return run(`select to_jsonb(public.${ident(op.fn)}(${args}))`, user);
  }
  const T = ident(op.table);
  if (op.kind === "select") {
    let sql = `select ${cols(op.table, "t0", op.select)} from public.${T} t0${where(op.filters)}`;
    if (op.order.length) sql += " order by " + op.order.map(([c, o]) => `t0.${ident(c)} ${o.ascending === false ? "desc" : "asc"}${o.nullsFirst === false ? " nulls last" : o.nullsFirst ? " nulls first" : ""}`).join(", ");
    if (op.limit) sql += ` limit ${+op.limit}`;
    return run(`select coalesce(jsonb_agg(x),'[]') from (${sql}) x`, user);
  }
  if (op.kind === "insert" || op.kind === "upsert") {
    const rows = Array.isArray(op.values) ? op.values : [op.values]; const keys = [...new Set(rows.flatMap(Object.keys))];
    const types = rawAdmin(`select json_object_agg(column_name, udt_name) from information_schema.columns where table_schema='public' and table_name=${lit(op.table)}`);
    const cast = (k, v) => (v === null || v === undefined ? "NULL" : val(v) + "::" + (types[k].startsWith("_") ? types[k].slice(1) + "[]" : types[k]));
    let sql = `insert into public.${T} as t0 (${keys.map(ident).join(",")}) values ${rows.map((r) => "(" + keys.map((k) => (k in r ? cast(k, r[k]) : "DEFAULT")).join(",") + ")").join(",")}`;
    if (op.kind === "upsert") { const pk = rawAdmin(`select json_agg(a.attname) from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid='public.${op.table}'::regclass and i.indisprimary`);
      sql += ` on conflict (${pk.map(ident).join(",")}) do update set ${keys.filter((k) => !pk.includes(k)).map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}`; }
    return run(`with r as (${sql} returning *) select coalesce(jsonb_agg(r),'[]') from r`, user);
  }
  if (op.kind === "update") {
    const types = rawAdmin(`select json_object_agg(column_name, udt_name) from information_schema.columns where table_schema='public' and table_name=${lit(op.table)}`);
    const set = Object.entries(op.values).map(([k, v]) => `${ident(k)} = ${v === null ? "NULL" : val(v) + "::" + (types[k].startsWith("_") ? types[k].slice(1) + "[]" : types[k])}`).join(", ");
    return run(`with r as (update public.${T} as t0 set ${set}${where(op.filters)} returning *) select coalesce(jsonb_agg(r),'[]') from r`, user);
  }
  if (op.kind === "delete") return run(`with r as (delete from public.${T} as t0${where(op.filters)} returning *) select coalesce(jsonb_agg(r),'[]') from r`, user);
  throw new Error("unknown op");
}
function auth(req) {
  if (req.action === "signin") { const u = rawAdmin(`select row_to_json(u) from auth.users u where lower(email)=lower(${lit(req.email)})`); return u ? { data: { user: u } } : { error: { message: "Invalid login credentials" } }; }
  if (req.action === "signup") { const u = rawAdmin(`with u as (insert into auth.users (id,email,raw_user_meta_data) values (gen_random_uuid(), ${lit(req.email)}, ${lit(JSON.stringify(req.meta || {}))}) returning *) select row_to_json(u) from u`); return { data: { user: u } }; }
  if (req.action === "phone") { let u = rawAdmin(`select row_to_json(u) from auth.users u where phone=${lit(req.phone)}`);
    if (!u) u = rawAdmin(`with u as (insert into auth.users (id,phone) values (gen_random_uuid(), ${lit(req.phone)}) returning *) select row_to_json(u) from u`); return { data: { user: u } }; }
  if (req.action === "user") return { data: { user: rawAdmin(`select row_to_json(u) from auth.users u where id=${lit(req.id)}`) } };
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  if (req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    let out; try { const j = JSON.parse(b); out = req.url === "/__auth" ? auth(j) : handle(j); } catch (e) { out = { error: { message: String(e.message) } }; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out)); }); return; }
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p === "/") p = "/index.html";
  const file = p === "/__fake.js" ? path.resolve("tests/fake-supabase/client.js") : path.join(path.resolve(ROOT), p);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  let body = fs.readFileSync(file);
  if (file.endsWith(".html")) body = String(body).replace("<head>", '<head><script src="/__fake.js"></script>');
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(body);
}).listen(PORT, () => console.log("fake supabase on", PORT));
