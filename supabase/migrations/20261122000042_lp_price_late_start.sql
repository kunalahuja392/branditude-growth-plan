-- LP: a frame's price can be changed (e.g. ₹60 charged as ₹120). Late booking: start the timer from the booked time.
alter table public.gc_lp_segments add column if not exists price numeric(12,2) check (price >= 0);

create or replace function public.gc_calc(p_session uuid, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.gc_sessions; st public.gc_stations; cf public.gc_settings; rules public.gc_rules[]; endt timestamptz;
        tot record; act_min numeric; charged int; amount numeric; nowr record; seg record; c record; segs jsonb := '[]'; per jsonb := '{}';
        tail jsonb := null; played int; auto_amt numeric; last_to timestamptz; n int; p text; items jsonb; items_total numeric; share numeric; segamt numeric; last_id bigint; tail_cost record; fixd numeric := 0;
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
    'bill_mode', s.bill_mode, 'bill_amount', s.bill_amount, 'auto_amount', auto_amt, 'bill_minutes', s.bill_minutes, 'booked_minutes', s.booked_minutes, 'played_minutes', played,
    'rate_hour', round(case when tot.ms > 0 then tot.cost / act_min * 60 else nowr.rate end, 2),
    'rate_now', round(nowr.rate, 2), 'rule_now', nowr.rule,
    'by_rule', (select coalesce(jsonb_agg(jsonb_build_object('rule', k, 'minutes', round((v->>'ms')::numeric / 60000, 1), 'cost', round((v->>'cost')::numeric, 2))), '[]') from jsonb_each(tot.by_rule) x(k, v)),
    'segments', segs, 'tail', tail, 'per_player', per, 'lp_players', to_jsonb(s.lp_players),
    'items', items, 'items_total', round(items_total, 2),
    'remaining_ms', case when s.booked_minutes > 0 then s.booked_minutes * 60000 - tot.ms end,
    'station', jsonb_build_object('id', st.id, 'name', st.name, 'type', st.type));
end $$;


drop function if exists public.gc_lp_split(uuid, text, text[]);
create or replace function public.gc_lp_split(p_session uuid, p_winner text, p_payers text[], p_price numeric default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions; last_to timestamptz; t timestamptz; payers text[]; w text := nullif(trim(coalesce(p_winner, '')), '');
begin
  select * into s from public.gc_sessions where id = p_session for update; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if not s.is_lp then raise exception 'This is not an LP match'; end if;
  if s.status not in ('running','paused','billing') then raise exception 'This session is closed'; end if;
  if w is not null and w <> 'Draw' and not (w = any(s.lp_players)) then raise exception 'The winner must be one of the players'; end if;
  if p_price is not null and p_price < 0 then raise exception 'The price can''t be below zero'; end if;
  payers := array(select distinct trim(x) from unnest(coalesce(p_payers, '{}')) x where trim(x) <> '');
  if cardinality(payers) = 0 and w is not null and w <> 'Draw' and cardinality(s.lp_players) = 2 then payers := array(select x from unnest(s.lp_players) x where x <> w); end if;
  if cardinality(payers) = 0 then raise exception 'Choose who pays for this time'; end if;
  if exists (select 1 from unnest(payers) x where not (x = any(s.lp_players))) then raise exception 'Unknown player'; end if;
  select coalesce(max(to_at), s.start_at) into last_to from public.gc_lp_segments where session_id = s.id;
  t := coalesce(s.end_at, now());
  if t - last_to < interval '1 second' then raise exception 'No time played since the last split'; end if;
  insert into public.gc_lp_segments (session_id, from_at, to_at, winner, payers, price, created_by) values (s.id, last_to, t, w, payers, round(p_price, 2), auth.uid());
  return public.gc_view(s.id);
end $$;
revoke execute on function public.gc_lp_split(uuid, text, text[], numeric) from public, anon;
grant execute on function public.gc_lp_split(uuid, text, text[], numeric) to authenticated;

-- change the price of a frame already split (null = back to the timer price)
create or replace function public.gc_lp_price(p_segment bigint, p_price numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions; g public.gc_lp_segments;
begin
  select * into g from public.gc_lp_segments where id = p_segment; if not found then raise exception 'Game not found'; end if;
  select * into s from public.gc_sessions where id = g.session_id for update;
  perform public.gc_guard(s.business_id);
  if s.status not in ('running','paused','billing') then raise exception 'This session is closed'; end if;
  if p_price is not null and p_price < 0 then raise exception 'The price can''t be below zero'; end if;
  update public.gc_lp_segments set price = round(p_price, 2) where id = g.id;
  return public.gc_view(s.id);
end $$;
revoke execute on function public.gc_lp_price(bigint, numeric) from public, anon;
grant execute on function public.gc_lp_price(bigint, numeric) to authenticated;

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

create or replace function public.gc_start(p_business uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare st public.gc_stations; lp text[]; v uuid; c uuid; bk public.gc_bookings; t0 timestamptz := now();
begin
  perform public.gc_guard(p_business);
  select * into st from public.gc_stations where id = (p->>'station_id')::uuid and business_id = p_business and active;
  if not found then raise exception 'Station not found'; end if;
  if exists (select 1 from public.gc_sessions where station_id = st.id and status in ('running','paused','billing')) then raise exception '% is already in use', st.name; end if;
  if coalesce((p->>'is_lp')::boolean, false) then
    lp := array(select trim(x) from jsonb_array_elements_text(coalesce(p->'lp_players', '[]')) x where trim(x) <> '');
    if cardinality(lp) < 2 then raise exception 'An LP match needs at least 2 player names'; end if;
    if (select count(distinct lower(x)) from unnest(lp) x) <> cardinality(lp) then raise exception 'Player names must be different'; end if;
  else lp := '{}'; end if;
  -- start from the booked time when the customer came late (staff choose this)
  if coalesce(p->>'start_from', '') = 'booking' and nullif(p->>'booking_id', '') is not null then
    select * into bk from public.gc_bookings where id = (p->>'booking_id')::uuid and business_id = p_business;
    if found and bk.start_at < now() then
      if bk.start_at < now() - interval '6 hours' then raise exception 'That booking started more than 6 hours ago'; end if;
      t0 := greatest(bk.start_at, coalesce((select max(i.end_at) from public.gc_intervals i join public.gc_sessions g on g.id = i.session_id
                                               where g.station_id = st.id and g.status <> 'cancelled' and i.end_at <= now()), bk.start_at));
    end if;
  end if;
  c := public.gc_customer(p_business, coalesce(nullif(p->>'customer_name', ''), lp[1]), p->>'customer_phone');
  insert into public.gc_sessions (business_id, station_id, start_at, customer_id, customer_name, customer_phone, players, booked_minutes, is_lp, lp_players, notes, booking_id, created_by)
  values (p_business, st.id, t0, c,
          coalesce(nullif(trim(p->>'customer_name'), ''), case when cardinality(lp) > 0 then array_to_string(lp, ' vs ') else '' end),
          (select phone from public.customers where id = c),
          greatest(coalesce((p->>'players')::int, 1), greatest(cardinality(lp), 1)), greatest(coalesce((p->>'booked_minutes')::int, 0), 0),
          cardinality(lp) > 0, lp, coalesce(p->>'notes', ''), nullif(p->>'booking_id', '')::uuid, auth.uid())
  returning id into v;
  insert into public.gc_intervals (session_id, start_at) values (v, t0);
  if nullif(p->>'booking_id', '') is not null then update public.gc_bookings set status = 'arrived' where id = (p->>'booking_id')::uuid and business_id = p_business; end if;
  return public.gc_view(v);
end $$;
