-- Gaming clubs, round 2 (17 Nov 2026):
--  * prices by time of day for each station (optional), on top of which happy-hour rules still apply
--  * round bills up to the next 1, 2, 5 or 10 rupees
--  * biller picks the time to charge: played, full booking, or custom minutes
--  * memberships: hour packs per station or shared across chosen stations, with expiry; used at checkout; customers see them
--  * reports: per-station gaming, snacks, total and average per session
--  * new plan prices and the THEGAMINGLOFT / NEW75 coupons

-- ---------- 1. Settings & columns ----------
alter table public.gc_stations add column if not exists time_rates jsonb not null default '[]';   -- [{name, days[], from 'HH:MM', to 'HH:MM', rate}]
alter table public.gc_settings add column if not exists round_to int not null default 1;
alter table public.gc_settings drop constraint if exists gc_settings_round_to_check;
alter table public.gc_settings add constraint gc_settings_round_to_check check (round_to in (1, 2, 5, 10));
alter table public.gc_sessions add column if not exists bill_mode text not null default 'auto';
alter table public.gc_sessions drop constraint if exists gc_sessions_bill_mode_check;
alter table public.gc_sessions add constraint gc_sessions_bill_mode_check check (bill_mode in ('auto','played','booked','custom'));
alter table public.gc_sessions add column if not exists bill_minutes int check (bill_minutes is null or bill_minutes between 0 and 1440);

-- ---------- 2. Time-of-day station prices ----------
-- The station's hourly price at this moment from its own time bands (null = no band, use the normal price)
create or replace function public.gc_band_rate(st public.gc_stations, ts timestamptz, out rate numeric, out label text)
language plpgsql immutable set search_path = public as $$
declare l timestamp := ts at time zone 'Asia/Kolkata'; d int := extract(dow from l); t time := l::time; b jsonb; f time; e time; ds int[];
begin
  rate := null; label := null;
  for b in select * from jsonb_array_elements(coalesce(st.time_rates, '[]')) loop
    f := coalesce(nullif(b->>'from', ''), '00:00')::time; e := case when coalesce(b->>'to', '') in ('', '24:00', '00:00') then '24:00'::time else (b->>'to')::time end;
    ds := coalesce(array(select x::int from jsonb_array_elements_text(b->'days') x), '{0,1,2,3,4,5,6}'); if cardinality(ds) = 0 then ds := '{0,1,2,3,4,5,6}'; end if;
    if (f < e and d = any(ds) and t >= f and t < e) or (f >= e and ((t >= f and d = any(ds)) or (t < e and ((d + 6) % 7) = any(ds)))) then
      rate := (b->>'rate')::numeric; label := coalesce(nullif(trim(b->>'name'), ''), to_char(f, 'HH12:MI am') || '–' || case when e = '24:00' then '12:00 am' else to_char(e, 'HH12:MI am') end);
      return;
    end if;
  end loop;
end $$;
create or replace function public.gc_rate_at(st public.gc_stations, rules public.gc_rules[], players int, ts timestamptz, out rate numeric, out rule text)
language plpgsql immutable as $$
declare r public.gc_rules; best public.gc_rules; extra numeric; base numeric; band record;
begin
  extra := greatest(0, coalesce(players, 1) - st.included_players) * st.extra_player_rate;
  band := public.gc_band_rate(st, ts); base := coalesce(band.rate, st.rate);
  rate := base + extra; rule := band.label;
  if rules is not null then
    foreach r in array rules loop
      if public.gc_rule_hits(r, st, ts) and (best.id is null or r.priority > best.priority or (r.priority = best.priority and r.created_at > best.created_at)) then best := r; end if;
    end loop;
  end if;
  if best.id is not null then
    rule := best.name;
    rate := case best.mode when 'fixed' then best.value + extra when 'percent' then (base + extra) * (1 - best.value / 100) else base + extra + best.value end;
  end if;
  rate := greatest(rate, 0);
