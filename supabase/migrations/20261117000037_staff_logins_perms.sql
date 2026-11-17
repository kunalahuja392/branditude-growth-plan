-- Rounding to the nearest ₹5 / ₹10, staff logins with a password set by the owner, and finer front-desk permissions:
--   g_sales    see sales totals (today's sales on the board, sales on the bills page)
--   g_reports  open gaming reports
--   g_stock    add and edit snacks / items and stock
--   g_discount give discounts on bills
-- Owners and admins have all of them. Existing front-desk staff keep what they could do before (sales and discounts).
alter table public.gc_settings add column if not exists round_mode text not null default 'up';
alter table public.gc_settings drop constraint if exists gc_settings_round_mode_check;
alter table public.gc_settings add constraint gc_settings_round_mode_check check (round_mode in ('up','nearest'));

create or replace function public.perm_areas() returns text[] language sql immutable set search_path = public as $$
  select '{customers,reviews,whatsapp,menu,attendance,accounts,settings,gaming,g_sales,g_reports,g_stock,g_discount}'::text[]
$$;
update public.business_members set perms = array(select distinct x from unnest(perms || '{g_sales,g_discount}'::text[]) x)
 where role = 'staff' and 'gaming' = any(perms);
update public.business_invites set perms = array(select distinct x from unnest(perms || '{g_sales,g_discount}'::text[]) x)
 where role = 'staff' and 'gaming' = any(perms);

-- Items and stock: owners, admins, and staff allowed to add stock
create or replace function public.gc_can_stock(b uuid) returns boolean
language sql stable security definer set search_path = public as $$ select public.gc_can_setup(b) or (public.gc_can(b) and public.has_perm(b, 'g_stock')) $$;
revoke execute on function public.gc_can_stock(uuid) from public, anon;
grant execute on function public.gc_can_stock(uuid) to authenticated;
drop policy if exists gc_products_write on public.gc_products;
create policy gc_products_write on public.gc_products for all using (public.gc_can_stock(business_id)) with check (public.gc_can_stock(business_id));
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
  if disc > 0 and auth.uid() is not null and not (public.is_staff() or public.has_perm(b, 'g_discount')) then raise exception 'Your login can''t give discounts. Ask the owner.'; end if;
  rounded := case when coalesce(cf.round_to, 1) <= 1 then round(total)
                  when cf.round_mode = 'nearest' then round(round(total, 2) / cf.round_to) * cf.round_to
                  else ceil(round(total, 2) / cf.round_to) * cf.round_to end;
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
create or replace function public.gc_board(p_business uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t0 timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'; cf public.gc_settings;
begin
  perform public.gc_guard(p_business);
  cf := public.gc_cfg(p_business);
  return jsonb_build_object(
    'now', now(), 'settings', to_jsonb(cf),
    'stations', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.name), '[]') from public.gc_stations x where x.business_id = p_business and x.active),
    'sessions', (select coalesce(jsonb_agg(public.gc_view(x.id)), '[]') from public.gc_sessions x where x.business_id = p_business and x.status in ('running','paused','billing')),
    'today', case when public.is_staff() or public.has_perm(p_business, 'g_sales') then (select jsonb_build_object('bills', count(*), 'sales', coalesce(sum(total), 0), 'due', coalesce(sum(due), 0))
              from public.gc_bills where business_id = p_business and created_at >= t0 and status <> 'void')
             || jsonb_build_object('collected', (select coalesce(sum(amount), 0) from public.gc_payments where business_id = p_business and created_at >= t0)) end,
    'bookings', (select coalesce(jsonb_agg(to_jsonb(k) || jsonb_build_object('station_name', st.name) order by k.start_at), '[]')
                 from public.gc_bookings k left join public.gc_stations st on st.id = k.station_id
                 where k.business_id = p_business and k.status in ('pending','confirmed') and k.start_at between now() - interval '2 hours' and now() + interval '1 day'),
    'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'stock', stock)), '[]') from public.gc_products
                  where business_id = p_business and active and track_stock and stock <= low_stock));
