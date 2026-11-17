-- Owner / admin: add a session that wasn't recorded at the time (e.g. snooker 10–11 pm entered at midnight).
-- The price comes from the rates at that time (or the amount the owner types); the bill is dated when it was played.

-- Price for a station between two times, minute by minute at the rates in force then (same rules as a live session)
create or replace function public.gc_past_quote(p_business uuid, p_station uuid, p_from timestamptz, p_to timestamptz, p_players int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare st public.gc_stations; cf public.gc_settings; rules public.gc_rules[]; t timestamptz; r record; cost numeric := 0; m int; charged int; byr jsonb := '{}';
begin
  if not public.gc_can_setup(p_business) then raise exception 'Only the owner can add past entries'; end if;
  select * into st from public.gc_stations where id = p_station and business_id = p_business; if not found then raise exception 'Choose a station'; end if;
  if p_to <= p_from then raise exception 'The end time must be after the start time'; end if;
  if p_to - p_from > interval '24 hours' then raise exception 'An entry can be at most 24 hours'; end if;
  cf := public.gc_cfg(p_business);
  rules := array(select x from public.gc_rules x where x.business_id = p_business and x.active);
  m := ceil(extract(epoch from (p_to - p_from)) / 60 - 0.000001)::int;
  t := p_from;
  while t < p_to loop
    r := public.gc_rate_at(st, rules, greatest(coalesce(p_players, 1), 1), t);
    cost := cost + r.rate * least(1, extract(epoch from (p_to - t)) / 60) / 60;
    byr := jsonb_set(byr, array[coalesce(r.rule, 'Standard')], to_jsonb(coalesce((byr->>coalesce(r.rule, 'Standard'))::int, 0) + 1));
    t := t + interval '1 minute';
  end loop;
  charged := m;
  if cf.min_minutes > 0 then charged := greatest(charged, cf.min_minutes); end if;
  if cf.round_minutes > 1 then charged := ceil(charged::numeric / cf.round_minutes)::int * cf.round_minutes; end if;
  return jsonb_build_object('minutes', m, 'charged_minutes', charged, 'amount', round(case when m > 0 then cost * charged / (extract(epoch from (p_to - p_from)) / 60) else 0 end, 2),
    'by_rule', (select coalesce(jsonb_agg(jsonb_build_object('rule', k, 'minutes', v::int)), '[]') from jsonb_each_text(byr) x(k, v)),
    'overlap', (select jsonb_agg(jsonb_build_object('from', i.start_at, 'to', coalesce(i.end_at, now()), 'customer', g.customer_name))
                from public.gc_intervals i join public.gc_sessions g on g.id = i.session_id
                where g.station_id = st.id and g.status <> 'cancelled' and i.start_at < p_to and coalesce(i.end_at, now()) > p_from));
end $$;
revoke execute on function public.gc_past_quote(uuid, uuid, timestamptz, timestamptz, int) from public, anon;
grant execute on function public.gc_past_quote(uuid, uuid, timestamptz, timestamptz, int) to authenticated;

-- p: station_id, start_at, end_at, players, customer_name, customer_phone, amount (optional: gaming price), items [{product_id | name, price, qty}],
--    discount, payments, notes, allow_overlap
create or replace function public.gc_past_entry(p_business uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare st public.gc_stations; s public.gc_sessions; a timestamptz; z timestamptz; qt jsonb; c uuid; it jsonb; pr public.gc_products; q numeric;
        calc jsonb; lines jsonb; bl public.gc_bills; amt numeric; who text;
begin
  if not public.gc_can_setup(p_business) then raise exception 'Only the owner can add past entries'; end if;
  perform public.gc_guard(p_business);
  a := (p->>'start_at')::timestamptz; z := (p->>'end_at')::timestamptz;
  if a is null or z is null then raise exception 'Enter the start and end time'; end if;
  if z > now() + interval '2 minutes' then raise exception 'The end time is in the future. Use Start session for a game that is still on.'; end if;
  if a < now() - interval '60 days' then raise exception 'Past entries can go back 60 days at most'; end if;
  qt := public.gc_past_quote(p_business, (p->>'station_id')::uuid, a, z, coalesce((p->>'players')::int, 1));
  if qt->'overlap' is not null and jsonb_typeof(qt->'overlap') = 'array' and not coalesce((p->>'allow_overlap')::boolean, false) then
    raise exception 'This station was already in use at that time (% to %). Tick "Add anyway" if this is right.',
      to_char((qt->'overlap'->0->>'from')::timestamptz at time zone 'Asia/Kolkata', 'HH12:MI am'), to_char((qt->'overlap'->0->>'to')::timestamptz at time zone 'Asia/Kolkata', 'HH12:MI am');
  end if;
  select * into st from public.gc_stations where id = (p->>'station_id')::uuid;
  c := public.gc_customer(p_business, p->>'customer_name', p->>'customer_phone');
  amt := case when coalesce(p->>'amount', '') = '' then null else round((p->>'amount')::numeric, 2) end;
  if amt is not null and amt < 0 then raise exception 'Enter a valid amount'; end if;
  insert into public.gc_sessions (business_id, station_id, customer_id, customer_name, customer_phone, players, start_at, end_at, status, notes, created_by, bill_mode, bill_amount)
  values (p_business, st.id, c, coalesce(nullif(trim(p->>'customer_name'), ''), ''), (select phone from public.customers where id = c), greatest(coalesce((p->>'players')::int, 1), 1),
          a, z, 'closed', trim('Added later · ' || coalesce(p->>'notes', '')), auth.uid(), 'played', amt)
  returning * into s;
  insert into public.gc_intervals (session_id, start_at, end_at) values (s.id, a, z);
  for it in select * from jsonb_array_elements(coalesce(p->'items', '[]')) loop
    q := greatest(coalesce((it->>'qty')::numeric, 1), 1); pr := null;
    if nullif(it->>'product_id', '') is not null then
      select * into pr from public.gc_products where id = (it->>'product_id')::uuid and business_id = p_business for update;
      if not found then raise exception 'Item not found'; end if;
      if pr.track_stock then update public.gc_products set stock = stock - q::int where id = pr.id; end if;
      insert into public.gc_items (business_id, session_id, product_id, name, qty, price) values (p_business, s.id, pr.id, pr.name, q, coalesce((it->>'price')::numeric, pr.price));
    elsif nullif(trim(it->>'name'), '') is not null then
      insert into public.gc_items (business_id, session_id, name, qty, price) values (p_business, s.id, trim(it->>'name'), q, coalesce((it->>'price')::numeric, 0));
    end if;
  end loop;
  calc := public.gc_calc(s.id);
  lines := jsonb_build_array(jsonb_build_object('kind', 'game',
    'desc', st.name || ' (' || st.type || ') · ' || (calc->>'charged_minutes') || ' min · ' || to_char(a at time zone 'Asia/Kolkata', 'HH12:MI am') || '–' || to_char(z at time zone 'Asia/Kolkata', 'HH12:MI am')
            || case when s.players > 1 then ' · ' || s.players || ' players' else '' end,
    'qty', 1, 'rate', (calc->>'amount')::numeric, 'amount', (calc->>'amount')::numeric));
  for it in select * from jsonb_array_elements(calc->'items') loop
    lines := lines || jsonb_build_object('kind', 'item', 'desc', it->>'name', 'qty', (it->>'qty')::numeric, 'rate', (it->>'price')::numeric, 'amount', round((it->>'qty')::numeric * (it->>'price')::numeric, 2));
  end loop;
  bl := public.gc_make_bill(p_business, s, calc, lines, p || jsonb_build_object('notes', 'Added later by the owner' || coalesce(' · ' || nullif(trim(p->>'notes'), ''), '')));
  -- date the bill, its payments and the customer visit when the game was played
  update public.gc_bills set created_at = z where id = bl.id returning * into bl;
  update public.gc_payments set created_at = z where bill_id = bl.id;
  update public.visits set created_at = z where id = (select id from public.visits where business_id = p_business and created_at = now() order by id desc limit 1);
  update public.gc_items set bill_id = bl.id where session_id = s.id;
  update public.gc_sessions set bill_id = bl.id where id = s.id;
  return public.gc_bill_json(bl);
end $$;
revoke execute on function public.gc_past_entry(uuid, jsonb) from public, anon;
grant execute on function public.gc_past_entry(uuid, jsonb) to authenticated;
