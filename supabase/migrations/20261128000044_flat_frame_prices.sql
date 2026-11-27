-- Flat price options per club (set by Branditude, not by the club): e.g. Gaming Loft snooker: charge 1 frame ₹120 (₹130 after midnight) instead of time; PS5: charge 30 min ₹100.
alter table public.gc_settings add column if not exists flat_opts jsonb not null default '[]';
alter table public.gc_sessions add column if not exists bill_flat text;
alter table public.gc_sessions add column if not exists bill_qty int check (bill_qty is null or bill_qty between 1 and 50);
alter table public.gc_sessions drop constraint if exists gc_sessions_bill_mode_check;
alter table public.gc_sessions add constraint gc_sessions_bill_mode_check check (bill_mode in ('auto','played','booked','custom','flat'));

-- clubs can't change flat_opts themselves (only Branditude, via the service role / SQL)
create or replace function public.gc_settings_guard_flat() returns trigger language plpgsql set search_path = public as $$
begin
  if new.flat_opts is distinct from old.flat_opts and current_user = 'authenticated' and not public.is_staff() then new.flat_opts := old.flat_opts; end if;
  return new;
end $$;
revoke execute on function public.gc_settings_guard_flat() from public, anon, authenticated;
drop trigger if exists gc_settings_guard_flat on public.gc_settings;
create trigger gc_settings_guard_flat before update on public.gc_settings for each row execute function public.gc_settings_guard_flat();

create or replace function public.gc_calc(p_session uuid, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.gc_sessions; st public.gc_stations; cf public.gc_settings; rules public.gc_rules[]; endt timestamptz;
        tot record; act_min numeric; charged int; amount numeric; nowr record; seg record; c record; segs jsonb := '[]'; per jsonb := '{}';
        tail jsonb := null; played int; auto_amt numeric; last_to timestamptz; n int; p text; items jsonb; items_total numeric; share numeric; segamt numeric; last_id bigint; tail_cost record; fixd numeric := 0; fo jsonb; flat_rate numeric; flat_night boolean;
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
  -- flat price options set by Branditude for a club (e.g. per snooker frame, pool per 30 min)
  if s.bill_mode = 'flat' then
    select o into fo from jsonb_array_elements(coalesce(cf.flat_opts, '[]')) o where o->>'key' = s.bill_flat;
    if fo is not null then
      flat_night := nullif(fo->>'night_amount', '') is not null and ((s.start_at at time zone 'Asia/Kolkata')::time >= coalesce(fo->>'night_from', '00:00')::time
                    and (s.start_at at time zone 'Asia/Kolkata')::time < coalesce(fo->>'night_to', '06:00')::time);
      flat_rate := case when flat_night then (fo->>'night_amount')::numeric else (fo->>'amount')::numeric end;
      amount := round(flat_rate * greatest(coalesce(s.bill_qty, 1), 1), 2);
      charged := played;
    end if;
  end if;
  auto_amt := amount;
  if s.bill_amount is not null then amount := s.bill_amount; end if;   -- owner set the price for this bill

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
      if seg.price is not null and s.bill_amount is null then fixd := fixd + seg.price - segamt; segamt := seg.price; end if;   -- price changed for this frame
      segs := segs || jsonb_build_object('id', seg.id, 'from_at', seg.from_at, 'to_at', seg.to_at, 'minutes', round(c.ms / 60000.0, 2), 'amount', segamt,
                                         'auto_amount', round(amount * share, 2), 'price_set', seg.price is not null,
                                         'winner', seg.winner, 'payers', to_jsonb(seg.payers), 'open', false);
      n := cardinality(seg.payers);
      foreach p in array seg.payers loop per := jsonb_set(per, array[p], to_jsonb(round(coalesce((per->>p)::numeric, 0) + segamt / n, 2))); end loop;
    end loop;
    if (last_id is null and tail_cost.ms >= 1000) or (last_id is not null and tail_cost.ms >= 60000) then
      share := case when tot.cost > 0 then tail_cost.cost / tot.cost when tot.ms > 0 then tail_cost.ms::numeric / tot.ms else 0 end;
      tail := jsonb_build_object('from_at', last_to, 'to_at', endt, 'minutes', round(tail_cost.ms / 60000.0, 2), 'amount', round(amount * share, 2), 'open', true);
      segs := segs || tail;
    end if;
    amount := round(amount + fixd, 2);
    foreach p in array s.lp_players loop if not per ? p then per := per || jsonb_build_object(p, 0); end if; end loop;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'qty', i.qty, 'price', i.price, 'assigned_to', i.assigned_to, 'product_id', i.product_id) order by i.id), '[]'),
         coalesce(sum(i.qty * i.price), 0)
    into items, items_total from public.gc_items i where i.session_id = s.id;

  return jsonb_build_object(
    'active_ms', tot.ms, 'active_minutes', round(act_min, 2), 'charged_minutes', charged, 'amount', amount,
    'bill_mode', s.bill_mode, 'bill_amount', s.bill_amount, 'auto_amount', auto_amt, 'bill_minutes', s.bill_minutes, 'bill_flat', s.bill_flat, 'bill_qty', s.bill_qty,
    'flat_label', fo->>'label', 'flat_rate', flat_rate, 'flat_night', flat_night, 'booked_minutes', s.booked_minutes, 'played_minutes', played,
    'rate_hour', round(case when tot.ms > 0 then tot.cost / act_min * 60 else nowr.rate end, 2),
    'rate_now', round(nowr.rate, 2), 'rule_now', nowr.rule,
    'by_rule', (select coalesce(jsonb_agg(jsonb_build_object('rule', k, 'minutes', round((v->>'ms')::numeric / 60000, 1), 'cost', round((v->>'cost')::numeric, 2))), '[]') from jsonb_each(tot.by_rule) x(k, v)),
    'segments', segs, 'tail', tail, 'per_player', per, 'lp_players', to_jsonb(s.lp_players),
    'items', items, 'items_total', round(items_total, 2),
    'remaining_ms', case when s.booked_minutes > 0 then s.booked_minutes * 60000 - tot.ms end,
    'station', jsonb_build_object('id', st.id, 'name', st.name, 'type', st.type));