end $$;
create or replace function public.gc_report(p_business uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a timestamptz := p_from::timestamp at time zone 'Asia/Kolkata'; z timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Kolkata'; rng numeric;
begin
  if not (public.is_staff() or (public.has_perm(p_business, 'gaming') and public.has_perm(p_business, 'g_reports'))) then raise exception 'Your login can''t see reports. Ask the owner.'; end if;
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
create or replace function public.gc_category(p_business uuid, p_action text, p_name text, p_new text default null) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_name text := trim(coalesce(p_name, '')); v_new text := trim(coalesce(p_new, '')); cats text[];
begin
  if not public.gc_can_stock(p_business) then raise exception 'Not allowed'; end if;
  perform public.gc_cfg(p_business);
  select snack_categories into cats from public.gc_settings where business_id = p_business;
  if p_action = 'add' then
    if v_name = '' then raise exception 'Type a category name'; end if;
    if lower(v_name) = any(select lower(unnest(cats))) then raise exception '% is already there', v_name; end if;
    cats := cats || v_name;
  elsif p_action = 'rename' then
    if v_new = '' then raise exception 'Type the new name'; end if;
    if lower(v_new) <> lower(v_name) and lower(v_new) = any(select lower(unnest(cats))) then raise exception '% is already there', v_new; end if;
    cats := array(select case when c = v_name then v_new else c end from unnest(cats) c);
    update public.gc_products set category = v_new where business_id = p_business and category = v_name;
  elsif p_action = 'delete' then
    v_new := coalesce(nullif(v_new, ''), 'Other');
    cats := array(select c from unnest(cats) c where c <> v_name);
    if exists (select 1 from public.gc_products where business_id = p_business and category = v_name) and not v_new = any(cats) then cats := cats || v_new; end if;
    update public.gc_products set category = v_new where business_id = p_business and category = v_name;
  else raise exception 'Unknown action'; end if;
  update public.gc_settings set snack_categories = cats where business_id = p_business;
  return cats;
end $$;

-- Team logins with a password (called only by the team-login Edge Function, with the service role)
-- Can this person (actor) manage that member? Raises if not.
create or replace function public.team_manage_check(p_business uuid, p_actor uuid, p_target uuid, p_role text) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_my text; v_cur text;
begin
  select role into v_my from public.business_members where business_id = p_business and user_id = p_actor;
  if not (coalesce(v_my, '') in ('owner','admin') or exists (select 1 from public.profiles where id = p_actor and role in ('super_admin','team'))) then
    raise exception 'Only the owner or an admin can manage the team'; end if;
  if p_role is not null and p_role not in ('admin','staff') then raise exception 'Role must be admin or staff'; end if;
  if p_role = 'admin' and coalesce(v_my, '') <> 'owner' then raise exception 'Only the owner can add an admin'; end if;
  if p_target is not null then
    select role into v_cur from public.business_members where business_id = p_business and user_id = p_target;
    if v_cur = 'owner' then raise exception 'That''s the owner''s login'; end if;
    if v_cur = 'admin' and coalesce(v_my, '') <> 'owner' then raise exception 'Only the owner can change an admin'; end if;
  end if;
end $$;
revoke execute on function public.team_manage_check(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.team_manage_check(uuid, uuid, uuid, text) to service_role;

-- A login the business may set a password for: it belongs only to this business and is nobody's own account elsewhere
create or replace function public.team_login_resettable(p_business uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.business_members where user_id = p_user and business_id <> p_business)
     and not exists (select 1 from public.businesses where owner_id = p_user)
     and not exists (select 1 from public.profiles where id = p_user and role in ('super_admin','team'))
     and not exists (select 1 from public.agents a join auth.users u on u.id = p_user where a.email <> '' and lower(a.email) = lower(u.email))
$$;
revoke execute on function public.team_login_resettable(uuid, uuid) from public, anon, authenticated;
grant execute on function public.team_login_resettable(uuid, uuid) to service_role;

create or replace function public.team_attach(p_business uuid, p_actor uuid, p_user uuid, p_role text, p_perms text[], p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_perms text[];
begin
  perform public.team_manage_check(p_business, p_actor, p_user, p_role);
  v_perms := case when p_role = 'admin' then '{}'::text[] else array(select distinct x from unnest(coalesce(p_perms, '{}')) x where x = any(public.perm_areas())) end;
  if p_role = 'staff' and cardinality(v_perms) = 0 then raise exception 'Choose at least one thing this person can do'; end if;
  insert into public.business_members (business_id, user_id, role, perms) values (p_business, p_user, p_role, v_perms)
    on conflict (business_id, user_id) do update set role = excluded.role, perms = excluded.perms;
  update public.profiles set role = 'business', full_name = coalesce(nullif(trim(p_name), ''), full_name) where id = p_user and role in ('customer','business');
  delete from public.business_invites where business_id = p_business and email = (select lower(email) from auth.users where id = p_user);
end $$;
revoke execute on function public.team_attach(uuid, uuid, uuid, text, text[], text) from public, anon, authenticated;
grant execute on function public.team_attach(uuid, uuid, uuid, text, text[], text) to service_role;

create or replace function public.auth_user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public as $$ select id from auth.users where lower(email) = lower(trim(p_email)) limit 1 $$;
revoke execute on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;
