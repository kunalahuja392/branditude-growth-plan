-- Billing controls (17 Nov 2026):
--  * staff choose time played or the full booking; only owners can type other minutes
--  * owners can change the gaming price on a bill (e.g. ₹420 → ₹490); staff don't see this option
--  * board knows when a session was paused, for the "still paused?" popup
alter table public.gc_sessions add column if not exists bill_amount numeric(12,2) check (bill_amount is null or bill_amount >= 0);

create or replace function public.gc_calc(p_session uuid, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.gc_sessions; st public.gc_stations; cf public.gc_settings; rules public.gc_rules[]; endt timestamptz;
        tot record; act_min numeric; charged int; amount numeric; nowr record; seg record; c record; segs jsonb := '[]'; per jsonb := '{}';
        tail jsonb := null; played int; auto_amt numeric; last_to timestamptz; n int; p text; items jsonb; items_total numeric; share numeric; segamt numeric; last_id bigint; tail_cost record;
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
    'bill_mode', s.bill_mode, 'bill_amount', s.bill_amount, 'auto_amount', auto_amt, 'bill_minutes', s.bill_minutes, 'booked_minutes', s.booked_minutes, 'played_minutes', played,
    'rate_hour', round(case when tot.ms > 0 then tot.cost / act_min * 60 else nowr.rate end, 2),
    'rate_now', round(nowr.rate, 2), 'rule_now', nowr.rule,
    'by_rule', (select coalesce(jsonb_agg(jsonb_build_object('rule', k, 'minutes', round((v->>'ms')::numeric / 60000, 1), 'cost', round((v->>'cost')::numeric, 2))), '[]') from jsonb_each(tot.by_rule) x(k, v)),
    'segments', segs, 'tail', tail, 'per_player', per, 'lp_players', to_jsonb(s.lp_players),
    'items', items, 'items_total', round(items_total, 2),
    'remaining_ms', case when s.booked_minutes > 0 then s.booked_minutes * 60000 - tot.ms end,
    'station', jsonb_build_object('id', st.id, 'name', st.name, 'type', st.type));
end $$;

create or replace function public.gc_bill_time(p_session uuid, p_mode text, p_minutes int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions;
begin
  select * into s from public.gc_sessions where id = p_session for update; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if s.status in ('closed','cancelled') then raise exception 'This session is already closed'; end if;
  if p_mode not in ('auto','played','booked','custom') then raise exception 'Unknown option'; end if;
  if p_mode = 'custom' and not public.gc_can_setup(s.business_id) then raise exception 'Only the owner can charge other minutes'; end if;
  if p_mode = 'custom' and (p_minutes is null or p_minutes < 0 or p_minutes > 1440) then raise exception 'Enter the minutes to charge'; end if;
  update public.gc_sessions set bill_mode = p_mode, bill_minutes = case when p_mode = 'custom' then p_minutes end,
         bill_amount = case when p_mode = s.bill_mode then bill_amount end where id = s.id;
  return public.gc_view(s.id);
end $$;
grant execute on function public.gc_bill_time(uuid, text, int) to authenticated;

-- Owner: set the gaming price for this bill (null = back to the calculated price)
create or replace function public.gc_bill_price(p_session uuid, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions;
begin
  select * into s from public.gc_sessions where id = p_session for update; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if not public.gc_can_setup(s.business_id) then raise exception 'Only the owner can change the price'; end if;
  if s.status in ('closed','cancelled') then raise exception 'This session is already closed'; end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 1000000) then raise exception 'Enter a valid amount'; end if;
  update public.gc_sessions set bill_amount = round(p_amount, 2) where id = s.id;
  return public.gc_view(s.id);
end $$;
revoke execute on function public.gc_bill_price(uuid, numeric) from public, anon;
grant execute on function public.gc_bill_price(uuid, numeric) to authenticated;

create or replace function public.gc_view(p_session uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(s) || jsonb_build_object('calc', public.gc_calc(s.id),
    'paused_at', case when s.status = 'paused' then (select max(end_at) from public.gc_intervals where session_id = s.id) end)
  from public.gc_sessions s where s.id = p_session
$$;
revoke execute on function public.gc_view(uuid) from public, anon, authenticated;

-- A price the owner set no longer applies once the timer runs again
create or replace function public.gc_session_reset_price() returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'running' and old.status is distinct from 'running' then new.bill_amount := null; end if;
  return new;
end $$;
revoke execute on function public.gc_session_reset_price() from public, anon, authenticated;
drop trigger if exists gc_session_reset_price on public.gc_sessions;
create trigger gc_session_reset_price before update of status on public.gc_sessions for each row execute function public.gc_session_reset_price();