end $$;
alter function public.gc_rate_at(public.gc_stations, public.gc_rules[], int, timestamptz) set search_path = public;
-- ---------- 3. Bill time choice ----------
create or replace function public.gc_calc(p_session uuid, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.gc_sessions; st public.gc_stations; cf public.gc_settings; rules public.gc_rules[]; endt timestamptz;
        tot record; act_min numeric; charged int; amount numeric; nowr record; seg record; c record; segs jsonb := '[]'; per jsonb := '{}';
        tail jsonb := null; played int; last_to timestamptz; n int; p text; items jsonb; items_total numeric; share numeric; segamt numeric; last_id bigint; tail_cost record;
begin
  select * into s from public.gc_sessions where id = p_session; if not found then return null; end if;
  select * into st from public.gc_stations where id = s.station_id;
  select * into cf from public.gc_settings where business_id = s.business_id;
  if cf.business_id is null then cf.round_minutes := 1; cf.min_minutes := 0; cf.charge_booked := true; end if;
  rules := array(select r from public.gc_rules r where r.business_id = s.business_id and r.active);
  endt := coalesce(s.end_at, p_now);
  tot := public.gc_cost(s.id, '-infinity', 'infinity', st, rules, s.players, endt);
  act_min := tot.ms / 60000.0;
  charged := case when tot.ms > 0 then ceil(act_min - 0.000001)::int else 0 end;
  if cf.min_minutes > 0 and charged > 0 then charged := greatest(charged, cf.min_minutes); end if;
  if cf.round_minutes > 1 and charged > 0 then charged := ceil(charged::numeric / cf.round_minutes)::int * cf.round_minutes; end if;
  if s.bill_mode = 'custom' and s.bill_minutes is not null then charged := s.bill_minutes;
  elsif s.bill_mode = 'booked' then if s.booked_minutes > 0 then charged := greatest(charged, s.booked_minutes); end if;
  elsif s.bill_mode = 'played' then null;
  elsif cf.charge_booked and s.booked_minutes > 0 and s.status not in ('running','paused') then charged := greatest(charged, s.booked_minutes); end if;
  nowr := public.gc_rate_at(st, rules, s.players, least(p_now, endt));
  amount := round(case when tot.ms > 0 then tot.cost * charged / act_min else charged * nowr.rate / 60 end, 2);
  played := case when tot.ms > 0 then ceil(act_min - 0.000001)::int else 0 end;

  if s.is_lp then
    last_to := s.start_at;
    select max(id) into last_id from public.gc_lp_segments where session_id = s.id;
    if last_id is not null then
      select to_at into last_to from public.gc_lp_segments where id = last_id;
      tail_cost := public.gc_cost(s.id, last_to, 'infinity', st, rules, s.players, endt);
    else
      tail_cost := tot;
    end if;
    for seg in select * from public.gc_lp_segments where session_id = s.id order by to_at loop
      -- a few seconds played after the last split stay with that game
      c := public.gc_cost(s.id, seg.from_at, case when seg.id = last_id and tail_cost.ms < 60000 then 'infinity' else seg.to_at end, st, rules, s.players, endt);
      share := case when tot.cost > 0 then c.cost / tot.cost when tot.ms > 0 then c.ms::numeric / tot.ms else 0 end;
      segamt := round(amount * share, 2);
      segs := segs || jsonb_build_object('id', seg.id, 'from_at', seg.from_at, 'to_at', seg.to_at, 'minutes', round(c.ms / 60000.0, 2), 'amount', segamt,
                                         'winner', seg.winner, 'payers', to_jsonb(seg.payers), 'open', false);
      n := cardinality(seg.payers);
      foreach p in array seg.payers loop per := jsonb_set(per, array[p], to_jsonb(round(coalesce((per->>p)::numeric, 0) + segamt / n, 2))); end loop;
    end loop;
    if (last_id is null and tail_cost.ms >= 1000) or (last_id is not null and tail_cost.ms >= 60000) then
      share := case when tot.cost > 0 then tail_cost.cost / tot.cost when tot.ms > 0 then tail_cost.ms::numeric / tot.ms else 0 end;
      tail := jsonb_build_object('from_at', last_to, 'to_at', endt, 'minutes', round(tail_cost.ms / 60000.0, 2), 'amount', round(amount * share, 2), 'open', true);
      segs := segs || tail;
    end if;
    foreach p in array s.lp_players loop if not per ? p then per := per || jsonb_build_object(p, 0); end if; end loop;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'qty', i.qty, 'price', i.price, 'assigned_to', i.assigned_to, 'product_id', i.product_id) order by i.id), '[]'),
         coalesce(sum(i.qty * i.price), 0)
    into items, items_total from public.gc_items i where i.session_id = s.id;

  return jsonb_build_object(
    'active_ms', tot.ms, 'active_minutes', round(act_min, 2), 'charged_minutes', charged, 'amount', amount,
    'bill_mode', s.bill_mode, 'bill_minutes', s.bill_minutes, 'booked_minutes', s.booked_minutes, 'played_minutes', played,
    'rate_hour', round(case when tot.ms > 0 then tot.cost / act_min * 60 else nowr.rate end, 2),
    'rate_now', round(nowr.rate, 2), 'rule_now', nowr.rule,
    'by_rule', (select coalesce(jsonb_agg(jsonb_build_object('rule', k, 'minutes', round((v->>'ms')::numeric / 60000, 1), 'cost', round((v->>'cost')::numeric, 2))), '[]') from jsonb_each(tot.by_rule) x(k, v)),
    'segments', segs, 'tail', tail, 'per_player', per, 'lp_players', to_jsonb(s.lp_players),
    'items', items, 'items_total', round(items_total, 2),
    'remaining_ms', case when s.booked_minutes > 0 then s.booked_minutes * 60000 - tot.ms end,
    'station', jsonb_build_object('id', st.id, 'name', st.name, 'type', st.type));
end $$;