end $$;

-- options that fit this session's station (matched by station type or station name)
create or replace function public.gc_flat_opts_for(s public.gc_sessions) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(o), '[]') from public.gc_settings cf, public.gc_stations st, jsonb_array_elements(cf.flat_opts) o
  where cf.business_id = s.business_id and st.id = s.station_id
    and (o->'types' ? st.type or o->'stations' ? st.name)
$$;
revoke execute on function public.gc_flat_opts_for(public.gc_sessions) from public, anon, authenticated;

drop function if exists public.gc_bill_time(uuid, text, int);
create or replace function public.gc_bill_time(p_session uuid, p_mode text, p_minutes int default null, p_flat text default null, p_qty int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions;
begin
  select * into s from public.gc_sessions where id = p_session for update; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if s.status in ('closed','cancelled') then raise exception 'This session is already closed'; end if;
  if p_mode not in ('auto','played','booked','custom','flat') then raise exception 'Unknown option'; end if;
  if p_mode = 'custom' and not public.gc_can_setup(s.business_id) then raise exception 'Only the owner can charge other minutes'; end if;
  if p_mode = 'custom' and (p_minutes is null or p_minutes < 0 or p_minutes > 1440) then raise exception 'Enter the minutes to charge'; end if;
  if p_mode = 'flat' then
    if not exists (select 1 from jsonb_array_elements(public.gc_flat_opts_for(s)) o where o->>'key' = p_flat) then raise exception 'This option isn''t available here'; end if;
    if coalesce(p_qty, 0) < 1 or p_qty > 50 then raise exception 'Enter how many'; end if;
  end if;
  update public.gc_sessions set bill_mode = p_mode, bill_minutes = case when p_mode = 'custom' then p_minutes end,
         bill_flat = case when p_mode = 'flat' then p_flat end, bill_qty = case when p_mode = 'flat' then p_qty end,
         bill_amount = case when p_mode = s.bill_mode then bill_amount end where id = s.id;
  return public.gc_view(s.id);
end $$;
revoke execute on function public.gc_bill_time(uuid, text, int, text, int) from public, anon;
grant execute on function public.gc_bill_time(uuid, text, int, text, int) to authenticated;

create or replace function public.gc_view(p_session uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(s) || jsonb_build_object('calc', public.gc_calc(s.id), 'flat_opts', public.gc_flat_opts_for(s),
    'paused_at', case when s.status = 'paused' then (select max(end_at) from public.gc_intervals where session_id = s.id) end)
  from public.gc_sessions s where s.id = p_session
$$;
revoke execute on function public.gc_view(uuid) from public, anon, authenticated;

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
    insert into public.gc_lp_segments (session_id, from_at, to_at, winner, payers, price, created_by) values (s.id, (calc->'tail'->>'from_at')::timestamptz, s.end_at, w, payers,
      case when nullif(p->'lp_final'->>'price', '') is not null then greatest(round((p->'lp_final'->>'price')::numeric, 2), 0) end, auth.uid());
    calc := public.gc_calc(s.id);
  end if;
  rt := (select string_agg(x->>'rule' || ' ' || round((x->>'minutes')::numeric) || 'm', ', ') from jsonb_array_elements(calc->'by_rule') x);
  lines := jsonb_build_array(jsonb_build_object('kind', 'game',
    'desc', (calc->'station'->>'name') || ' (' || (calc->'station'->>'type') || ') · ' || case when calc->>'flat_label' is not null and s.bill_mode = 'flat' then (calc->>'flat_label') || ' (' || round((calc->>'active_minutes')::numeric) || ' min played)' else (calc->>'charged_minutes') || ' min' end
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

-- Gaming Loft only
update public.gc_settings set flat_opts = '[
  {"key":"frame","label":"1 frame","unit":"frame","types":["Snooker"],"amount":120,"night_amount":130,"night_from":"00:00","night_to":"06:00"},
  {"key":"ps30","label":"30 min","unit":"half-hour","types":["PS5"],"amount":100}
]'::jsonb where business_id in (select id from public.businesses where name ilike 'gaming loft');
