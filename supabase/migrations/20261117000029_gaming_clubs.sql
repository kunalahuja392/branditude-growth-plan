-- =====================================================================================================
-- Gaming clubs (sold on gamingclubs.branditudeglobal.com, same backend as the Growth Plan)
--
--  * Business type "Gaming Club" and module "gaming": live station timers (PS5 / PC / VR / pool…),
--    LP ("loser pays") matches with time splits and winners, day/time pricing rules (happy hours, Sundays),
--    snacks with stock, bills (GST, split / pay-later), bookings and reports.
--  * Add-on module "wa_billing": bill + feedback link on WhatsApp, time-up reminders, pending-payment
--    follow-ups and a daily report to the owner. A monthly add-on price plus 1 UTILITY credit per message
--    from the business's WhatsApp wallet (reserved before sending, refunded on failure, like visit updates).
--  * Plans can now be limited to business types (packages.categories). Gaming plans show only on the gaming
--    store; every other Growth Plan feature shows inside the gaming portal as an add-on.
--  * A gaming bill logs a normal visit, so the customer list, loyalty card and review requests work too.
-- =====================================================================================================

-- ---------- 1. Business type, modules, plans ----------
insert into public.categories (name, slug, icon, sort) values ('Gaming Club', 'gaming-club', '🎮', 95)
on conflict (slug) do update set icon = excluded.icon;

insert into public.modules (key, name, blurb, icon, core, addon_price, sort, categories) values
  ('gaming', 'Gaming stations & LP billing',
   'Live timers for every PS5, PC, VR or pool table, LP (loser pays) splits with winners, happy-hour and Sunday pricing, snacks, bills and bookings',
   '🎮', false, null, 5, '{gaming-club}'),
  ('wa_billing', 'WhatsApp bills, follow-ups & reports',
   'Bill and feedback link on WhatsApp after every session, time-up reminders, pending-payment follow-ups and a daily sales report. Each message uses 1 utility credit.',
   '🧾', false, 99, 45, '{gaming-club}')
on conflict (key) do update set name = excluded.name, blurb = excluded.blurb, icon = excluded.icon, sort = excluded.sort, categories = excluded.categories;

-- Plans for one kind of business only (null = every business type)
alter table public.packages add column if not exists categories text[];

insert into public.packages (name, slug, tagline, monthly_price, yearly_price, features, modules, categories, is_popular, sort)
select * from (values
  ('Game Club', 'game-club', 'Timers, LP bills and reviews for your gaming club', 499.00, 4990.00,
   array['Live timers for every station, no double bookings', 'LP (loser pays) matches: split time, record winners, bill each player',
         'Happy-hour, weekend and Sunday pricing', 'Snacks and stock on the same bill', 'GST bills: cash, UPI, card, split or pay later',
         '15-minute "time up" popup for staff', 'Bookings and daily reports', 'Review QR, feedback page and customer list'],
   array['gaming'], array['gaming-club'], false, 50),
  ('Game Club Pro', 'game-club-pro', 'Everything, plus WhatsApp bills, loyalty and staff', 899.00, 8990.00,
   array['Everything in Game Club', 'Bills, payment follow-ups and daily report on WhatsApp (credits extra)', 'Time-up reminder to the customer on WhatsApp',
         'Loyalty card and coupons', 'Birthday and win-back messages', 'Staff attendance and salary'],
   array['gaming', 'wa_billing', 'loyalty', 'campaigns', 'attendance'], array['gaming-club'], true, 51)
) v(name, slug, tagline, monthly_price, yearly_price, features, modules, categories, is_popular, sort)
where not exists (select 1 from public.packages p where p.slug = v.slug);

-- A plan meant for one kind of business can't be put on another (store and admin both go through this)
create or replace function public.check_package_category() returns trigger
language plpgsql security definer set search_path = public as $$
declare pc text[]; cs text;
begin
  if new.package_id is null then return new; end if;
  select categories into pc from public.packages where id = new.package_id;
  if pc is null then return new; end if;
  select slug into cs from public.categories where id = new.category_id;
  if cs is null or not (cs = any(pc)) then
    raise exception 'This plan is only for % businesses', (select string_agg(name, ', ') from public.categories where slug = any(pc));
  end if;
  return new;
end $$;
drop trigger if exists businesses_package_category on public.businesses;
create trigger businesses_package_category before insert or update of package_id, category_id on public.businesses
  for each row execute function public.check_package_category();

-- Team permission area "gaming" (front desk staff get only this)
create or replace function public.perm_areas() returns text[] language sql immutable set search_path = public as $$
  select '{customers,reviews,whatsapp,menu,attendance,accounts,settings,gaming}'::text[]
$$;
create or replace function public.mod_area(m text) returns text language sql immutable as $$
  select case when m in ('menu') then 'menu' when m in ('attendance') then 'attendance' when m in ('accounting') then 'accounts'
              when m in ('bulk_whatsapp', 'campaigns') then 'whatsapp' when m in ('seo', 'google_replies') then 'reviews'
              when m in ('gaming', 'wa_billing') then 'gaming' else 'customers' end
$$;

-- Site where bill links and the gaming store live (Admin can change it)
insert into public.settings (key, value, public) values ('gaming', '{"site_url": "https://scale.branditudeglobal.com", "headline": "Run your gaming club on autopilot."}', true)
on conflict (key) do nothing;