-- Biller picks the time to charge: auto (club setting) | played | booked | custom {minutes}
create or replace function public.gc_bill_time(p_session uuid, p_mode text, p_minutes int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions;
begin
  select * into s from public.gc_sessions where id = p_session for update; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if s.status in ('closed','cancelled') then raise exception 'This session is already closed'; end if;
  if p_mode not in ('auto','played','booked','custom') then raise exception 'Unknown option'; end if;
  if p_mode = 'custom' and (p_minutes is null or p_minutes < 0 or p_minutes > 1440) then raise exception 'Enter the minutes to charge'; end if;
  update public.gc_sessions set bill_mode = p_mode, bill_minutes = case when p_mode = 'custom' then p_minutes end where id = s.id;
  return public.gc_view(s.id);
end $$;
grant execute on function public.gc_bill_time(uuid, text, int) to authenticated;
-- ---------- 4. Round bills up to the next 1/2/5/10 ----------
create or replace function public.gc_make_bill(b uuid, s public.gc_sessions, calc jsonb, p_lines jsonb, p jsonb) returns public.gc_bills
language plpgsql security definer set search_path = public as $$
declare cf public.gc_settings; sub numeric; disc numeric; taxable numeric; tax numeric; total numeric; rounded numeric; paysum numeric := 0; paid numeric; due numeric;
        cust uuid; pay jsonb; left_amt numeric; a numeric; bill public.gc_bills; lp jsonb := null; rows jsonb := '[]'; pl text; acc numeric := 0;
        pg numeric; pi numeric; common numeric; i int := 0; n int; wins int; pv jsonb; st int; done int := 0; lbl text; game numeric;
begin
  cf := public.gc_cfg(b);
  sub := round((select coalesce(sum((l->>'amount')::numeric), 0) from jsonb_array_elements(p_lines) l), 2);
  game := round((select coalesce(sum((l->>'amount')::numeric), 0) from jsonb_array_elements(p_lines) l where l->>'kind' = 'game'), 2);
  disc := least(sub, greatest(coalesce((p->>'discount')::numeric, 0), 0));
  taxable := sub - disc;
  if cf.tax_inclusive then total := taxable; tax := round(total - total / (1 + cf.tax_percent / 100), 2);
  else tax := round(taxable * cf.tax_percent / 100, 2); total := taxable + tax; end if;
  rounded := case when coalesce(cf.round_to, 1) > 1 then ceil(round(total, 2) / cf.round_to) * cf.round_to else round(total) end;
  for pay in select * from jsonb_array_elements(coalesce(p->'payments', '[]')) loop
    if coalesce((pay->>'amount')::numeric, 0) < 0 then raise exception 'Payment can''t be negative'; end if;
    if coalesce((pay->>'amount')::numeric, 0) > 0 and coalesce(pay->>'mode', '') not in ('cash','upi','card') then raise exception 'Unknown payment mode'; end if;
    paysum := paysum + coalesce((pay->>'amount')::numeric, 0);
  end loop;
  paid := least(paysum, rounded); due := rounded - paid;
  cust := coalesce(public.gc_customer(b, coalesce(p->>'customer_name', s.customer_name), coalesce(nullif(p->>'customer_phone', ''), s.customer_phone)), s.customer_id);
  if due > 0 and cust is null then raise exception 'Add the customer''s mobile number to keep a pending amount'; end if;

  -- LP: each player's game time + own snacks + equal share of common snacks, scaled to the final total
  if s.is_lp and calc is not null then
    n := cardinality(s.lp_players);
    common := (select coalesce(sum((x->>'qty')::numeric * (x->>'price')::numeric), 0) from jsonb_array_elements(calc->'items') x where coalesce(x->>'assigned_to', '') = '');
    foreach pl in array s.lp_players loop
      i := i + 1;
      pg := coalesce((calc->'per_player'->>pl)::numeric, 0);
      pi := round((select coalesce(sum((x->>'qty')::numeric * (x->>'price')::numeric), 0) from jsonb_array_elements(calc->'items') x where x->>'assigned_to' = pl) + common / n, 2);
      wins := (select count(*) from jsonb_array_elements(calc->'segments') x where x->>'winner' = pl);
      a := case when i = n then rounded - acc when sub > 0 then round(rounded * (pg + pi) / sub) else 0 end; acc := acc + a;
      rows := rows || jsonb_build_object('player', pl, 'wins', wins, 'game', pg, 'items', pi, 'payable', a);
    end loop;
    lp := jsonb_build_object('players', rows, 'segments',
      (select coalesce(jsonb_agg(jsonb_build_object('from_at', x->'from_at', 'to_at', x->'to_at', 'minutes', x->'minutes', 'amount', x->'amount', 'winner', x->'winner', 'payers', x->'payers')), '[]')
       from jsonb_array_elements(calc->'segments') x));
  end if;

  update public.gc_settings set bill_seq = bill_seq + 1 where business_id = b returning bill_seq into i;
  insert into public.gc_bills (business_id, number, session_id, customer_id, customer_name, customer_phone, station_name, station_type, lines, lp,
                               game_amount, items_amount, subtotal, discount, tax_percent, tax, round_off, total, paid, due, status, notes, created_by)
  values (b, cf.bill_prefix || '-' || lpad(i::text, 5, '0'), s.id, cust,
          coalesce(nullif(trim(p->>'customer_name'), ''), nullif(s.customer_name, ''), (select name from public.customers where id = cust), ''),
          (select phone from public.customers where id = cust), calc->'station'->>'name', calc->'station'->>'type', p_lines, lp,
          game, sub - game, sub, disc, cf.tax_percent, tax, round(rounded - total, 2), rounded, paid, due,
          case when due <= 0 then 'paid' when paid > 0 then 'partial' else 'unpaid' end, coalesce(p->>'notes', ''), auth.uid())
  returning * into bill;
  left_amt := paid;
  for pay in select * from jsonb_array_elements(coalesce(p->'payments', '[]')) loop
    a := least(coalesce((pay->>'amount')::numeric, 0), left_amt); left_amt := left_amt - a;
    if a > 0 then insert into public.gc_payments (business_id, bill_id, customer_id, mode, amount, paid_by, created_by)
                  values (b, bill.id, cust, pay->>'mode', a, nullif(pay->>'by', ''), auth.uid()); end if;
  end loop;

  -- Count it as a visit in the customer list (visits, spend, loyalty stamps and review requests keep working)
  if cust is not null then
    pv := public.preview_visit(b, (select phone from public.customers where id = cust), rounded, null);
    st := case when (pv->>'loyalty_enabled')::boolean then (pv->>'visit_no')::int else (select stamps from public.customers where id = cust) end;
    if coalesce((pv->>'completes_card')::boolean, false) then st := 0; done := 1; end if;
    if pv->>'use' = 'loyalty' then
      lbl := coalesce(nullif(pv->'loyalty_reward'->>'note', ''), case pv->'loyalty_reward'->>'type' when 'percent' then (pv->'loyalty_reward'->>'value')::numeric::int || '% off'
             when 'flat' then '₹' || (pv->'loyalty_reward'->>'value')::numeric::int || ' off' else 'Free gift' end);
    end if;
    update public.customers set visits = visits + 1, spend = spend + rounded, last_visit = now(), stamps = st, cards_completed = cards_completed + done where id = cust;
    insert into public.visits (business_id, customer_id, gross, discount, net, loyalty_visit, loyalty_reward, created_by)
    values (b, cust, sub, disc, rounded, case when (pv->>'loyalty_enabled')::boolean then (pv->>'visit_no')::int else 0 end, lbl, auth.uid());
  end if;
  return bill;
end $$;
revoke execute on function public.gc_make_bill(uuid, public.gc_sessions, jsonb, jsonb, jsonb) from public, anon, authenticated;

-- ---------- 5. Memberships ----------
-- A plan is an hour pack: price, days valid, and one or more buckets. A bucket's minutes can be used on any of its stations
-- (one station = hours for that station; several = shared hours, e.g. 2 hrs for PS5 #1 or PS5 #2; none = any station).
create table if not exists public.gc_membership_plans (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  name          text not null,
  price         numeric(10,2) not null default 0 check (price >= 0),
  validity_days int not null default 30 check (validity_days between 1 and 3650),
  buckets       jsonb not null default '[]',      -- [{name, station_ids[], minutes}]
  notes         text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create table if not exists public.gc_memberships (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  plan_id        uuid references public.gc_membership_plans(id) on delete set null,
  plan_name      text not null,
  customer_id    uuid references public.customers(id) on delete set null,
  customer_name  text not null default '',
  customer_phone text,
  starts_on      date not null default current_date,
  expires_on     date not null,
  price          numeric(10,2) not null default 0,
  buckets        jsonb not null default '[]',     -- [{name, station_ids[], minutes, used}]
  status         text not null default 'active' check (status in ('active','cancelled')),
  bill_id        uuid references public.gc_bills(id) on delete set null,
  notes          text not null default '',
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);
create index if not exists gc_memberships_c on public.gc_memberships (business_id, customer_id);
create table if not exists public.gc_membership_uses (
  id            bigserial primary key,
  business_id   uuid not null references public.businesses(id) on delete cascade,
  membership_id uuid not null references public.gc_memberships(id) on delete cascade,
  bucket        int not null,
  minutes       int not null,
  amount        numeric(12,2) not null default 0,
  station_name  text,
  session_id    uuid references public.gc_sessions(id) on delete set null,
  bill_id       uuid references public.gc_bills(id) on delete cascade,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists gc_membership_uses_m on public.gc_membership_uses (membership_id);
do $$
declare t text;
begin
  foreach t in array array['gc_membership_plans','gc_memberships','gc_membership_uses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (public.gc_read(business_id))', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  drop policy if exists gc_membership_plans_write on public.gc_membership_plans;
  create policy gc_membership_plans_write on public.gc_membership_plans for all using (public.gc_can_setup(business_id)) with check (public.gc_can_setup(business_id));
  grant insert, update, delete on public.gc_membership_plans to authenticated;
end $$;

-- Clean a bucket list: names, minutes > 0, station ids of this club only
create or replace function public.gc_clean_buckets(b uuid, x jsonb, keep_used boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare k jsonb; o jsonb := '[]'; ids jsonb; m int; i int := 0;
begin
  for k in select * from jsonb_array_elements(coalesce(x, '[]')) loop
    i := i + 1;
    m := round(coalesce((k->>'minutes')::numeric, 0)); if m <= 0 then continue; end if;
    select coalesce(jsonb_agg(s.id), '[]') into ids from public.gc_stations s
     where s.business_id = b and s.id::text in (select jsonb_array_elements_text(coalesce(k->'station_ids', '[]')));
    o := o || jsonb_build_object('name', coalesce(nullif(trim(k->>'name'), ''), 'Hours ' || i), 'station_ids', ids, 'minutes', m,
                                 'used', case when keep_used then least(m, greatest(0, coalesce((k->>'used')::int, 0))) else 0 end);
  end loop;
  if jsonb_array_length(o) = 0 then raise exception 'Add at least one set of hours'; end if;
  return o;
end $$;
revoke execute on function public.gc_clean_buckets(uuid, jsonb, boolean) from public, anon, authenticated;

create or replace function public.gc_membership_plan_check() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.buckets := public.gc_clean_buckets(new.business_id, new.buckets);
  if coalesce(trim(new.name), '') = '' then raise exception 'Give the plan a name'; end if;
  return new;
end $$;
revoke execute on function public.gc_membership_plan_check() from public, anon, authenticated;
drop trigger if exists gc_membership_plan_check on public.gc_membership_plans;
create trigger gc_membership_plan_check before insert or update on public.gc_membership_plans for each row execute function public.gc_membership_plan_check();

-- One membership with names of its stations and what's left
create or replace function public.gc_membership_json(m public.gc_memberships) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(m) || jsonb_build_object(
    'active', m.status = 'active' and m.expires_on >= (now() at time zone 'Asia/Kolkata')::date,
    'days_left', greatest(0, m.expires_on - (now() at time zone 'Asia/Kolkata')::date + 1),
    'buckets', (select coalesce(jsonb_agg(k || jsonb_build_object('idx', i - 1, 'left', greatest(0, (k->>'minutes')::int - coalesce((k->>'used')::int, 0)),
                 'stations', (select coalesce(jsonb_agg(s.name order by s.sort, s.name), '[]') from public.gc_stations s where s.id::text in (select jsonb_array_elements_text(k->'station_ids'))))
                 order by i), '[]') from jsonb_array_elements(m.buckets) with ordinality as x(k, i)),
    'minutes_left', (select coalesce(sum(greatest(0, (k->>'minutes')::int - coalesce((k->>'used')::int, 0))), 0) from jsonb_array_elements(m.buckets) k))
$$;
revoke execute on function public.gc_membership_json(public.gc_memberships) from public, anon, authenticated;

-- Sell a membership: makes a bill for the price (cash / UPI / card / split / pay later) and starts the hours.
-- p: plan_id, customer_name, customer_phone, starts_on, discount, payments[], notes
create or replace function public.gc_membership_sell(p_business uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pl public.gc_membership_plans; s public.gc_sessions; bl public.gc_bills; c uuid; d date; m public.gc_memberships;
begin
  perform public.gc_guard(p_business);
  select * into pl from public.gc_membership_plans where id = (p->>'plan_id')::uuid and business_id = p_business and active;
  if not found then raise exception 'Choose a membership plan'; end if;
  c := public.gc_customer(p_business, p->>'customer_name', p->>'customer_phone');
  if c is null then raise exception 'Add the customer''s mobile number'; end if;
  d := coalesce(nullif(p->>'starts_on', '')::date, (now() at time zone 'Asia/Kolkata')::date);
  bl := public.gc_make_bill(p_business, s, null, jsonb_build_array(jsonb_build_object('kind', 'item', 'desc', 'Membership: ' || pl.name || ' (' || pl.validity_days || ' days)',
          'qty', 1, 'rate', pl.price, 'amount', pl.price)), p || jsonb_build_object('customer_phone', (select phone from public.customers where id = c)));
  insert into public.gc_memberships (business_id, plan_id, plan_name, customer_id, customer_name, customer_phone, starts_on, expires_on, price, buckets, bill_id, notes, created_by)
  values (p_business, pl.id, pl.name, c, coalesce(nullif(trim(p->>'customer_name'), ''), (select name from public.customers where id = c)),
          (select phone from public.customers where id = c), d, d + pl.validity_days - 1, pl.price, public.gc_clean_buckets(p_business, pl.buckets), bl.id, coalesce(p->>'notes', ''), auth.uid())
  returning * into m;
  return jsonb_build_object('membership', public.gc_membership_json(m), 'bill', public.gc_bill_json(bl));
end $$;
revoke execute on function public.gc_membership_sell(uuid, jsonb) from public, anon;
grant execute on function public.gc_membership_sell(uuid, jsonb) to authenticated;

-- Owner: extend {days} | cancel {reason} | adjust {buckets with used} | notes {notes}
create or replace function public.gc_membership_update(p_id uuid, p_action text, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.gc_memberships;
begin
  select * into m from public.gc_memberships where id = p_id for update; if not found then raise exception 'Membership not found'; end if;
  if not public.gc_can_setup(m.business_id) then raise exception 'Only the owner can change a membership'; end if;
  if p_action = 'extend' then
    if coalesce((p->>'days')::int, 0) = 0 then raise exception 'Enter the days to add'; end if;
    update public.gc_memberships set expires_on = greatest(expires_on, (now() at time zone 'Asia/Kolkata')::date - 1) + (p->>'days')::int, status = 'active' where id = m.id returning * into m;
  elsif p_action = 'cancel' then
    if coalesce(trim(p->>'reason'), '') = '' then raise exception 'Give a reason'; end if;
    update public.gc_memberships set status = 'cancelled', notes = trim(notes || ' [Cancelled: ' || (p->>'reason') || ']') where id = m.id returning * into m;
  elsif p_action = 'adjust' then
    update public.gc_memberships set buckets = public.gc_clean_buckets(m.business_id, p->'buckets', true) where id = m.id returning * into m;
  elsif p_action = 'notes' then
    update public.gc_memberships set notes = coalesce(p->>'notes', '') where id = m.id returning * into m;
  else raise exception 'Unknown action'; end if;
  return public.gc_membership_json(m);
end $$;
revoke execute on function public.gc_membership_update(uuid, text, jsonb) from public, anon;
grant execute on function public.gc_membership_update(uuid, text, jsonb) to authenticated;

-- Memberships this session's customer can use on this station (or a phone typed at checkout)
create or replace function public.gc_member_options(p_session uuid, p_phone text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions; ph text; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into s from public.gc_sessions where id = p_session; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  ph := coalesce(nullif(public.norm_phone(p_phone, (select country_code from public.businesses where id = s.business_id)), ''), s.customer_phone);
  return (select coalesce(jsonb_agg(j order by (j->>'expires_on')), '[]') from (
    select public.gc_membership_json(m) as j from public.gc_memberships m
    where m.business_id = s.business_id and m.status = 'active' and m.expires_on >= today and m.starts_on <= today
      and (m.customer_id = s.customer_id or (ph is not null and m.customer_phone = ph))) x
    where exists (select 1 from jsonb_array_elements(j->'buckets') k where (k->>'left')::int > 0
      and (jsonb_array_length(k->'station_ids') = 0 or k->'station_ids' ? s.station_id::text)));
end $$;
revoke execute on function public.gc_member_options(uuid, text) from public, anon;
grant execute on function public.gc_member_options(uuid, text) to authenticated;

-- Customers: their memberships at every club (customer portal)
create or replace function public.my_gc_memberships() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.gc_membership_json(m) || jsonb_build_object('business_name', b.name,
           'uses', (select coalesce(jsonb_agg(jsonb_build_object('minutes', u.minutes, 'station', u.station_name, 'at', u.created_at) order by u.created_at desc), '[]')
                    from (select * from public.gc_membership_uses u where u.membership_id = m.id order by created_at desc limit 20) u))
         order by m.status, m.expires_on desc), '[]')
  from public.gc_memberships m join public.businesses b on b.id = m.business_id
  where public.my_phone() is not null and m.customer_phone = public.my_phone()
$$;
revoke execute on function public.my_gc_memberships() from public, anon;
grant execute on function public.my_gc_memberships() to authenticated;
-- Checkout with membership hours
create or replace function public.gc_checkout(p_session uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions; calc jsonb; lines jsonb; it jsonb; bl public.gc_bills; payers text[]; w text; rt text;
        mem public.gc_memberships; bk jsonb; bi int; mleft int; mcov int := 0; mamt numeric := 0; chg int;
begin
  select * into s from public.gc_sessions where id = p_session for update; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if s.status = 'closed' then raise exception 'This session is already billed'; end if;
  if s.status = 'cancelled' then raise exception 'This session was cancelled'; end if;
  if s.status in ('running','paused') then
    update public.gc_intervals set end_at = now() where session_id = s.id and end_at is null;
    update public.gc_sessions set status = 'billing', end_at = now() where id = s.id returning * into s;
  end if;
  calc := public.gc_calc(s.id);
  if s.is_lp and calc->'tail' is not null and jsonb_typeof(calc->'tail') = 'object' and (calc->'tail'->>'minutes')::numeric >= 1 then
    w := nullif(trim(coalesce(p->'lp_final'->>'winner', '')), '');
    payers := array(select x from jsonb_array_elements_text(coalesce(p->'lp_final'->'payers', '[]')) x where x = any(s.lp_players));
    if cardinality(payers) = 0 and w is not null and w <> 'Draw' and cardinality(s.lp_players) = 2 then payers := array(select x from unnest(s.lp_players) x where x <> w); end if;
    if cardinality(payers) = 0 then raise exception 'Choose who pays for the last LP game before billing'; end if;
    insert into public.gc_lp_segments (session_id, from_at, to_at, winner, payers, created_by) values (s.id, (calc->'tail'->>'from_at')::timestamptz, s.end_at, w, payers, auth.uid());
    calc := public.gc_calc(s.id);
  end if;
  rt := (select string_agg(x->>'rule' || ' ' || round((x->>'minutes')::numeric) || 'm', ', ') from jsonb_array_elements(calc->'by_rule') x);
  lines := jsonb_build_array(jsonb_build_object('kind', 'game',
    'desc', (calc->'station'->>'name') || ' (' || (calc->'station'->>'type') || ') · ' || (calc->>'charged_minutes') || ' min'
            || case when s.players > 1 then ' · ' || s.players || ' players' else '' end
            || case when rt is not null and rt <> 'Standard ' || round((calc->>'active_minutes')::numeric) || 'm' then ' · ' || rt else '' end,
    'qty', 1, 'rate', (calc->>'amount')::numeric, 'amount', (calc->>'amount')::numeric));
  -- Membership hours: cover the charged time from one bucket that includes this station
  if nullif(p->'membership'->>'id', '') is not null then
    if s.is_lp then raise exception 'Membership hours can''t be used on an LP match'; end if;
    select * into mem from public.gc_memberships where id = (p->'membership'->>'id')::uuid and business_id = s.business_id for update;
    if not found or mem.status <> 'active' then raise exception 'This membership isn''t active'; end if;
    if mem.expires_on < (now() at time zone 'Asia/Kolkata')::date then raise exception 'This membership expired on %', to_char(mem.expires_on, 'DD Mon YYYY'); end if;
    if mem.starts_on > (now() at time zone 'Asia/Kolkata')::date then raise exception 'This membership starts on %', to_char(mem.starts_on, 'DD Mon YYYY'); end if;
    bi := coalesce((p->'membership'->>'bucket')::int, 0); bk := mem.buckets->bi;
    if bk is null then raise exception 'Choose which hours to use'; end if;
    if jsonb_array_length(bk->'station_ids') > 0 and not bk->'station_ids' ? s.station_id::text then raise exception '% hours can''t be used on %', bk->>'name', calc->'station'->>'name'; end if;
    mleft := (bk->>'minutes')::int - coalesce((bk->>'used')::int, 0); chg := (calc->>'charged_minutes')::int;
    mcov := least(mleft, chg);
    if mcov <= 0 then raise exception 'No hours left in %', bk->>'name'; end if;
    mamt := round((calc->>'amount')::numeric * mcov / chg, 2);
    lines := lines || jsonb_build_object('kind', 'game', 'desc', 'Membership ' || mem.plan_name || ' · ' || (bk->>'name') || ': ' || mcov || ' min used', 'qty', 1, 'rate', -mamt, 'amount', -mamt);
  end if;
  for it in select * from jsonb_array_elements(calc->'items') loop
    lines := lines || jsonb_build_object('kind', 'item', 'desc', (it->>'name') || coalesce(' (' || (it->>'assigned_to') || ')', ''),
      'qty', (it->>'qty')::numeric, 'rate', (it->>'price')::numeric, 'amount', round((it->>'qty')::numeric * (it->>'price')::numeric, 2));
  end loop;
  bl := public.gc_make_bill(s.business_id, s, calc, lines, p);
  if mcov > 0 then
    update public.gc_memberships set buckets = jsonb_set(buckets, array[bi::text, 'used'], to_jsonb(coalesce((bk->>'used')::int, 0) + mcov)) where id = mem.id;
    insert into public.gc_membership_uses (business_id, membership_id, bucket, minutes, amount, station_name, session_id, bill_id, created_by)
    values (s.business_id, mem.id, bi, mcov, mamt, calc->'station'->>'name', s.id, bl.id, auth.uid());
  end if;
  update public.gc_items set bill_id = bl.id where session_id = s.id;
  update public.gc_sessions set status = 'closed', bill_id = bl.id, customer_id = coalesce(customer_id, bl.customer_id) where id = s.id;
  return public.gc_bill_json(bl);
end $$;
create or replace function public.gc_bill_void(p_bill uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare bl public.gc_bills;
begin
  select * into bl from public.gc_bills where id = p_bill for update; if not found then raise exception 'Bill not found'; end if;
  perform public.gc_guard(bl.business_id);
  if not (public.is_staff() or public.has_perm(bl.business_id, 'settings')) then raise exception 'Only the owner can cancel a bill'; end if;
  if bl.status = 'void' then raise exception 'Already cancelled'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  update public.gc_products pr set stock = pr.stock + i.qty::int from public.gc_items i where i.bill_id = bl.id and i.product_id = pr.id and pr.track_stock;
  delete from public.gc_payments where bill_id = bl.id;
  update public.customers set spend = greatest(0, spend - bl.total) where id = bl.customer_id;
  -- give back membership hours used on this bill; a cancelled membership sale ends the membership
  update public.gc_memberships m set buckets = jsonb_set(m.buckets, array[u.bucket::text, 'used'], to_jsonb(greatest(0, coalesce((m.buckets->u.bucket->>'used')::int, 0) - u.minutes)))
    from public.gc_membership_uses u where u.bill_id = bl.id and u.membership_id = m.id;
  delete from public.gc_membership_uses where bill_id = bl.id;
  update public.gc_memberships set status = 'cancelled', notes = trim(notes || ' [Bill cancelled: ' || p_reason || ']') where bill_id = bl.id;
  update public.gc_bills set status = 'void', due = 0, notes = trim(notes || ' [Cancelled: ' || p_reason || ']') where id = bl.id;
end $$;
-- ---------- 6. Reports: sales per station ----------
create or replace function public.gc_report(p_business uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz := p_from::timestamp at time zone 'Asia/Kolkata'; z timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Kolkata'; rng numeric;
begin
  if not (public.is_staff() or (public.has_perm(p_business, 'gaming') and public.has_perm(p_business, 'settings'))) then raise exception 'Only the owner can see reports'; end if;
  rng := extract(epoch from (z - a)) * 1000;
  return jsonb_build_object(
    'summary', (select jsonb_build_object('bills', count(*), 'sales', coalesce(sum(total), 0), 'gaming', coalesce(sum(game_amount), 0), 'items', coalesce(sum(items_amount), 0),
                  'discount', coalesce(sum(discount), 0), 'tax', coalesce(sum(tax), 0), 'due', coalesce(sum(due), 0), 'lp_matches', count(*) filter (where lp is not null))
                from public.gc_bills where business_id = p_business and status <> 'void' and created_at >= a and created_at < z)
             || jsonb_build_object('collected', (select coalesce(sum(amount), 0) from public.gc_payments where business_id = p_business and created_at >= a and created_at < z),
                                   'outstanding', (select coalesce(sum(due), 0) from public.gc_bills where business_id = p_business and status <> 'void')),
    'daily', (select coalesce(jsonb_agg(x order by x.d), '[]') from (select (created_at at time zone 'Asia/Kolkata')::date d, count(*) bills, sum(total) sales, sum(game_amount) gaming, sum(items_amount) items
              from public.gc_bills where business_id = p_business and status <> 'void' and created_at >= a and created_at < z group by 1) x),
    'by_mode', (select coalesce(jsonb_agg(x order by x.amount desc), '[]') from (select mode, sum(amount) amount from public.gc_payments
                where business_id = p_business and created_at >= a and created_at < z group by mode) x),
    'by_type', (select coalesce(jsonb_agg(x order by x.amount desc), '[]') from (select coalesce(station_type, 'Counter sale') type, count(*) n, sum(game_amount) amount
                from public.gc_bills where business_id = p_business and status <> 'void' and created_at >= a and created_at < z group by 1) x),
    'by_station', (select coalesce(jsonb_agg(x order by x.total desc, x.sort, x.name), '[]') from (
        select st.id, st.name, st.type, st.sort, k.sessions, k.gaming, k.items, k.gaming + k.items total, k.member_minutes,
          case when k.sessions > 0 then round((k.gaming + k.items) / k.sessions, 2) else 0 end avg_bill,
          round((select coalesce(sum(extract(epoch from (least(coalesce(i.end_at, now()), z) - greatest(i.start_at, a)))), 0) from public.gc_intervals i join public.gc_sessions g on g.id = i.session_id
                 where g.station_id = st.id and g.status <> 'cancelled' and i.start_at < z and coalesce(i.end_at, now()) > a) / 3600, 2) hours,
          k.gaming revenue
        from public.gc_stations st cross join lateral (
          select count(v.id) sessions, coalesce(sum(v.game_amount), 0) gaming, coalesce(sum(v.items_amount), 0) items,
                 (select coalesce(sum(u.minutes), 0) from public.gc_membership_uses u join public.gc_sessions g2 on g2.id = u.session_id
                   where g2.station_id = st.id and u.created_at >= a and u.created_at < z) member_minutes
          from public.gc_bills v join public.gc_sessions g on g.id = v.session_id
          where g.station_id = st.id and v.status <> 'void' and v.created_at >= a and v.created_at < z) k
        where st.business_id = p_business) x),
    'memberships', (select jsonb_build_object('sold', count(*), 'amount', coalesce(sum(price), 0)) from public.gc_memberships
                    where business_id = p_business and status <> 'cancelled' and created_at >= a and created_at < z),
    'peak', (select coalesce(jsonb_agg(x order by x.hour), '[]') from (select extract(hour from start_at at time zone 'Asia/Kolkata')::int as hour, count(*) sessions
             from public.gc_sessions where business_id = p_business and status = 'closed' and start_at >= a and start_at < z group by 1) x),
    'items', (select coalesce(jsonb_agg(x order by x.revenue desc), '[]') from (select i.name, sum(i.qty) qty, sum(i.qty * i.price) revenue from public.gc_items i join public.gc_bills v on v.id = i.bill_id
              where v.business_id = p_business and v.status <> 'void' and v.created_at >= a and v.created_at < z group by i.name order by 3 desc limit 20) x),
    'range_hours', round(rng / 3600000, 2));
end $$;

-- ---------- 7. New prices (x4) and 75% coupons ----------
update public.packages set monthly_price = 2000, yearly_price = 20000 where slug = 'game-club';
update public.packages set monthly_price = 3600, yearly_price = 36000 where slug = 'game-club-pro';
update public.packages set monthly_price = 1600, yearly_price = 16000 where slug = 'starter';
update public.packages set monthly_price = 2400, yearly_price = 24000 where slug = 'growth';
update public.packages set monthly_price = 3600, yearly_price = 36000 where slug = 'pro';
insert into public.promo_codes (code, type, value, package_ids, active)
select 'THEGAMINGLOFT', 'percent', 75, array(select id from public.packages where slug in ('game-club','game-club-pro')), true
where not exists (select 1 from public.promo_codes where upper(code) = 'THEGAMINGLOFT');
insert into public.promo_codes (code, type, value, package_ids, active)
select 'NEW75', 'percent', 75, null, true
where not exists (select 1 from public.promo_codes where upper(code) = 'NEW75');

-- Coupon on a plan payment inside the app (renewals, trial ends, plan changes). Takes the % off the plan price only, not add-ons.
create or replace function public.apply_promo(p_payment uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay public.payments; pc record; v_pkg uuid; v_plan numeric; v_off numeric; v_amt numeric; v_gst numeric;
begin
  select * into pay from public.payments where id = p_payment for update; if not found then raise exception 'Payment not found'; end if;
  if not public.is_member(pay.business_id) then raise exception 'Not allowed'; end if;
  if pay.status <> 'pending' then raise exception 'This payment is already done'; end if;
  if pay.kind <> 'subscription' then raise exception 'Coupons work on plan payments only'; end if;
  if pay.meta->>'promo_code' is not null then raise exception 'Coupon % is already applied', pay.meta->>'promo_code'; end if;
  select * into pc from public.promo_codes where upper(code) = upper(trim(coalesce(p_code, '')));
  v_pkg := (pay.meta->>'package_id')::uuid;
  if not found or not pc.active or pc.value = 0 then raise exception 'This coupon isn''t valid'; end if;
  if pc.valid_until is not null and pc.valid_until < current_date then raise exception 'This coupon has expired'; end if;
  if pc.max_uses is not null and pc.used >= pc.max_uses then raise exception 'This coupon has been fully used'; end if;
  if pc.package_ids is not null and not v_pkg = any(pc.package_ids) then raise exception 'This coupon doesn''t apply to this plan'; end if;
  v_plan := least(pay.amount, coalesce(public.package_price(v_pkg, coalesce(pay.meta->>'billing', 'monthly')), pay.amount));
  v_off := case when pc.type = 'percent' then round(v_plan * pc.value / 100.0, 2) else least(pc.value, v_plan) end;
  v_amt := greatest(pay.amount - v_off, 0); v_gst := round(v_amt * public.gst_rate(), 2);
  update public.payments set amount = v_amt, gst = v_gst, total = v_amt + v_gst,
         description = description || ' · coupon ' || upper(pc.code) || ' (−₹' || to_char(v_off, 'FM999999990.00') || ')',
         meta = meta || jsonb_build_object('promo_code', upper(pc.code), 'promo_off', v_off)
   where id = pay.id returning * into pay;
  return to_jsonb(pay);
end $$;
revoke all on function public.apply_promo(uuid, text) from public, anon;
grant execute on function public.apply_promo(uuid, text) to authenticated;
