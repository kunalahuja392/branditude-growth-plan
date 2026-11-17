-- Business day end (e.g. 2 am: sales until 2 am count for the previous date) and the cash book with day close.
alter table public.gc_settings add column if not exists day_end time not null default '00:00';
alter table public.gc_settings drop constraint if exists gc_settings_day_end_check;
alter table public.gc_settings add constraint gc_settings_day_end_check check (day_end <= '08:00');
alter table public.gc_settings add column if not exists cash_start date;
alter table public.gc_settings add column if not exists cash_open_cash numeric(12,2) not null default 0;
alter table public.gc_settings add column if not exists cash_open_bank numeric(12,2) not null default 0;

-- Which business date a moment belongs to, and when a business date starts
create or replace function public.gc_bday(b uuid, ts timestamptz default now()) returns date
language sql stable security definer set search_path = public as $$
  select ((ts at time zone 'Asia/Kolkata') - coalesce((select day_end from public.gc_settings where business_id = b), '00:00')::interval)::date
$$;
create or replace function public.gc_day_start(b uuid, d date) returns timestamptz
language sql stable security definer set search_path = public as $$
  select (d::timestamp + coalesce((select day_end from public.gc_settings where business_id = b), '00:00')::interval) at time zone 'Asia/Kolkata'
$$;
revoke execute on function public.gc_bday(uuid, timestamptz) from public, anon;
revoke execute on function public.gc_day_start(uuid, date) from public, anon;
grant execute on function public.gc_bday(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.gc_day_start(uuid, date) to authenticated, service_role;
create or replace function public.gc_board(p_business uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t0 timestamptz := public.gc_day_start(p_business, public.gc_bday(p_business, now())); cf public.gc_settings;
begin
  perform public.gc_guard(p_business);
  cf := public.gc_cfg(p_business);
  return jsonb_build_object(
    'now', now(), 'settings', to_jsonb(cf), 'bday', public.gc_bday(p_business, now()),
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
declare a timestamptz := public.gc_day_start(p_business, p_from); z timestamptz := public.gc_day_start(p_business, p_to + 1); rng numeric;
        de interval := coalesce((select day_end from public.gc_settings where business_id = p_business), '00:00')::interval;
begin
  if not (public.is_staff() or (public.has_perm(p_business, 'gaming') and public.has_perm(p_business, 'g_reports'))) then raise exception 'Your login can''t see reports. Ask the owner.'; end if;
  rng := extract(epoch from (z - a)) * 1000;
  return jsonb_build_object(
    'summary', (select jsonb_build_object('bills', count(*), 'sales', coalesce(sum(total), 0), 'gaming', coalesce(sum(game_amount), 0), 'items', coalesce(sum(items_amount), 0),
                  'discount', coalesce(sum(discount), 0), 'tax', coalesce(sum(tax), 0), 'due', coalesce(sum(due), 0), 'lp_matches', count(*) filter (where lp is not null))
                from public.gc_bills where business_id = p_business and status <> 'void' and created_at >= a and created_at < z)
             || jsonb_build_object('collected', (select coalesce(sum(amount), 0) from public.gc_payments where business_id = p_business and created_at >= a and created_at < z),
                                   'outstanding', (select coalesce(sum(due), 0) from public.gc_bills where business_id = p_business and status <> 'void')),
    'daily', (select coalesce(jsonb_agg(x order by x.d), '[]') from (select ((created_at at time zone 'Asia/Kolkata') - de)::date d, count(*) bills, sum(total) sales, sum(game_amount) gaming, sum(items_amount) items
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
create or replace function public.gc_sales_summary(p_business uuid, d1 date, d2 date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bills', (select count(*) from public.gc_bills where business_id = p_business and status <> 'void' and created_at >= public.gc_day_start(p_business, d1) and created_at < public.gc_day_start(p_business, d2 + 1)),
    'sales', (select coalesce(sum(total), 0) from public.gc_bills where business_id = p_business and status <> 'void' and created_at >= public.gc_day_start(p_business, d1) and created_at < public.gc_day_start(p_business, d2 + 1)),
    'due',   (select coalesce(sum(due), 0) from public.gc_bills where business_id = p_business and status <> 'void' and created_at >= public.gc_day_start(p_business, d1) and created_at < public.gc_day_start(p_business, d2 + 1)),
    'collected', (select coalesce(sum(amount), 0) from public.gc_payments where business_id = p_business and created_at >= public.gc_day_start(p_business, d1) and created_at < public.gc_day_start(p_business, d2 + 1)),
    'top', (select st.name from public.gc_sessions g join public.gc_stations st on st.id = g.station_id where g.business_id = p_business and g.status = 'closed'
            and g.start_at >= public.gc_day_start(p_business, d1) and g.start_at < public.gc_day_start(p_business, d2 + 1) group by st.name order by count(*) desc limit 1))
$$;
revoke execute on function public.gc_sales_summary(uuid, date, date) from public, anon, authenticated;
create or replace function public.gc_stock_count(p_business uuid, p_kind text, p_counts jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := public.gc_bday(p_business, now()); a timestamptz := public.gc_day_start(p_business, public.gc_bday(p_business, now()));
        it jsonb; pr public.gc_products; prev public.gc_stock_counts; ex int; n int; o int; sd int; k int := 0; bad int := 0; rows jsonb := '[]'; own boolean;
begin
  perform public.gc_guard(p_business);
  if p_kind not in ('opening','closing') then raise exception 'Choose opening or closing'; end if;
  own := public.gc_can_setup(p_business);
  for it in select * from jsonb_array_elements(coalesce(p_counts, '[]')) loop
    if coalesce(it->>'counted', '') = '' then continue; end if;
    n := (it->>'counted')::numeric::int; if n < 0 then raise exception 'A count can''t be below zero'; end if;
    select * into pr from public.gc_products where id = (it->>'product_id')::uuid and business_id = p_business and daily_count for update;
    if not found then continue; end if;
    if exists (select 1 from public.gc_stock_counts where business_id = p_business and day = d and kind = p_kind and product_id = pr.id and ack_at is not null) then
      raise exception '% was already counted and checked by the owner today', pr.name; end if;
    o := null; sd := null;
    if p_kind = 'closing' then
      select counted into o from public.gc_stock_counts where business_id = p_business and day = d and kind = 'opening' and product_id = pr.id;
      select coalesce(sum(i.qty), 0)::int into sd from public.gc_items i join public.gc_bills v on v.id = i.bill_id
       where i.product_id = pr.id and v.business_id = p_business and v.status <> 'void' and v.created_at >= a;
    end if;
    -- a recount the same day compares with what the system would expect without the first count's correction
    select * into prev from public.gc_stock_counts where business_id = p_business and day = d and kind = p_kind and product_id = pr.id;
    ex := pr.stock - coalesce(prev.diff, 0);
    if prev.id is null then
      insert into public.gc_stock_counts (business_id, day, kind, product_id, product_name, price, expected, counted, diff, opening, sold, created_by)
      values (p_business, d, p_kind, pr.id, pr.name, pr.price, ex, n, n - ex, o, sd, auth.uid());
    else
      update public.gc_stock_counts set expected = ex, counted = n, diff = n - ex, opening = o, sold = sd, price = pr.price, created_by = auth.uid(), created_at = now() where id = prev.id;
    end if;
    update public.gc_products set stock = n where id = pr.id;
    k := k + 1;
    if n <> ex then bad := bad + 1; end if;
    if own then rows := rows || (select to_jsonb(c) from public.gc_stock_counts c where business_id = p_business and day = d and kind = p_kind and product_id = pr.id); end if;
  end loop;
  if k = 0 then raise exception 'Enter at least one count'; end if;
  return jsonb_build_object('counted', k, 'mismatched', bad, 'rows', rows);
end $$;
create or replace function public.gc_stock_status(p_business uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := public.gc_bday(p_business, now());
begin
  perform public.gc_guard(p_business);
  return jsonb_build_object(
    'day', d,
    'products', (select count(*) from public.gc_products where business_id = p_business and daily_count and active),
    'opening_at', (select max(created_at) from public.gc_stock_counts where business_id = p_business and day = d and kind = 'opening'),
    'closing_at', (select max(created_at) from public.gc_stock_counts where business_id = p_business and day = d and kind = 'closing'),
    'opening_n', (select count(*) from public.gc_stock_counts where business_id = p_business and day = d and kind = 'opening'),
    'closing_n', (select count(*) from public.gc_stock_counts where business_id = p_business and day = d and kind = 'closing'),
    'to_check', case when public.gc_can_setup(p_business) then (select count(*) from public.gc_stock_counts where business_id = p_business and diff <> 0 and ack_at is null) end);
end $$;
-- ---------- Cash book ----------
-- Money that goes out or moves: expense (paid from cash or bank), to_bank (cash deposited), to_cash (cash taken out of the bank)
create table if not exists public.gc_expenses (
  id          bigserial primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  day         date not null,
  kind        text not null default 'expense' check (kind in ('expense','to_bank','to_cash')),
  category    text not null default 'Other',
  note        text not null default '',
  amount      numeric(12,2) not null check (amount > 0),
  paid_from   text not null default 'cash' check (paid_from in ('cash','bank')),
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists gc_expenses_d on public.gc_expenses (business_id, day);
alter table public.gc_expenses enable row level security;
drop policy if exists gc_expenses_read on public.gc_expenses;
create policy gc_expenses_read on public.gc_expenses for select using (public.gc_read(business_id));
revoke all on public.gc_expenses from anon;
grant select on public.gc_expenses to authenticated;

-- One row per closed day
create table if not exists public.gc_cash_days (
  business_id   uuid not null references public.businesses(id) on delete cascade,
  day           date not null,
  opening_cash  numeric(12,2) not null, opening_bank numeric(12,2) not null,
  cash_sales    numeric(12,2) not null, upi_sales numeric(12,2) not null, card_sales numeric(12,2) not null,
  exp_cash      numeric(12,2) not null, exp_bank numeric(12,2) not null, to_bank numeric(12,2) not null, to_cash numeric(12,2) not null,
  expected_cash numeric(12,2) not null, expected_bank numeric(12,2) not null,
  counted_cash  numeric(12,2) not null, counted_bank numeric(12,2) not null,
  denoms        jsonb not null default '{}',
  diff_cash     numeric(12,2) not null, diff_bank numeric(12,2) not null,
  note          text not null default '',
  closed_by     uuid references auth.users(id),
  closed_at     timestamptz not null default now(),
  primary key (business_id, day)
);
alter table public.gc_cash_days enable row level security;
drop policy if exists gc_cash_days_read on public.gc_cash_days;
create policy gc_cash_days_read on public.gc_cash_days for select using (public.gc_can_setup(business_id));
revoke all on public.gc_cash_days from anon;
grant select on public.gc_cash_days to authenticated;

-- Figures for one business date: opening (last close, or the starting balance), money in by mode, money out, expected balances
create or replace function public.gc_cash_figures(b uuid, d date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cf public.gc_settings; a timestamptz := public.gc_day_start(b, d); z timestamptz := public.gc_day_start(b, d + 1);
        prev public.gc_cash_days; oc numeric; ob numeric; cs numeric; us numeric; ks numeric; ec numeric; eb numeric; tb numeric; tc numeric;
begin
  select * into cf from public.gc_settings where business_id = b;
  select * into prev from public.gc_cash_days where business_id = b and day < d order by day desc limit 1;
  if prev.day is not null then oc := prev.counted_cash; ob := prev.counted_bank; else oc := coalesce(cf.cash_open_cash, 0); ob := coalesce(cf.cash_open_bank, 0); end if;
  select coalesce(sum(amount) filter (where mode = 'cash'), 0), coalesce(sum(amount) filter (where mode = 'upi'), 0), coalesce(sum(amount) filter (where mode = 'card'), 0)
    into cs, us, ks from public.gc_payments where business_id = b and created_at >= a and created_at < z;
  select coalesce(sum(amount) filter (where kind = 'expense' and paid_from = 'cash'), 0), coalesce(sum(amount) filter (where kind = 'expense' and paid_from = 'bank'), 0),
         coalesce(sum(amount) filter (where kind = 'to_bank'), 0), coalesce(sum(amount) filter (where kind = 'to_cash'), 0)
    into ec, eb, tb, tc from public.gc_expenses where business_id = b and day = d;
  return jsonb_build_object('day', d, 'from', a, 'to', z, 'opening_cash', oc, 'opening_bank', ob, 'opening_from', case when prev.day is not null then prev.day::text else 'start' end,
    'cash_sales', cs, 'upi_sales', us, 'card_sales', ks, 'exp_cash', ec, 'exp_bank', eb, 'to_bank', tb, 'to_cash', tc,
    'expected_cash', oc + cs - ec - tb + tc, 'expected_bank', ob + us + ks - eb + tb - tc);
end $$;
revoke execute on function public.gc_cash_figures(uuid, date) from public, anon, authenticated;

-- The cash page: today's figures, any days still to close (oldest first), and recent closes. Owners only.
create or replace function public.gc_cash_status(p_business uuid, p_day date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cf public.gc_settings; today date; last date; nxt date; d date;
begin
  if not public.gc_can_setup(p_business) then raise exception 'Only the owner can see the cash book'; end if;
  cf := public.gc_cfg(p_business); today := public.gc_bday(p_business, now());
  select max(day) into last from public.gc_cash_days where business_id = p_business;
  nxt := case when last is not null then last + 1 else cf.cash_start end;
  d := coalesce(p_day, case when nxt is not null and nxt < today then nxt else today end);
  return jsonb_build_object('today', today, 'day', d, 'set_up', cf.cash_start is not null, 'cash_start', cf.cash_start, 'day_end', cf.day_end,
    'next_to_close', nxt, 'pending', case when nxt is null or nxt >= today then '[]'::jsonb else (select jsonb_agg(x::date order by x) from generate_series(nxt, today - 1, interval '1 day') x) end,
    'figures', public.gc_cash_figures(p_business, d),
    'closed', (select to_jsonb(c) from public.gc_cash_days c where business_id = p_business and day = d),
    'history', (select coalesce(jsonb_agg(to_jsonb(c) order by c.day desc), '[]') from (select * from public.gc_cash_days where business_id = p_business order by day desc limit 60) c));
end $$;
revoke execute on function public.gc_cash_status(uuid, date) from public, anon;
grant execute on function public.gc_cash_status(uuid, date) to authenticated;

-- First time: the date to start from and the cash in hand / money in the bank at that point
create or replace function public.gc_cash_setup(p_business uuid, p_start date, p_cash numeric, p_bank numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.gc_can_setup(p_business) then raise exception 'Only the owner can set the opening balance'; end if;
  if exists (select 1 from public.gc_cash_days where business_id = p_business) then raise exception 'Days are already closed. Reopen them first to change the starting balance.'; end if;
  if p_start is null or p_start > public.gc_bday(p_business, now()) then raise exception 'Choose a start date up to today'; end if;
  if coalesce(p_cash, 0) < 0 or coalesce(p_bank, 0) < 0 then raise exception 'Balances can''t be below zero'; end if;
  perform public.gc_cfg(p_business);
  update public.gc_settings set cash_start = p_start, cash_open_cash = coalesce(p_cash, 0), cash_open_bank = coalesce(p_bank, 0) where business_id = p_business;
end $$;
revoke execute on function public.gc_cash_setup(uuid, date, numeric, numeric) from public, anon;
grant execute on function public.gc_cash_setup(uuid, date, numeric, numeric) to authenticated;

-- Add an expense or a cash/bank move (staff with the gaming desk can; not on a closed day). Owners can delete open-day entries.
create or replace function public.gc_expense_save(p_business uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(nullif(p->>'day', '')::date, public.gc_bday(p_business, now())); k text := coalesce(p->>'kind', 'expense'); e public.gc_expenses;
begin
  perform public.gc_guard(p_business);
  if p ? 'delete' then
    if not public.gc_can_setup(p_business) then raise exception 'Only the owner can delete an entry'; end if;
    select * into e from public.gc_expenses where id = (p->>'delete')::bigint and business_id = p_business; if not found then raise exception 'Entry not found'; end if;
    if exists (select 1 from public.gc_cash_days where business_id = p_business and day = e.day) then raise exception 'That day is already closed'; end if;
    delete from public.gc_expenses where id = e.id; return null;
  end if;
  if d > public.gc_bday(p_business, now()) then raise exception 'That date is in the future'; end if;
  if exists (select 1 from public.gc_cash_days where business_id = p_business and day = d) then raise exception '% is already closed', to_char(d, 'DD Mon'); end if;
  if coalesce((p->>'amount')::numeric, 0) <= 0 then raise exception 'Enter the amount'; end if;
  insert into public.gc_expenses (business_id, day, kind, category, note, amount, paid_from, created_by)
  values (p_business, d, k, case when k = 'expense' then coalesce(nullif(trim(p->>'category'), ''), 'Other') when k = 'to_bank' then 'Cash to bank' else 'Bank to cash' end,
          coalesce(trim(p->>'note'), ''), round((p->>'amount')::numeric, 2), case when k = 'to_bank' then 'cash' when k = 'to_cash' then 'bank' else coalesce(p->>'paid_from', 'cash') end, auth.uid())
  returning * into e;
  return to_jsonb(e);
end $$;
revoke execute on function public.gc_expense_save(uuid, jsonb) from public, anon;
grant execute on function public.gc_expense_save(uuid, jsonb) to authenticated;

-- Owner: close a day with the counted cash (by notes) and the bank balance. Days close in order; the next day opens with these.
create or replace function public.gc_cash_close(p_business uuid, p_day date, p_cash numeric, p_bank numeric, p_denoms jsonb default '{}', p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare st jsonb; f jsonb; r public.gc_cash_days;
begin
  if not public.gc_can_setup(p_business) then raise exception 'Only the owner can close the day'; end if;
  st := public.gc_cash_status(p_business, p_day);
  if not (st->>'set_up')::boolean then raise exception 'Set the opening balance first'; end if;
  if p_day > (st->>'today')::date then raise exception 'That date hasn''t come yet'; end if;
  if p_day <> (st->>'next_to_close')::date then raise exception 'Close % first', to_char((st->>'next_to_close')::date, 'DD Mon'); end if;
  if coalesce(p_cash, -1) < 0 or coalesce(p_bank, -1) < 0 then raise exception 'Enter the cash counted and the bank balance'; end if;
  f := st->'figures';
  insert into public.gc_cash_days (business_id, day, opening_cash, opening_bank, cash_sales, upi_sales, card_sales, exp_cash, exp_bank, to_bank, to_cash,
                                   expected_cash, expected_bank, counted_cash, counted_bank, denoms, diff_cash, diff_bank, note, closed_by)
  values (p_business, p_day, (f->>'opening_cash')::numeric, (f->>'opening_bank')::numeric, (f->>'cash_sales')::numeric, (f->>'upi_sales')::numeric, (f->>'card_sales')::numeric,
          (f->>'exp_cash')::numeric, (f->>'exp_bank')::numeric, (f->>'to_bank')::numeric, (f->>'to_cash')::numeric, (f->>'expected_cash')::numeric, (f->>'expected_bank')::numeric,
          round(p_cash, 2), round(p_bank, 2), coalesce(p_denoms, '{}'), round(p_cash - (f->>'expected_cash')::numeric, 2), round(p_bank - (f->>'expected_bank')::numeric, 2), coalesce(p_note, ''), auth.uid())
  returning * into r;
  return to_jsonb(r);
end $$;
revoke execute on function public.gc_cash_close(uuid, date, numeric, numeric, jsonb, text) from public, anon;
grant execute on function public.gc_cash_close(uuid, date, numeric, numeric, jsonb, text) to authenticated;

-- Owner: reopen the most recent closed day (to fix a mistake)
create or replace function public.gc_cash_reopen(p_business uuid, p_day date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.gc_can_setup(p_business) then raise exception 'Only the owner can reopen a day'; end if;
  if p_day <> (select max(day) from public.gc_cash_days where business_id = p_business) then raise exception 'Only the last closed day can be reopened'; end if;
  delete from public.gc_cash_days where business_id = p_business and day = p_day;
end $$;
revoke execute on function public.gc_cash_reopen(uuid, date) from public, anon;
grant execute on function public.gc_cash_reopen(uuid, date) to authenticated;
