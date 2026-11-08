// Browser-side fake of the parts of supabase-js the app uses. Talks to server.mjs.
(function () {
  const post = (url, body) => fetch(url, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  const getSess = () => { try { return JSON.parse(localStorage.getItem("fake_sess") || "null"); } catch { return null; } };
  const listeners = [];
  class Q {
    constructor(table) { this.op = { kind: "select", table, select: "*", filters: [], order: [], limit: null }; this.mode = null; }
    select(s) { if (this.op.kind === "select") this.op.select = s || "*"; else this.ret = s; return this; }
    insert(v) { this.op.kind = "insert"; this.op.values = v; return this; }
    upsert(v) { this.op.kind = "upsert"; this.op.values = v; return this; }
    update(v) { this.op.kind = "update"; this.op.values = v; return this; }
    delete() { this.op.kind = "delete"; return this; }
    eq(c, v) { this.op.filters.push(["eq", c, v]); return this; } neq(c, v) { this.op.filters.push(["neq", c, v]); return this; }
    in(c, v) { this.op.filters.push(["in", c, v]); return this; } gte(c, v) { this.op.filters.push(["gte", c, v]); return this; } lte(c, v) { this.op.filters.push(["lte", c, v]); return this; }
    order(c, o = {}) { this.op.order.push([c, o]); return this; } limit(n) { this.op.limit = n; return this; }
    single() { this.mode = "single"; return this; } maybeSingle() { this.mode = "maybe"; return this; }
    then(res, rej) { return post("/__q", { user: getSess()?.user?.id || null, op: this.op }).then((r) => {
      if (r.error) return { data: null, error: r.error };
      let d = r.data; if (this.mode === "single") { if (!d || d.length !== 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } }; d = d[0]; }
      if (this.mode === "maybe") d = d && d.length ? d[0] : null;
      return { data: d, error: null }; }).then(res, rej); }
  }
  const sess = (user) => { const s = { user, access_token: "fake" }; localStorage.setItem("fake_sess", JSON.stringify(s)); listeners.forEach((f) => f("SIGNED_IN", s)); return s; };
  window.__BGP_FAKE_SB__ = {
    from: (t) => new Q(t),
    rpc: (fn, args) => post("/__q", { user: getSess()?.user?.id || null, op: { kind: "rpc", fn, args } }).then((r) => (r.error ? { data: null, error: r.error } : { data: r.data, error: null })),
    functions: { invoke: async () => ({ data: null, error: { message: "Edge functions aren't available in the local test", context: { json: async () => ({ error: "Edge functions aren't available in the local test" }) } } }) },
    auth: {
      getSession: async () => ({ data: { session: getSess() } }),
      onAuthStateChange: (f) => { listeners.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: async ({ email }) => { const r = await post("/__auth", { action: "signin", email }); return r.error ? { data: {}, error: r.error } : { data: { session: sess(r.data.user) }, error: null }; },
      signUp: async ({ email, options }) => { const r = await post("/__auth", { action: "signup", email, meta: options?.data }); return { data: { session: sess(r.data.user) }, error: null }; },
      signInWithOtp: async () => ({ error: null }),
      verifyOtp: async ({ phone }) => { const r = await post("/__auth", { action: "phone", phone: phone.replace(/\D/g, "") }); return { data: { session: sess(r.data.user) }, error: null }; },
      signOut: async () => { localStorage.removeItem("fake_sess"); },
      resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }),
    },
  };
})();