-- Fix: preview_visit() failed with "record lr is not assigned yet" for businesses whose plan has no loyalty card
-- (every plan had loyalty until now). Give the record an empty value before it is read.
do $$ declare d text; begin
  d := pg_get_functiondef('public.preview_visit(uuid,text,numeric,text)'::regprocedure);
  if position('from public.loyalty_rewards where false' in d) = 0 then
    d := replace(d, '  if lp.enabled and public.has_module(p_business,''loyalty'') then',
                    '  select * into lr from public.loyalty_rewards where false;
  if lp.enabled and public.has_module(p_business,''loyalty'') then');
    execute d;
  end if;
end $$;

-- ---------- 2. Tables ----------
create table if not exists public.gc_settings (
  business_id      uuid primary key references public.businesses(id) on delete cascade,
  tax_percent      numeric(5,2) not null default 18 check (tax_percent between 0 and 40),
  tax_inclusive    boolean not null default false,
  gstin            text not null default '',
  upi_id           text not null default '',
  bill_prefix      text not null default 'GC',
  bill_footer      text not null default 'Thank you for playing with us!',
  bill_seq         int  not null default 0,
  round_minutes    int  not null default 1  check (round_minutes between 1 and 60),
  min_minutes      int  not null default 0  check (min_minutes between 0 and 240),
  charge_booked    boolean not null default true,
  reminder_minutes int  not null default 15 check (reminder_minutes between 1 and 60),
  wa_bill          boolean not null default true,
  wa_time_reminder boolean not null default true,
  wa_followup      boolean not null default true,
  followup_days    int  not null default 2  check (followup_days between 1 and 30),
  followup_times   int  not null default 3  check (followup_times between 0 and 10),
  wa_booking       boolean not null default true,    -- booking confirmed / cancelled to the customer
  wa_daily_report  boolean not null default false,    -- owner reports: daily sales, weekly, monthly, low stock, pending payments
  report_weekly    boolean not null default false,
  report_monthly   boolean not null default false,
  report_low_stock boolean not null default false,
  report_dues      boolean not null default false,
  report_phone     text not null default '',
  report_hour      int  not null default 23 check (report_hour between 0 and 23),
  updated_at       timestamptz not null default now()
);
create table if not exists public.gc_stations (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  name              text not null,
  type              text not null default 'PS5',
  rate              numeric(10,2) not null default 100 check (rate >= 0),
  included_players  int not null default 1 check (included_players >= 1),
  extra_player_rate numeric(10,2) not null default 0 check (extra_player_rate >= 0),
  active            boolean not null default true,
  sort              int not null default 100,
  created_at        timestamptz not null default now()
);
create table if not exists public.gc_rules (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  name         text not null,
  station_type text not null default '*',        -- '*' all, a type like 'PS5', or '#<station id>'
  days         int[] not null default '{0,1,2,3,4,5,6}',   -- 0 = Sunday
  start_time   time not null default '00:00',
  end_time     time not null default '24:00',     -- end before start = runs past midnight
  mode         text not null default 'percent' check (mode in ('fixed','percent','add')),
  value        numeric(10,2) not null default 0,
  priority     int not null default 1,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create table if not exists public.gc_products (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  category    text not null default 'Snacks',
  price       numeric(10,2) not null default 0 check (price >= 0),
  cost        numeric(10,2) not null default 0 check (cost >= 0),
  stock       int not null default 0,
  track_stock boolean not null default true,
  low_stock   int not null default 5,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create table if not exists public.gc_bookings (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  station_id     uuid references public.gc_stations(id) on delete set null,
  station_type   text,
  customer_name  text not null,
  customer_phone text,
  start_at       timestamptz not null,
  minutes        int not null default 60 check (minutes between 15 and 720),
  players        int not null default 1,
  status         text not null default 'confirmed' check (status in ('pending','confirmed','arrived','cancelled','no_show')),
  source         text not null default 'staff' check (source in ('staff','online')),
  notes          text not null default '',
  created_at     timestamptz not null default now()
);
create table if not exists public.gc_bills (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  number          text not null,
  token           text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
  session_id      uuid,
  customer_id     uuid references public.customers(id) on delete set null,
  customer_name   text not null default '',
  customer_phone  text,
  station_name    text,
  station_type    text,
  lines           jsonb not null default '[]',
  lp              jsonb,
  game_amount     numeric(12,2) not null default 0,
  items_amount    numeric(12,2) not null default 0,
  subtotal        numeric(12,2) not null,
  discount        numeric(12,2) not null default 0,
  tax_percent     numeric(5,2) not null default 0,
  tax             numeric(12,2) not null default 0,
  round_off       numeric(12,2) not null default 0,
  total           numeric(12,2) not null,
  paid            numeric(12,2) not null default 0,
  due             numeric(12,2) not null default 0,
  status          text not null check (status in ('paid','partial','unpaid','void')),
  notes           text not null default '',
  followups       int not null default 0,
  last_followup_at timestamptz,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  unique (business_id, number)
);
create table if not exists public.gc_sessions (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  station_id     uuid not null references public.gc_stations(id),
  customer_id    uuid references public.customers(id) on delete set null,
  customer_name  text not null default '',
  customer_phone text,
  players        int not null default 1 check (players between 1 and 32),
  booked_minutes int not null default 0 check (booked_minutes >= 0),
  start_at       timestamptz not null default now(),
  end_at         timestamptz,
  status         text not null default 'running' check (status in ('running','paused','billing','closed','cancelled')),
  is_lp          boolean not null default false,
  lp_players     text[] not null default '{}',
  reminded       boolean not null default false,
  notes          text not null default '',
  booking_id     uuid references public.gc_bookings(id) on delete set null,
  bill_id        uuid references public.gc_bills(id) on delete set null,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);
create unique index if not exists gc_one_session_per_station on public.gc_sessions (station_id) where status in ('running','paused','billing');
create index if not exists gc_sessions_biz on public.gc_sessions (business_id, status);
create table if not exists public.gc_intervals (
  id         bigserial primary key,
  session_id uuid not null references public.gc_sessions(id) on delete cascade,
  start_at   timestamptz not null,
  end_at     timestamptz
);
create index if not exists gc_intervals_s on public.gc_intervals (session_id);
create table if not exists public.gc_lp_segments (
  id         bigserial primary key,
  session_id uuid not null references public.gc_sessions(id) on delete cascade,
  from_at    timestamptz not null,
  to_at      timestamptz not null,
  winner     text,
  payers     text[] not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.gc_items (
  id          bigserial primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  session_id  uuid references public.gc_sessions(id) on delete cascade,
  bill_id     uuid references public.gc_bills(id) on delete cascade,
  product_id  uuid references public.gc_products(id) on delete set null,
  name        text not null,
  qty         numeric(10,2) not null default 1 check (qty > 0),
  price       numeric(10,2) not null default 0 check (price >= 0),
  assigned_to text,
  created_at  timestamptz not null default now()
);
create index if not exists gc_items_s on public.gc_items (session_id);
create table if not exists public.gc_payments (
  id          bigserial primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  bill_id     uuid not null references public.gc_bills(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  mode        text not null check (mode in ('cash','upi','card')),
  amount      numeric(12,2) not null check (amount > 0),
  paid_by     text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists gc_payments_b on public.gc_payments (business_id, created_at);
create index if not exists gc_bills_b on public.gc_bills (business_id, created_at);
create table if not exists public.gc_wa_log (
  id            bigserial primary key,
  business_id   uuid not null references public.businesses(id) on delete cascade,
  kind          text not null check (kind in ('bill','due','reminder','booking','report','weekly','monthly','low_stock','dues')),
  ref           text not null,
  phone         text not null,
  status        text not null check (status in ('sent','failed','skipped')),
  error         text,
  credits       int not null default 0,
  wa_message_id text,
  created_at    timestamptz not null default now()
);
create index if not exists gc_wa_log_b on public.gc_wa_log (business_id, kind, ref);

-- ---------- 3. Access ----------
-- Using the gaming screens: staff with the "gaming" area, plan open, module on. Prices & stations: "settings" area too.
create or replace function public.gc_can(b uuid) returns boolean
language sql stable security definer set search_path = public as $$ select public.can_use(b, 'gaming') $$;
create or replace function public.gc_can_setup(b uuid) returns boolean
language sql stable security definer set search_path = public as $$ select public.is_staff() or (public.can_use(b, 'gaming') and public.has_perm(b, 'settings')) $$;
create or replace function public.gc_read(b uuid) returns boolean
language sql stable security definer set search_path = public as $$ select public.is_staff() or public.has_perm(b, 'gaming') $$;
revoke execute on function public.gc_can(uuid), public.gc_can_setup(uuid), public.gc_read(uuid) from public, anon;
grant execute on function public.gc_can(uuid), public.gc_can_setup(uuid), public.gc_read(uuid) to authenticated, service_role;

do $$ declare t text; begin
  foreach t in array array['gc_settings','gc_stations','gc_rules','gc_products','gc_bookings','gc_bills','gc_sessions','gc_items','gc_payments','gc_wa_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (public.gc_read(business_id))', t || '_read', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  -- set-up tables are edited directly by owners/admins; everything else only through the functions below
  foreach t in array array['gc_settings','gc_stations','gc_rules','gc_products'] loop
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all using (public.gc_can_setup(business_id)) with check (public.gc_can_setup(business_id))', t || '_write', t);
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
alter table public.gc_intervals enable row level security;
alter table public.gc_lp_segments enable row level security;
drop policy if exists gc_int_read on public.gc_intervals;
create policy gc_int_read on public.gc_intervals for select using (exists (select 1 from public.gc_sessions s where s.id = session_id and public.gc_read(s.business_id)));
drop policy if exists gc_lps_read on public.gc_lp_segments;
create policy gc_lps_read on public.gc_lp_segments for select using (exists (select 1 from public.gc_sessions s where s.id = session_id and public.gc_read(s.business_id)));
revoke all on public.gc_intervals, public.gc_lp_segments from anon;
grant select on public.gc_intervals, public.gc_lp_segments to authenticated;

-- Live board updates (Supabase Realtime respects the read policies above)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.gc_sessions; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.gc_bookings; exception when duplicate_object then null; end;
  end if;
end $$;

create or replace function public.gc_cfg(b uuid) returns public.gc_settings
language plpgsql security definer set search_path = public as $$
declare s public.gc_settings;
begin
  select * into s from public.gc_settings where business_id = b;
  if not found then insert into public.gc_settings (business_id) values (b) on conflict do nothing returning * into s;
    if s.business_id is null then select * into s from public.gc_settings where business_id = b; end if; end if;
  return s;
end $$;
revoke execute on function public.gc_cfg(uuid) from public, anon, authenticated;

create or replace function public.gc_guard(b uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if public.gc_can(b) then return; end if;
  if not public.is_member(b) then raise exception 'Not allowed'; end if;
  if not public.has_module(b, 'gaming') then raise exception 'Gaming billing isn''t in your plan. Add it from Plan & services.'; end if;
  if not public.has_perm(b, 'gaming') then raise exception 'Your login doesn''t have access to gaming. Ask the owner.'; end if;
  raise exception '%', coalesce(public.locked_reason(b), 'Your plan has ended. Renew it from Plan & services.');
end $$;
revoke execute on function public.gc_guard(uuid) from public, anon, authenticated;

-- ---------- 4. Pricing engine ----------
-- Is a pricing rule in force at this moment? (shop time is India time)
create or replace function public.gc_rule_hits(r public.gc_rules, st public.gc_stations, ts timestamptz) returns boolean
language plpgsql immutable as $$
declare l timestamp := ts at time zone 'Asia/Kolkata'; d int := extract(dow from l); t time := l::time;
begin
  if not r.active then return false; end if;
  if r.station_type <> '*' and r.station_type <> st.type and r.station_type <> '#' || st.id::text then return false; end if;
  if r.start_time = r.end_time then return d = any(r.days); end if;
  if r.start_time < r.end_time then return d = any(r.days) and t >= r.start_time and t < r.end_time; end if;
  return (t >= r.start_time and d = any(r.days)) or (t < r.end_time and ((d + 6) % 7) = any(r.days));  -- past midnight belongs to the day before
end $$;

-- Hourly rate at a moment, and the rule that set it
create or replace function public.gc_rate_at(st public.gc_stations, rules public.gc_rules[], players int, ts timestamptz, out rate numeric, out rule text)
language plpgsql immutable as $$
declare r public.gc_rules; best public.gc_rules; extra numeric;
begin
  extra := greatest(0, coalesce(players, 1) - st.included_players) * st.extra_player_rate;
  rate := st.rate + extra; rule := null;
  if rules is not null then
    foreach r in array rules loop
      if public.gc_rule_hits(r, st, ts) and (best.id is null or r.priority > best.priority or (r.priority = best.priority and r.created_at > best.created_at)) then best := r; end if;
    end loop;
  end if;
  if best.id is not null then
    rule := best.name;
    rate := case best.mode when 'fixed' then best.value + extra when 'percent' then (st.rate + extra) * (1 - best.value / 100) else st.rate + extra + best.value end;
  end if;
  rate := greatest(rate, 0);
end $$;

-- Cost of the time actually played (pauses excluded) between a and b, minute by minute
create or replace function public.gc_cost(p_session uuid, a timestamptz, b timestamptz, st public.gc_stations, rules public.gc_rules[], players int, p_end timestamptz,
  out cost numeric, out ms bigint, out by_rule jsonb)
language plpgsql stable security definer set search_path = public as $$
declare iv record; s timestamptz; e timestamptz; t timestamptz; step numeric; rr record; k text;
begin
  cost := 0; ms := 0; by_rule := '{}';
  for iv in select start_at, coalesce(end_at, p_end) as end_at from public.gc_intervals where session_id = p_session order by start_at loop
    s := greatest(iv.start_at, a); e := least(iv.end_at, b);
    t := s;
    while t < e loop
      step := extract(epoch from (least(t + interval '1 minute', e) - t)) * 1000;
      rr := public.gc_rate_at(st, rules, players, t);
      cost := cost + rr.rate * step / 3600000; ms := ms + step::bigint;
      k := coalesce(rr.rule, 'Standard');
      by_rule := jsonb_set(by_rule, array[k], jsonb_build_object('ms', coalesce((by_rule->k->>'ms')::numeric, 0) + step,
                                                                  'cost', coalesce((by_rule->k->>'cost')::numeric, 0) + rr.rate * step / 3600000));
      t := t + interval '1 minute';
    end loop;
  end loop;
end $$;
revoke execute on function public.gc_cost(uuid, timestamptz, timestamptz, public.gc_stations, public.gc_rules[], int, timestamptz) from public, anon, authenticated;

-- Everything the screens need about one session: time played, charged minutes, amount, LP split, snacks
create or replace function public.gc_calc(p_session uuid, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.gc_sessions; st public.gc_stations; cf public.gc_settings; rules public.gc_rules[]; endt timestamptz;
        tot record; act_min numeric; charged int; amount numeric; nowr record; seg record; c record; segs jsonb := '[]'; per jsonb := '{}';
        tail jsonb := null; last_to timestamptz; n int; p text; items jsonb; items_total numeric; share numeric; segamt numeric; last_id bigint; tail_cost record;
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
  if cf.charge_booked and s.booked_minutes > 0 and s.status not in ('running','paused') then charged := greatest(charged, s.booked_minutes); end if;
  nowr := public.gc_rate_at(st, rules, s.players, least(p_now, endt));
  amount := round(case when tot.ms > 0 then tot.cost * charged / act_min else charged * nowr.rate / 60 end, 2);

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
    'rate_now', round(nowr.rate, 2), 'rule_now', nowr.rule,
    'by_rule', (select coalesce(jsonb_agg(jsonb_build_object('rule', k, 'minutes', round((v->>'ms')::numeric / 60000, 1), 'cost', round((v->>'cost')::numeric, 2))), '[]') from jsonb_each(tot.by_rule) x(k, v)),
    'segments', segs, 'tail', tail, 'per_player', per, 'lp_players', to_jsonb(s.lp_players),
    'items', items, 'items_total', round(items_total, 2),
    'remaining_ms', case when s.booked_minutes > 0 then s.booked_minutes * 60000 - tot.ms end,
    'station', jsonb_build_object('id', st.id, 'name', st.name, 'type', st.type));
end $$;
revoke execute on function public.gc_calc(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.gc_calc(uuid, timestamptz) to service_role;

create or replace function public.gc_view(p_session uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(s) || jsonb_build_object('calc', public.gc_calc(s.id)) from public.gc_sessions s where s.id = p_session
$$;
revoke execute on function public.gc_view(uuid) from public, anon, authenticated;

-- ---------- 5. Live board & sessions ----------
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
    'today', (select jsonb_build_object('bills', count(*), 'sales', coalesce(sum(total), 0), 'due', coalesce(sum(due), 0))
              from public.gc_bills where business_id = p_business and created_at >= t0 and status <> 'void')
             || jsonb_build_object('collected', (select coalesce(sum(amount), 0) from public.gc_payments where business_id = p_business and created_at >= t0)),
    'bookings', (select coalesce(jsonb_agg(to_jsonb(k) || jsonb_build_object('station_name', st.name) order by k.start_at), '[]')
                 from public.gc_bookings k left join public.gc_stations st on st.id = k.station_id
                 where k.business_id = p_business and k.status in ('pending','confirmed') and k.start_at between now() - interval '2 hours' and now() + interval '1 day'),
    'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'stock', stock)), '[]') from public.gc_products
                  where business_id = p_business and active and track_stock and stock <= low_stock));
end $$;

create or replace function public.gc_session(p_session uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from public.gc_sessions where id = p_session; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(b);
  return public.gc_view(p_session);
end $$;

create or replace function public.gc_customer(b uuid, p_name text, p_phone text) returns uuid
language plpgsql security definer set search_path = public as $$
declare ph text; v uuid;
begin
  ph := public.norm_phone(p_phone, (select country_code from public.businesses where id = b));
  if coalesce(ph, '') = '' or length(ph) < 11 then return null; end if;
  select id into v from public.customers where business_id = b and phone = ph;
  if v is null then
    insert into public.customers (business_id, name, phone) values (b, coalesce(nullif(trim(p_name), ''), 'Guest'), ph) returning id into v;
  elsif coalesce(trim(p_name), '') <> '' then
    update public.customers set name = trim(p_name) where id = v and name in ('', 'Guest');
  end if;
  return v;
end $$;
revoke execute on function public.gc_customer(uuid, text, text) from public, anon, authenticated;

-- p: station_id, customer_name, customer_phone, players, booked_minutes, is_lp, lp_players[], notes, booking_id
create or replace function public.gc_start(p_business uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare st public.gc_stations; lp text[]; v uuid; c uuid;
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
  c := public.gc_customer(p_business, coalesce(nullif(p->>'customer_name', ''), lp[1]), p->>'customer_phone');
  insert into public.gc_sessions (business_id, station_id, customer_id, customer_name, customer_phone, players, booked_minutes, is_lp, lp_players, notes, booking_id, created_by)
  values (p_business, st.id, c,
          coalesce(nullif(trim(p->>'customer_name'), ''), case when cardinality(lp) > 0 then array_to_string(lp, ' vs ') else '' end),
          (select phone from public.customers where id = c),
          greatest(coalesce((p->>'players')::int, 1), greatest(cardinality(lp), 1)), greatest(coalesce((p->>'booked_minutes')::int, 0), 0),
          cardinality(lp) > 0, lp, coalesce(p->>'notes', ''), nullif(p->>'booking_id', '')::uuid, auth.uid())
  returning id into v;
  insert into public.gc_intervals (session_id, start_at) values (v, now());
  if nullif(p->>'booking_id', '') is not null then update public.gc_bookings set status = 'arrived' where id = (p->>'booking_id')::uuid and business_id = p_business; end if;
  return public.gc_view(v);
end $$;

-- pause | resume | stop | extend {minutes} | cancel {reason} | transfer {station_id} | update {customer_name, customer_phone, players, booked_minutes, notes}
create or replace function public.gc_action(p_session uuid, p_action text, p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions; st public.gc_stations; m int; c uuid;
begin
  select * into s from public.gc_sessions where id = p_session for update; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if s.status in ('closed','cancelled') then raise exception 'This session is already closed'; end if;
  if p_action = 'pause' then
    if s.status <> 'running' then raise exception 'Session is not running'; end if;
    update public.gc_intervals set end_at = now() where session_id = s.id and end_at is null;
    update public.gc_sessions set status = 'paused' where id = s.id;
  elsif p_action = 'resume' then
    if s.status not in ('paused','billing') then raise exception 'Session is already running'; end if;
    insert into public.gc_intervals (session_id, start_at) values (s.id, now());
    update public.gc_sessions set status = 'running', end_at = null where id = s.id;
  elsif p_action = 'stop' then
    if s.status not in ('running','paused') then raise exception 'Session is not running'; end if;
    update public.gc_intervals set end_at = now() where session_id = s.id and end_at is null;
    update public.gc_sessions set status = 'billing', end_at = now() where id = s.id;
  elsif p_action = 'extend' then
    m := coalesce((p->>'minutes')::int, 0); if m <= 0 or m > 720 then raise exception 'Choose how many minutes to add'; end if;
    update public.gc_sessions set booked_minutes = booked_minutes + m, reminded = false where id = s.id;
  elsif p_action = 'cancel' then
    if coalesce(trim(p->>'reason'), '') = '' then raise exception 'Give a reason for cancelling'; end if;
    if s.start_at < now() - interval '5 minutes' and not (public.is_staff() or public.has_perm(s.business_id, 'settings')) then
      raise exception 'Only the owner can cancel a session older than 5 minutes'; end if;
    update public.gc_intervals set end_at = now() where session_id = s.id and end_at is null;
    update public.gc_products pr set stock = pr.stock + i.qty::int from public.gc_items i where i.session_id = s.id and i.product_id = pr.id and pr.track_stock;
    delete from public.gc_items where session_id = s.id;
    update public.gc_sessions set status = 'cancelled', end_at = now(), notes = trim(notes || ' [Cancelled: ' || (p->>'reason') || ']') where id = s.id;
  elsif p_action = 'transfer' then
    select * into st from public.gc_stations where id = (p->>'station_id')::uuid and business_id = s.business_id and active;
    if not found then raise exception 'Station not found'; end if;
    if exists (select 1 from public.gc_sessions where station_id = st.id and status in ('running','paused','billing')) then raise exception '% is busy', st.name; end if;
    update public.gc_sessions set station_id = st.id where id = s.id;
  elsif p_action = 'update' then
    if p ? 'customer_phone' then c := public.gc_customer(s.business_id, coalesce(p->>'customer_name', s.customer_name), p->>'customer_phone'); end if;
    update public.gc_sessions set
      customer_name  = coalesce(p->>'customer_name', customer_name),
      customer_id    = case when p ? 'customer_phone' then c else customer_id end,
      customer_phone = case when p ? 'customer_phone' then (select phone from public.customers where id = c) else customer_phone end,
      players        = greatest(1, coalesce((p->>'players')::int, players)),
      booked_minutes = greatest(0, coalesce((p->>'booked_minutes')::int, booked_minutes)),
      reminded       = case when p ? 'booked_minutes' then false else reminded end,
      notes          = coalesce(p->>'notes', notes)
    where id = s.id;
  else raise exception 'Unknown action'; end if;
  return public.gc_view(s.id);
end $$;

-- LP: put the time since the last split on the loser(s) and note the winner
create or replace function public.gc_lp_split(p_session uuid, p_winner text, p_payers text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions; last_to timestamptz; t timestamptz; payers text[]; w text := nullif(trim(coalesce(p_winner, '')), '');
begin
  select * into s from public.gc_sessions where id = p_session for update; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if not s.is_lp then raise exception 'This is not an LP match'; end if;
  if s.status not in ('running','paused','billing') then raise exception 'This session is closed'; end if;
  if w is not null and w <> 'Draw' and not (w = any(s.lp_players)) then raise exception 'The winner must be one of the players'; end if;
  payers := array(select distinct trim(x) from unnest(coalesce(p_payers, '{}')) x where trim(x) <> '');
  if cardinality(payers) = 0 and w is not null and w <> 'Draw' and cardinality(s.lp_players) = 2 then payers := array(select x from unnest(s.lp_players) x where x <> w); end if;
  if cardinality(payers) = 0 then raise exception 'Choose who pays for this time'; end if;
  if exists (select 1 from unnest(payers) x where not (x = any(s.lp_players))) then raise exception 'Unknown player'; end if;
  select coalesce(max(to_at), s.start_at) into last_to from public.gc_lp_segments where session_id = s.id;
  t := coalesce(s.end_at, now());
  if t - last_to < interval '1 second' then raise exception 'No time played since the last split'; end if;
  insert into public.gc_lp_segments (session_id, from_at, to_at, winner, payers, created_by) values (s.id, last_to, t, w, payers, auth.uid());
  return public.gc_view(s.id);
end $$;
create or replace function public.gc_lp_undo(p_session uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions;
begin
  select * into s from public.gc_sessions where id = p_session; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if s.status not in ('running','paused','billing') then raise exception 'This session is closed'; end if;
  delete from public.gc_lp_segments where id = (select max(id) from public.gc_lp_segments where session_id = s.id);
  return public.gc_view(s.id);
end $$;

-- Snacks / accessories on a running session
create or replace function public.gc_item_add(p_session uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions; pr public.gc_products; q numeric := greatest(coalesce((p->>'qty')::numeric, 1), 1); nm text; pc numeric; who text := nullif(p->>'assigned_to', '');
begin
  select * into s from public.gc_sessions where id = p_session; if not found then raise exception 'Session not found'; end if;
  perform public.gc_guard(s.business_id);
  if s.status not in ('running','paused','billing') then raise exception 'This session is closed'; end if;
  if who is not null and not (who = any(s.lp_players)) then raise exception 'Unknown player'; end if;
  if nullif(p->>'product_id', '') is not null then
    select * into pr from public.gc_products where id = (p->>'product_id')::uuid and business_id = s.business_id for update;
    if not found then raise exception 'Item not found'; end if;
    if pr.track_stock and pr.stock < q then raise exception 'Only % % left', pr.stock, pr.name; end if;
    if pr.track_stock then update public.gc_products set stock = stock - q::int where id = pr.id; end if;
    nm := pr.name; pc := pr.price;
  else
    nm := nullif(trim(p->>'name'), ''); pc := coalesce((p->>'price')::numeric, 0);
    if nm is null then raise exception 'Enter the item name'; end if;
  end if;
  insert into public.gc_items (business_id, session_id, product_id, name, qty, price, assigned_to) values (s.business_id, s.id, pr.id, nm, q, pc, who);
  return public.gc_view(s.id);
end $$;
create or replace function public.gc_item_remove(p_item bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i public.gc_items; s public.gc_sessions;
begin
  select * into i from public.gc_items where id = p_item; if not found or i.session_id is null then raise exception 'Item not found'; end if;
  select * into s from public.gc_sessions where id = i.session_id;
  perform public.gc_guard(s.business_id);
  if s.status not in ('running','paused','billing') then raise exception 'This session is closed'; end if;
  update public.gc_products set stock = stock + i.qty::int where id = i.product_id and track_stock;
  delete from public.gc_items where id = i.id;
  return public.gc_view(s.id);
end $$;

-- ---------- 6. Bills ----------
-- Shared by checkout and counter sale. p: customer_name, customer_phone, discount, payments [{mode, amount, by}], notes
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
  rounded := round(total);
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

create or replace function public.gc_bill_json(bl public.gc_bills) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(bl) || jsonb_build_object('payments', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.gc_payments x where x.bill_id = bl.id))
$$;
revoke execute on function public.gc_bill_json(public.gc_bills) from public, anon, authenticated;

-- Stop (if needed) and bill a session. p also takes lp_final {winner, payers[]} for the last LP game.
create or replace function public.gc_checkout(p_session uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.gc_sessions; calc jsonb; lines jsonb; it jsonb; bl public.gc_bills; payers text[]; w text; rt text;
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
  for it in select * from jsonb_array_elements(calc->'items') loop
    lines := lines || jsonb_build_object('kind', 'item', 'desc', (it->>'name') || coalesce(' (' || (it->>'assigned_to') || ')', ''),
      'qty', (it->>'qty')::numeric, 'rate', (it->>'price')::numeric, 'amount', round((it->>'qty')::numeric * (it->>'price')::numeric, 2));
  end loop;
  bl := public.gc_make_bill(s.business_id, s, calc, lines, p);
  update public.gc_items set bill_id = bl.id where session_id = s.id;
  update public.gc_sessions set status = 'closed', bill_id = bl.id, customer_id = coalesce(customer_id, bl.customer_id) where id = s.id;
  return public.gc_bill_json(bl);
end $$;

-- Counter sale: snacks without a station. p.items [{product_id, qty} | {name, price, qty}]
create or replace function public.gc_quick_sale(p_business uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare it jsonb; pr public.gc_products; q numeric; lines jsonb := '[]'; bl public.gc_bills; s public.gc_sessions;
begin
  perform public.gc_guard(p_business);
  for it in select * from jsonb_array_elements(coalesce(p->'items', '[]')) loop
    q := greatest(coalesce((it->>'qty')::numeric, 1), 1);
    if nullif(it->>'product_id', '') is not null then
      select * into pr from public.gc_products where id = (it->>'product_id')::uuid and business_id = p_business for update;
      if not found then raise exception 'Item not found'; end if;
      if pr.track_stock and pr.stock < q then raise exception 'Only % % left', pr.stock, pr.name; end if;
      if pr.track_stock then update public.gc_products set stock = stock - q::int where id = pr.id; end if;
      lines := lines || jsonb_build_object('kind', 'item', 'desc', pr.name, 'qty', q, 'rate', pr.price, 'amount', round(q * pr.price, 2), 'product_id', pr.id);
    else
      if coalesce(trim(it->>'name'), '') = '' then raise exception 'Enter the item name'; end if;
      lines := lines || jsonb_build_object('kind', 'item', 'desc', trim(it->>'name'), 'qty', q, 'rate', coalesce((it->>'price')::numeric, 0), 'amount', round(q * coalesce((it->>'price')::numeric, 0), 2));
    end if;
  end loop;
  if jsonb_array_length(lines) = 0 then raise exception 'Add at least one item'; end if;
  bl := public.gc_make_bill(p_business, s, null, lines, p);
  insert into public.gc_items (business_id, bill_id, product_id, name, qty, price)
  select p_business, bl.id, nullif(l->>'product_id', '')::uuid, l->>'desc', (l->>'qty')::numeric, (l->>'rate')::numeric from jsonb_array_elements(lines) l;
  return public.gc_bill_json(bl);
end $$;

create or replace function public.gc_bill_pay(p_bill uuid, p_mode text, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare bl public.gc_bills; a numeric;
begin
  select * into bl from public.gc_bills where id = p_bill for update; if not found then raise exception 'Bill not found'; end if;
  perform public.gc_guard(bl.business_id);
  if bl.status = 'void' then raise exception 'This bill is cancelled'; end if;
  if p_mode not in ('cash','upi','card') then raise exception 'Unknown payment mode'; end if;
  a := least(round(coalesce(p_amount, 0), 2), bl.due); if a <= 0 then raise exception 'Nothing to collect'; end if;
  insert into public.gc_payments (business_id, bill_id, customer_id, mode, amount, created_by) values (bl.business_id, bl.id, bl.customer_id, p_mode, a, auth.uid());
  update public.gc_bills set paid = paid + a, due = due - a, status = case when due - a <= 0 then 'paid' else 'partial' end where id = bl.id returning * into bl;
  return public.gc_bill_json(bl);
end $$;

-- Collect a customer's pending amount across their oldest bills first
create or replace function public.gc_settle(p_business uuid, p_customer uuid, p_mode text, p_amount numeric) returns numeric
language plpgsql security definer set search_path = public as $$
declare bl record; left_amt numeric := round(coalesce(p_amount, 0), 2); a numeric;
begin
  perform public.gc_guard(p_business);
  for bl in select id, due from public.gc_bills where business_id = p_business and customer_id = p_customer and due > 0 and status <> 'void' order by created_at loop
    exit when left_amt <= 0;
    a := least(left_amt, bl.due); perform public.gc_bill_pay(bl.id, p_mode, a); left_amt := left_amt - a;
  end loop;
  return round(coalesce(p_amount, 0), 2) - left_amt;
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
  update public.gc_bills set status = 'void', due = 0, notes = trim(notes || ' [Cancelled: ' || p_reason || ']') where id = bl.id;
end $$;

-- ---------- 7. Bookings ----------
-- p: id (to edit), station_id, station_type, customer_name, customer_phone, start_at, minutes, players, status, notes
create or replace function public.gc_booking_save(p_business uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k public.gc_bookings; ph text;
begin
  perform public.gc_guard(p_business);
  ph := nullif(public.norm_phone(p->>'customer_phone', (select country_code from public.businesses where id = p_business)), '');
  if nullif(p->>'id', '') is null then
    if coalesce(trim(p->>'customer_name'), '') = '' then raise exception 'Enter the customer''s name'; end if;
    insert into public.gc_bookings (business_id, station_id, station_type, customer_name, customer_phone, start_at, minutes, players, status, notes)
    values (p_business, nullif(p->>'station_id', '')::uuid, nullif(p->>'station_type', ''), trim(p->>'customer_name'), ph, (p->>'start_at')::timestamptz,
            coalesce((p->>'minutes')::int, 60), coalesce((p->>'players')::int, 1), coalesce(nullif(p->>'status', ''), 'confirmed'), coalesce(p->>'notes', ''))
    returning * into k;
  else
    update public.gc_bookings set
      station_id = case when p ? 'station_id' then nullif(p->>'station_id', '')::uuid else station_id end,
      customer_name = coalesce(nullif(trim(p->>'customer_name'), ''), customer_name), customer_phone = case when p ? 'customer_phone' then ph else customer_phone end,
      start_at = coalesce((p->>'start_at')::timestamptz, start_at), minutes = coalesce((p->>'minutes')::int, minutes),
      players = coalesce((p->>'players')::int, players), status = coalesce(nullif(p->>'status', ''), status), notes = coalesce(p->>'notes', notes)
    where id = (p->>'id')::uuid and business_id = p_business returning * into k;
    if k.id is null then raise exception 'Booking not found'; end if;
  end if;
  return to_jsonb(k);
end $$;

-- Online booking request from the public page (no login). Lands as "pending" for staff to approve.
create or replace function public.gc_public_booking(p_slug text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b record; ph text; t timestamptz;
begin
  select * into b from public.businesses where slug = p_slug and status in ('active','trial');
  if not found or not public.has_module(b.id, 'gaming') then raise exception 'Club not found'; end if;
  if coalesce(trim(p->>'customer_name'), '') = '' then raise exception 'Enter your name'; end if;
  ph := public.norm_phone(p->>'customer_phone', b.country_code);
  if length(coalesce(ph, '')) < 11 then raise exception 'Enter a valid WhatsApp number'; end if;
  t := ((p->>'date') || ' ' || (p->>'time'))::timestamp at time zone 'Asia/Kolkata';
  if t < now() - interval '10 minutes' or t > now() + interval '60 days' then raise exception 'Pick a time in the next 60 days'; end if;
  if (select count(*) from public.gc_bookings where business_id = b.id and customer_phone = ph and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'Too many requests. Please call the club.'; end if;
  insert into public.gc_bookings (business_id, station_type, customer_name, customer_phone, start_at, minutes, players, status, source, notes)
  values (b.id, nullif(p->>'station_type', ''), left(trim(p->>'customer_name'), 80), ph, t, least(greatest(coalesce((p->>'minutes')::int, 60), 30), 600),
          least(greatest(coalesce((p->>'players')::int, 1), 1), 10), 'pending', 'online', left(coalesce(p->>'notes', ''), 300));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.gc_public_booking(text, jsonb) to anon;

-- Public club info for the booking page (stations, rates, offers)
create or replace function public.gc_public_club(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', b.name, 'city', b.city, 'address', b.address, 'phone', b.phone, 'slug', b.slug, 'google_review_link', b.google_review_link,
    'stations', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'n', n, 'rate', rate) order by rate), '[]')
                 from (select type, count(*) n, min(rate) rate from public.gc_stations where business_id = b.id and active group by type) x),
    'offers', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'mode', mode, 'value', value, 'days', days, 'start', to_char(start_time, 'HH24:MI'),
                 'end', case when end_time = '24:00' then '24:00' else to_char(end_time, 'HH24:MI') end, 'station_type', station_type)), '[]')
               from public.gc_rules where business_id = b.id and active and station_type not like '#%'))
  from public.businesses b where b.slug = p_slug and b.status in ('active','trial') and public.has_module(b.id, 'gaming')
$$;
grant execute on function public.gc_public_club(text) to anon, authenticated;

-- Public bill page (link sent on WhatsApp). The token is the only key.
create or replace function public.gc_public_bill(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.gc_bill_json(bl) - 'created_by' - 'customer_id' - 'session_id' - 'followups' - 'last_followup_at'
    || jsonb_build_object('business', jsonb_build_object('name', b.name, 'slug', b.slug, 'city', b.city, 'address', b.address, 'phone', b.phone,
                          'gstin', cf.gstin, 'upi_id', cf.upi_id, 'footer', cf.bill_footer, 'tax_inclusive', cf.tax_inclusive))
  from public.gc_bills bl join public.businesses b on b.id = bl.business_id left join public.gc_settings cf on cf.business_id = b.id
  where bl.token = p_token and length(p_token) >= 12
$$;
grant execute on function public.gc_public_bill(text) to anon, authenticated;

-- ---------- 8. Reports ----------
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
    'by_station', (select coalesce(jsonb_agg(x order by x.sort, x.name), '[]') from (
        select st.name, st.type, st.sort,
          (select count(*) from public.gc_sessions g where g.station_id = st.id and g.status = 'closed' and g.start_at >= a and g.start_at < z) sessions,
          round((select coalesce(sum(extract(epoch from (least(coalesce(i.end_at, now()), z) - greatest(i.start_at, a)))), 0) from public.gc_intervals i join public.gc_sessions g on g.id = i.session_id
                 where g.station_id = st.id and g.status <> 'cancelled' and i.start_at < z and coalesce(i.end_at, now()) > a) / 3600, 2) hours,
          (select coalesce(sum(v.game_amount), 0) from public.gc_bills v join public.gc_sessions g on g.id = v.session_id where g.station_id = st.id and v.status <> 'void' and v.created_at >= a and v.created_at < z) revenue
        from public.gc_stations st where st.business_id = p_business) x),
    'peak', (select coalesce(jsonb_agg(x order by x.hour), '[]') from (select extract(hour from start_at at time zone 'Asia/Kolkata')::int as hour, count(*) sessions
             from public.gc_sessions where business_id = p_business and status = 'closed' and start_at >= a and start_at < z group by 1) x),
    'items', (select coalesce(jsonb_agg(x order by x.revenue desc), '[]') from (select i.name, sum(i.qty) qty, sum(i.qty * i.price) revenue from public.gc_items i join public.gc_bills v on v.id = i.bill_id
              where v.business_id = p_business and v.status <> 'void' and v.created_at >= a and v.created_at < z group by i.name order by 3 desc limit 20) x),
    'range_hours', round(rng / 3600000, 2));
end $$;

-- ---------- 9. WhatsApp add-on: message templates and what to send ----------
insert into public.wa_templates (name, language, category, title, body_preview, params, sample, credits_per_message, active, status)
select * from (values
  ('gc_bill', 'en', 'utility', 'Gaming bill with feedback link',
   'Hi {{1}}, thank you for playing at {{2}}. Your bill {{3}} for {{4}} is here: {{5}} How was your time with us? Tap to rate: {{6}}',
   array['Club name','Bill number','Amount','Bill link','Feedback link'],
   array['Level Up Gaming','GC-00012','₹354','https://gamingclubs.branditudeglobal.com/g.html?t=ab12cd34ef56gh78','https://gamingclubs.branditudeglobal.com/f.html?b=level-up'], 1, false, 'pending'),
  ('gc_payment_due', 'en', 'utility', 'Pending payment follow-up',
   'Hi {{1}}, a reminder from {{2}}: {{3}} is still pending on bill {{4}}. You can see the bill and pay here: {{5}} Thank you.',
   array['Club name','Amount pending','Bill number','Bill link'],
   array['Level Up Gaming','₹200','GC-00012','https://gamingclubs.branditudeglobal.com/g.html?t=ab12cd34ef56gh78'], 1, false, 'pending'),
  ('gc_time_up', 'en', 'utility', 'Gaming time ending soon',
   'Hi {{1}}, your time on {{2}} at {{3}} ends in {{4}} minutes. If you want to keep playing, just tell our staff at the counter.',
   array['Station','Club name','Minutes left'],
   array['PS5 #1','Level Up Gaming','15'], 1, false, 'pending'),
  ('gc_booking_confirmed', 'en', 'utility', 'Booking confirmed',
   'Hi {{1}}, your booking at {{2}} is {{3}} for {{4}}: {{5}}, {{6}} minutes. Reply here if you need to change it.',
   array['Club name','Status (confirmed / cancelled)','Date and time','Station','Minutes'],
   array['Level Up Gaming','confirmed','Sat 22 Nov, 6:00 pm','PS5','60'], 1, false, 'pending'),
  ('gc_owner_alert', 'en', 'utility', 'Alert to the club owner',
   'Hi {{1}}, an update for {{2}}: {{3}}',
   array['Club name','What needs attention'],
   array['Level Up Gaming','low stock on Coke (2 left), Maggi (0 left)'], 1, false, 'pending'),
  ('gc_daily_report', 'en', 'utility', 'Sales report to the owner (daily, weekly, monthly)',
   'Hi {{1}}, here is the summary for {{2}} on {{3}}: sales {{4}} from {{5}} bills, collected {{6}}, pending {{7}}. Busiest station: {{8}}.',
   array['Club name','Date','Sales','Bills','Collected','Pending','Busiest station'],
   array['Level Up Gaming','17 Nov','₹12,450','46','₹11,900','₹550','PS5 #2'], 1, false, 'pending')
) v(name, language, category, title, body_preview, params, sample, credits_per_message, active, status)
where not exists (select 1 from public.wa_templates t where t.name = v.name and t.business_id is null);

-- What a gaming WhatsApp message would say (service role only; the Edge Functions decide whether and how to send)
-- To customers: bill (ref = bill id), due (ref = bill id), reminder (ref = session id), booking (ref = booking id)
-- To the owner: report (ref = date), weekly (ref = Monday of the week reported), monthly (ref = YYYY-MM), low_stock (ref = date), dues (ref = date)
create or replace function public.gc_sales_summary(p_business uuid, d1 date, d2 date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bills', (select count(*) from public.gc_bills where business_id = p_business and status <> 'void' and (created_at at time zone 'Asia/Kolkata')::date between d1 and d2),
    'sales', (select coalesce(sum(total), 0) from public.gc_bills where business_id = p_business and status <> 'void' and (created_at at time zone 'Asia/Kolkata')::date between d1 and d2),
    'due',   (select coalesce(sum(due), 0) from public.gc_bills where business_id = p_business and status <> 'void' and (created_at at time zone 'Asia/Kolkata')::date between d1 and d2),
    'collected', (select coalesce(sum(amount), 0) from public.gc_payments where business_id = p_business and (created_at at time zone 'Asia/Kolkata')::date between d1 and d2),
    'top', (select st.name from public.gc_sessions g join public.gc_stations st on st.id = g.station_id where g.business_id = p_business and g.status = 'closed'
            and (g.start_at at time zone 'Asia/Kolkata')::date between d1 and d2 group by st.name order by count(*) desc limit 1))
$$;
revoke execute on function public.gc_sales_summary(uuid, date, date) from public, anon, authenticated;

create or replace function public.gc_wa_payload(p_business uuid, p_kind text, p_ref text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b record; bl public.gc_bills; s public.gc_sessions; k record; cf public.gc_settings; site text; c jsonb; d1 date; d2 date; lbl text; r jsonb; own text; ownph text; txt text;
  rs text := '₹';
begin
  select * into b from public.businesses where id = p_business; if not found then return jsonb_build_object('skip', 'No business'); end if;
  select * into cf from public.gc_settings where business_id = p_business;
  site := rtrim(coalesce((select value->>'site_url' from public.settings where key = 'gaming'), 'https://scale.branditudeglobal.com'), '/');
  if p_kind in ('bill', 'due') then
    select * into bl from public.gc_bills where id = p_ref::uuid and business_id = p_business;
    if not found or bl.status = 'void' then return jsonb_build_object('skip', 'Bill not found'); end if;
    if coalesce(bl.customer_phone, '') = '' then return jsonb_build_object('skip', 'No mobile number on the bill'); end if;
    if p_kind = 'bill' then
      return jsonb_build_object('template', 'gc_bill', 'phone', bl.customer_phone, 'name', bl.customer_name, 'params',
        jsonb_build_array(b.name, bl.number, rs || trim(to_char(bl.total, 'FM99,99,99,990.##')), site || '/g.html?t=' || bl.token, site || '/f.html?b=' || b.slug));
    end if;
    if bl.due <= 0 then return jsonb_build_object('skip', 'Nothing pending'); end if;
    return jsonb_build_object('template', 'gc_payment_due', 'phone', bl.customer_phone, 'name', bl.customer_name, 'params',
      jsonb_build_array(b.name, rs || trim(to_char(bl.due, 'FM99,99,99,990.##')), bl.number, site || '/g.html?t=' || bl.token));
  elsif p_kind = 'reminder' then
    select * into s from public.gc_sessions where id = p_ref::uuid and business_id = p_business;
    if not found or s.status <> 'running' then return jsonb_build_object('skip', 'Session is not running'); end if;
    if coalesce(s.customer_phone, '') = '' then return jsonb_build_object('skip', 'No mobile number on the session'); end if;
    c := public.gc_calc(s.id);
    return jsonb_build_object('template', 'gc_time_up', 'phone', s.customer_phone, 'name', s.customer_name, 'params',
      jsonb_build_array(c->'station'->>'name', b.name, greatest(0, round(coalesce((c->>'remaining_ms')::numeric, 0) / 60000))::text));
  elsif p_kind = 'booking' then
    select x.*, st.name as station_name into k from public.gc_bookings x left join public.gc_stations st on st.id = x.station_id where x.id = p_ref::uuid and x.business_id = p_business;
    if not found or k.status not in ('confirmed', 'cancelled') then return jsonb_build_object('skip', 'Booking is not confirmed'); end if;
    if coalesce(k.customer_phone, '') = '' then return jsonb_build_object('skip', 'No mobile number on the booking'); end if;
    return jsonb_build_object('template', 'gc_booking_confirmed', 'phone', k.customer_phone, 'name', k.customer_name, 'params',
      jsonb_build_array(b.name, k.status, to_char(k.start_at at time zone 'Asia/Kolkata', 'Dy DD Mon, HH12:MI am'), coalesce(k.station_name, k.station_type, 'any station'), k.minutes::text));
  end if;

  -- owner messages
  select coalesce(nullif(p.full_name, ''), 'there') into own
    from public.business_members m left join public.profiles p on p.id = m.user_id where m.business_id = p_business and m.role = 'owner' limit 1;
  ownph := public.norm_phone(coalesce(nullif(cf.report_phone, ''), b.phone), b.country_code);
  if coalesce(ownph, '') = '' then return jsonb_build_object('skip', 'No owner number for reports'); end if;
  if p_kind in ('report', 'weekly', 'monthly') then
    if p_kind = 'report' then d1 := p_ref::date; d2 := d1; lbl := to_char(d1, 'DD Mon');
    elsif p_kind = 'weekly' then d1 := p_ref::date; d2 := d1 + 6; lbl := 'the week ' || to_char(d1, 'DD Mon') || ' – ' || to_char(d2, 'DD Mon');
    else d1 := (p_ref || '-01')::date; d2 := (d1 + interval '1 month')::date - 1; lbl := to_char(d1, 'FMMonth YYYY'); end if;
    r := public.gc_sales_summary(p_business, d1, d2);
    return jsonb_build_object('template', 'gc_daily_report', 'phone', ownph, 'name', coalesce(own, 'there'), 'params',
      jsonb_build_array(b.name, lbl, rs || trim(to_char((r->>'sales')::numeric, 'FM99,99,99,990')), r->>'bills',
        rs || trim(to_char((r->>'collected')::numeric, 'FM99,99,99,990')), rs || trim(to_char((r->>'due')::numeric, 'FM99,99,99,990')), coalesce(r->>'top', '—')));
  elsif p_kind = 'low_stock' then
    txt := (select string_agg(name || ' (' || stock || ' left)', ', ' order by stock, name) from (select name, stock from public.gc_products
            where business_id = p_business and active and track_stock and stock <= low_stock order by stock limit 8) x);
    if txt is null then return jsonb_build_object('skip', 'Nothing is low on stock'); end if;
    return jsonb_build_object('template', 'gc_owner_alert', 'phone', ownph, 'name', coalesce(own, 'there'), 'params', jsonb_build_array(b.name, 'low stock on ' || txt));
  elsif p_kind = 'dues' then
    select count(distinct coalesce(customer_id::text, customer_phone)) as n, coalesce(sum(due), 0) as amt, min(created_at) as oldest into k
      from public.gc_bills where business_id = p_business and due > 0 and status in ('partial', 'unpaid');
    if k.amt <= 0 then return jsonb_build_object('skip', 'Nothing pending'); end if;
    return jsonb_build_object('template', 'gc_owner_alert', 'phone', ownph, 'name', coalesce(own, 'there'), 'params', jsonb_build_array(b.name,
      rs || trim(to_char(k.amt, 'FM99,99,99,990')) || ' is pending from ' || k.n || ' customer' || case when k.n = 1 then '' else 's' end
      || '; the oldest bill is ' || greatest(0, (now()::date - (k.oldest at time zone 'Asia/Kolkata')::date)) || ' days old'));
  end if;
  return jsonb_build_object('skip', 'Unknown message');
end $$;
revoke execute on function public.gc_wa_payload(uuid, text, text) from public, anon, authenticated;
grant execute on function public.gc_wa_payload(uuid, text, text) to service_role;

-- Messages the scheduler should send now (every 5 minutes). Each club picks which ones it wants (gc_settings switches).
create or replace function public.gc_wa_jobs() returns table (business_id uuid, kind text, ref text)
language sql stable security definer set search_path = public as $$
  with biz as (
    select b.id, cf.*, (now() at time zone 'Asia/Kolkata') as lt from public.businesses b join public.gc_settings cf on cf.business_id = b.id
    where b.status = 'active' and b.wa_enabled and public.biz_open(b.id) and public.has_module(b.id, 'wa_billing') and public.has_module(b.id, 'gaming')),
  owner_jobs as (   -- owner reports go out once, at the hour the club chose
    select biz.id, 'report'::text as kind, biz.lt::date::text as ref from biz where biz.wa_daily_report and extract(hour from biz.lt) = biz.report_hour
    union all select biz.id, 'weekly', (biz.lt::date - 7)::text from biz where biz.report_weekly and extract(isodow from biz.lt) = 1 and extract(hour from biz.lt) = biz.report_hour
    union all select biz.id, 'monthly', to_char(biz.lt - interval '1 month', 'YYYY-MM') from biz where biz.report_monthly and extract(day from biz.lt) = 1 and extract(hour from biz.lt) = biz.report_hour
    union all select biz.id, 'low_stock', biz.lt::date::text from biz where biz.report_low_stock and extract(hour from biz.lt) = biz.report_hour
      and exists (select 1 from public.gc_products p where p.business_id = biz.id and p.active and p.track_stock and p.stock <= p.low_stock)
    union all select biz.id, 'dues', biz.lt::date::text from biz where biz.report_dues and extract(hour from biz.lt) = biz.report_hour
      and exists (select 1 from public.gc_bills x where x.business_id = biz.id and x.due > 0 and x.status in ('partial','unpaid')))
  select s.business_id, 'reminder', s.id::text from public.gc_sessions s join biz on biz.id = s.business_id
   where biz.wa_time_reminder and s.status = 'running' and s.booked_minutes > 0 and not s.reminded and coalesce(s.customer_phone, '') <> ''
     and s.start_at + make_interval(mins => s.booked_minutes - biz.reminder_minutes) <= now()   -- cheap pre-filter; exact check in the function
  union all
  select bl.business_id, 'due', bl.id::text from public.gc_bills bl join biz on biz.id = bl.business_id
   where biz.wa_followup and bl.due > 0 and bl.status in ('partial','unpaid') and coalesce(bl.customer_phone, '') <> '' and bl.followups < biz.followup_times
     and coalesce(bl.last_followup_at, bl.created_at) < now() - make_interval(days => biz.followup_days)
     and extract(hour from now() at time zone 'Asia/Kolkata') between 10 and 19
  union all
  select o.id, o.kind, o.ref from owner_jobs o
   where not exists (select 1 from public.gc_wa_log l where l.business_id = o.id and l.kind = o.kind and l.ref = o.ref and l.status = 'sent')
$$;
revoke execute on function public.gc_wa_jobs() from public, anon, authenticated;
grant execute on function public.gc_wa_jobs() to service_role;

-- After a send: remember it so it isn't sent twice
create or replace function public.gc_wa_done(p_business uuid, p_kind text, p_ref text, p_phone text, p_status text, p_error text, p_credits int, p_wamid text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.gc_wa_log (business_id, kind, ref, phone, status, error, credits, wa_message_id) values (p_business, p_kind, p_ref, coalesce(p_phone, ''), p_status, p_error, p_credits, p_wamid);
  if p_kind = 'reminder' then update public.gc_sessions set reminded = true where id = p_ref::uuid; end if;
  if p_kind = 'due' and p_status = 'sent' then update public.gc_bills set followups = followups + 1, last_followup_at = now() where id = p_ref::uuid; end if;
end $$;
revoke execute on function public.gc_wa_done(uuid, text, text, text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.gc_wa_done(uuid, text, text, text, text, text, int, text) to service_role;

-- Execute rights for the screens
revoke execute on function public.gc_board(uuid), public.gc_session(uuid), public.gc_start(uuid, jsonb), public.gc_action(uuid, text, jsonb),
  public.gc_lp_split(uuid, text, text[]), public.gc_lp_undo(uuid), public.gc_item_add(uuid, jsonb), public.gc_item_remove(bigint),
  public.gc_checkout(uuid, jsonb), public.gc_quick_sale(uuid, jsonb), public.gc_bill_pay(uuid, text, numeric), public.gc_settle(uuid, uuid, text, numeric),
  public.gc_bill_void(uuid, text), public.gc_booking_save(uuid, jsonb), public.gc_report(uuid, date, date) from public, anon;
grant execute on function public.gc_board(uuid), public.gc_session(uuid), public.gc_start(uuid, jsonb), public.gc_action(uuid, text, jsonb),
  public.gc_lp_split(uuid, text, text[]), public.gc_lp_undo(uuid), public.gc_item_add(uuid, jsonb), public.gc_item_remove(bigint),
  public.gc_checkout(uuid, jsonb), public.gc_quick_sale(uuid, jsonb), public.gc_bill_pay(uuid, text, numeric), public.gc_settle(uuid, uuid, text, numeric),
  public.gc_bill_void(uuid, text), public.gc_booking_save(uuid, jsonb), public.gc_report(uuid, date, date) to authenticated;

-- Scheduler: every 5 minutes (time-up reminders need to be on time)
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('gc-wa-5min') where exists (select 1 from cron.job where jobname = 'gc-wa-5min');
    perform cron.schedule('gc-wa-5min', '*/5 * * * *', $job$
      select net.http_post(
        url := 'https://dumninwceiqvevndpupc.supabase.co/functions/v1/gc-cron',
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-cron-secret', (select value from public.internal_secrets where key = 'cron_secret')),
        body := '{"action":"cron"}'::jsonb,
        timeout_milliseconds := 60000)
    $job$);
  end if;
end $$;

-- Security advisor tidy-up
alter function public.mod_area(text) set search_path = public;
alter function public.gc_rule_hits(public.gc_rules, public.gc_stations, timestamptz) set search_path = public;
alter function public.gc_rate_at(public.gc_stations, public.gc_rules[], int, timestamptz) set search_path = public;
revoke execute on function public.check_package_category() from public, anon, authenticated;
