-- Staff attendance + salary, and QR menu + table ordering.
-- Both are "modules" that packages switch on (packages.modules). Existing packages get both by default.

/* ============ plan modules ============ */
alter table public.packages add column if not exists modules text[] not null default '{attendance,menu}';

create or replace function public.has_module(b uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.businesses x join public.packages p on p.id = x.package_id
                 where x.id = b and m = any(p.modules))
$$;
create or replace function public.can_use(b uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or (public.can_write(b) and public.has_module(b, m))
$$;
revoke execute on function public.has_module(uuid, text), public.can_use(uuid, text) from public, anon;
grant execute on function public.has_module(uuid, text), public.can_use(uuid, text) to authenticated;

/* ============ attendance ============ */
create table if not exists public.staff (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 80),
  phone           text not null default '',
  designation     text not null default '',
  pay_type        text not null default 'monthly' check (pay_type in ('monthly','daily','hourly')),
  pay_rate        numeric(12,2) not null default 0 check (pay_rate >= 0),
  shift_start     time not null default '10:00',
  shift_end       time not null default '19:00',
  break_minutes   int  not null default 0 check (break_minutes between 0 and 240),
  weekly_off      int[] not null default '{0}',          -- 0 = Sunday … 6 = Saturday
  joined_on       date not null default current_date,
  active          boolean not null default true,
  sort            int not null default 100,
  pin_hash        text,
  failed_pins     int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists staff_biz on public.staff (business_id);
create unique index if not exists staff_phone_uq on public.staff (business_id, phone) where phone <> '' and active;

create table if not exists public.att_settings (
  business_id          uuid primary key references public.businesses(id) on delete cascade,
  grace_minutes        int not null default 10 check (grace_minutes between 0 and 240),
  late_allowed         int not null default 3 check (late_allowed between 0 and 31),
  late_rule            text not null default 'half_day_per' check (late_rule in ('none','half_day_per','full_day_per','fixed_per_late','per_minute')),
  late_rule_value      numeric(10,2) not null default 3 check (late_rule_value >= 0),
  count_early_leave    boolean not null default true,
  early_grace_minutes  int not null default 10 check (early_grace_minutes between 0 and 240),
  half_day_below_hours numeric(4,2) not null default 6 check (half_day_below_hours between 0 and 24),
  absent_below_hours   numeric(4,2) not null default 3 check (absent_below_hours between 0 and 24),
  deduction_basis      text not null default 'day' check (deduction_basis in ('day','hour')),
  month_days           text not null default 'calendar' check (month_days in ('calendar','fixed','working')),
  fixed_days           int not null default 30 check (fixed_days between 20 and 31),
  paid_leaves          numeric(4,1) not null default 1 check (paid_leaves between 0 and 31),
  absent_uses_leave    boolean not null default true,
  paid_weekly_off      boolean not null default true,
  paid_holidays        boolean not null default true,
  sandwich_rule        boolean not null default false,
  offday_work_pay      boolean not null default true,
  overtime_on          boolean not null default false,
  overtime_after_min   int not null default 30 check (overtime_after_min between 0 and 600),
  overtime_multiplier  numeric(4,2) not null default 1 check (overtime_multiplier between 0 and 5),
  missed_checkout      text not null default 'full' check (missed_checkout in ('full','half','absent')),
  geo_on               boolean not null default false,
  geo_lat              double precision,
  geo_lng              double precision,
  geo_radius           int not null default 150 check (geo_radius between 30 and 5000),
  updated_at           timestamptz not null default now()
);

create table if not exists public.attendance (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id    uuid not null references public.staff(id) on delete cascade,
  day         date not null,
  check_in    timestamptz,
  check_out   timestamptz,
  mark        text check (mark in ('present','half_day','absent','leave','paid_leave','unpaid_leave','holiday','week_off')),
  note        text not null default '',
  source      text not null default 'manual',
  in_geo      jsonb,
  out_geo     jsonb,
  updated_at  timestamptz not null default now(),
  unique (staff_id, day),
  check (check_out is null or check_in is null or check_out >= check_in)
);
create index if not exists att_biz_day on public.attendance (business_id, day);

create table if not exists public.holidays (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  day         date not null,
  name        text not null default 'Holiday',
  unique (business_id, day)
);

create table if not exists public.salary_adjustments (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id    uuid not null references public.staff(id) on delete cascade,
  month       date not null check (extract(day from month) = 1),
  kind        text not null check (kind in ('bonus','allowance','advance','deduction')),
  amount      numeric(12,2) not null check (amount > 0),
  note        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists sadj_biz_month on public.salary_adjustments (business_id, month);

create table if not exists public.salary_slips (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  staff_id    uuid not null references public.staff(id) on delete cascade,
  month       date not null check (extract(day from month) = 1),
  data        jsonb not null,
  net         numeric(12,2) not null,
  paid        boolean not null default false,
  paid_on     date,
  paid_mode   text not null default '',
  created_at  timestamptz not null default now(),
  unique (staff_id, month)
);

alter table public.staff enable row level security;
alter table public.att_settings enable row level security;
alter table public.attendance enable row level security;
alter table public.holidays enable row level security;
alter table public.salary_adjustments enable row level security;
alter table public.salary_slips enable row level security;

create policy staff_read  on public.staff for select using (public.is_member(business_id) or public.is_staff());
create policy staff_ins   on public.staff for insert with check (public.can_use(business_id, 'attendance'));
create policy staff_upd   on public.staff for update using (public.can_use(business_id, 'attendance')) with check (public.can_use(business_id, 'attendance'));
create policy staff_del   on public.staff for delete using (public.can_use(business_id, 'attendance'));
-- PIN hash and lockout columns are never readable or writable from the browser
revoke all on public.staff from anon, authenticated;
grant select (id, business_id, name, phone, designation, pay_type, pay_rate, shift_start, shift_end, break_minutes, weekly_off, joined_on, active, sort, created_at),
      insert (business_id, name, phone, designation, pay_type, pay_rate, shift_start, shift_end, break_minutes, weekly_off, joined_on, active, sort),
      update (name, phone, designation, pay_type, pay_rate, shift_start, shift_end, break_minutes, weekly_off, joined_on, active, sort),
      delete on public.staff to authenticated;

do $$ declare t text; begin
  foreach t in array array['att_settings','attendance','holidays','salary_adjustments','salary_slips'] loop
    execute format('create policy %1$s_read on public.%1$s for select using (public.is_member(business_id) or public.is_staff())', t);
    execute format('create policy %1$s_ins on public.%1$s for insert with check (public.can_use(business_id, ''attendance''))', t);
    execute format('create policy %1$s_upd on public.%1$s for update using (public.can_use(business_id, ''attendance'')) with check (public.can_use(business_id, ''attendance''))', t);
    execute format('create policy %1$s_del on public.%1$s for delete using (public.can_use(business_id, ''attendance''))', t);
  end loop;
end $$;

create or replace function public.pin_hash(p_staff uuid, p_pin text) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(p_staff::text || ':' || p_pin, 'UTF8')), 'hex')
$$;
revoke execute on function public.pin_hash(uuid, text) from public, anon, authenticated;

-- Owner sets or resets a staff member's 4–6 digit PIN
create or replace function public.set_staff_pin(p_staff uuid, p_pin text) returns void
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from public.staff where id = p_staff;
  if b is null or not public.can_use(b, 'attendance') then raise exception 'Not allowed'; end if;
  if p_pin !~ '^\d{4,6}$' then raise exception 'PIN must be 4 to 6 digits'; end if;
  update public.staff set pin_hash = public.pin_hash(p_staff, p_pin), failed_pins = 0, locked_until = null where id = p_staff;
end $$;
revoke execute on function public.set_staff_pin(uuid, text) from public, anon;
grant execute on function public.set_staff_pin(uuid, text) to authenticated;

-- Which staff already have a PIN (without exposing the hash)
create or replace function public.staff_pin_status(b uuid) returns table (staff_id uuid, has_pin boolean, locked boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.pin_hash is not null, coalesce(s.locked_until > now(), false)
  from public.staff s where s.business_id = b and (public.is_member(b) or public.is_staff())
$$;
revoke execute on function public.staff_pin_status(uuid) from public, anon;
grant execute on function public.staff_pin_status(uuid) to authenticated;

-- Public check-in / check-out (attendance page at the shop). Phone + PIN; optional location fence.
create or replace function public.staff_punch(p_slug text, p_phone text, p_pin text, p_lat double precision default null, p_lng double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b public.businesses; s public.staff; st public.att_settings; a public.attendance;
  v_now timestamptz := now(); v_day date := (now() at time zone 'Asia/Kolkata')::date;
  v_dist double precision; v_geo jsonb; v_late int; v_action text;
begin
  select * into b from public.businesses where slug = p_slug;
  if b.id is null or not public.biz_open(b.id) or not public.has_module(b.id, 'attendance') then raise exception 'Attendance is not available for this business'; end if;
  select * into s from public.staff where business_id = b.id and active and phone <> '' and phone = public.norm_phone(p_phone, coalesce(nullif(b.country_code,''),'91'));
  if s.id is null or s.pin_hash is null then raise exception 'Phone number or PIN is wrong'; end if;
  if s.locked_until is not null and s.locked_until > v_now then
    return jsonb_build_object('error', 'Too many wrong PINs. Try again in 15 minutes or ask the owner to reset it.');
  end if;
  if s.pin_hash <> public.pin_hash(s.id, coalesce(p_pin,'')) then
    -- returned (not raised) so the failed-attempt count is saved and the 5-try lockout works
    update public.staff set failed_pins = failed_pins + 1,
      locked_until = case when failed_pins + 1 >= 5 then v_now + interval '15 minutes' else null end where id = s.id;
    return jsonb_build_object('error', case when s.failed_pins + 1 >= 5 then 'Too many wrong PINs. Try again in 15 minutes or ask the owner to reset it.' else 'Phone number or PIN is wrong' end);
  end if;
  update public.staff set failed_pins = 0, locked_until = null where id = s.id;

  select * into st from public.att_settings where business_id = b.id;
  if p_lat is not null and p_lng is not null then v_geo := jsonb_build_object('lat', p_lat, 'lng', p_lng); end if;
  if coalesce(st.geo_on, false) and st.geo_lat is not null then
    if p_lat is null or p_lng is null then raise exception 'Turn on location so we can confirm you are at the shop'; end if;
    v_dist := 6371000 * 2 * asin(sqrt(power(sin(radians(p_lat - st.geo_lat) / 2), 2) + cos(radians(st.geo_lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - st.geo_lng) / 2), 2)));
    if v_dist > st.geo_radius then raise exception 'You seem to be % m away from the shop. Check in when you reach.', round(v_dist)::int; end if;
  end if;

  select * into a from public.attendance where staff_id = s.id and day = v_day;
  if a.id is null or a.check_in is null then
    insert into public.attendance (business_id, staff_id, day, check_in, source, in_geo) values (b.id, s.id, v_day, v_now, 'self', v_geo)
    on conflict (staff_id, day) do update set check_in = v_now, source = 'self', in_geo = v_geo, updated_at = v_now;
    v_action := 'in';
  elsif a.check_out is null then
    if v_now - a.check_in < interval '2 minutes' then raise exception 'You already checked in at %', to_char(a.check_in at time zone 'Asia/Kolkata', 'HH12:MI AM'); end if;
    update public.attendance set check_out = v_now, out_geo = v_geo, updated_at = v_now where id = a.id;
    v_action := 'out';
  else
    raise exception 'You already checked out today at %', to_char(a.check_out at time zone 'Asia/Kolkata', 'HH12:MI AM');
  end if;
  v_late := greatest(0, floor(extract(epoch from ((v_now at time zone 'Asia/Kolkata')::time - s.shift_start)) / 60)::int);
  return jsonb_build_object('action', v_action, 'name', s.name, 'time', to_char(v_now at time zone 'Asia/Kolkata', 'HH12:MI AM'),
    'late_minutes', case when v_action = 'in' and v_late > coalesce(st.grace_minutes, 10) then v_late else 0 end, 'business', b.name);
end $$;
revoke execute on function public.staff_punch(text, text, text, double precision, double precision) from public;
grant execute on function public.staff_punch(text, text, text, double precision, double precision) to anon, authenticated;

/* ============ QR menu & orders ============ */
create table if not exists public.menu_settings (
  business_id  uuid primary key references public.businesses(id) on delete cascade,
  ordering_on  boolean not null default true,
  show_prices  boolean not null default true,
  note         text not null default '',
  updated_at   timestamptz not null default now()
);
create table if not exists public.menu_categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 60),
  sort        int not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists menu_cat_uq on public.menu_categories (business_id, lower(name));
create table if not exists public.menu_items (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  category_id   uuid references public.menu_categories(id) on delete set null,
  name          text not null check (length(trim(name)) between 1 and 80),
  description   text not null default '',
  price         numeric(10,2) not null default 0 check (price >= 0),
  food_type     text not null default 'veg' check (food_type in ('veg','nonveg','egg','na')),
  image_url     text not null default '',
  available     boolean not null default true,
  bestseller    boolean not null default false,
  sort          int not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists menu_items_biz on public.menu_items (business_id, category_id);
create table if not exists public.dining_tables (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  label       text not null check (length(trim(label)) between 1 and 30),
  active      boolean not null default true,
  sort        int not null default 100,
  created_at  timestamptz not null default now()
);
create unique index if not exists dining_tables_uq on public.dining_tables (business_id, lower(label));
create table if not exists public.orders (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  order_no       int not null,
  table_id       uuid references public.dining_tables(id) on delete set null,
  table_label    text not null default '',
  customer_name  text not null default '',
  customer_phone text not null default '',
  note           text not null default '',
  status         text not null default 'new' check (status in ('new','preparing','ready','served','cancelled')),
  total          numeric(10,2) not null default 0,
  item_count     int not null default 0,
  token          text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists orders_biz_time on public.orders (business_id, created_at desc);
create table if not exists public.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  item_id     uuid references public.menu_items(id) on delete set null,
  name        text not null,
  price       numeric(10,2) not null,
  qty         int not null check (qty between 1 and 50),
  food_type   text not null default 'na'
);
create index if not exists order_items_order on public.order_items (order_id);

alter table public.menu_settings enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.dining_tables enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

do $$ declare t text; begin
  foreach t in array array['menu_settings','menu_categories','menu_items','dining_tables'] loop
    execute format('create policy %1$s_read on public.%1$s for select using (public.is_member(business_id) or public.is_staff())', t);
    execute format('create policy %1$s_ins on public.%1$s for insert with check (public.can_use(business_id, ''menu''))', t);
    execute format('create policy %1$s_upd on public.%1$s for update using (public.can_use(business_id, ''menu'')) with check (public.can_use(business_id, ''menu''))', t);
    execute format('create policy %1$s_del on public.%1$s for delete using (public.can_use(business_id, ''menu''))', t);
  end loop;
end $$;
-- Orders: customers create them only through place_order(); the shop reads them and moves their status
create policy orders_read on public.orders for select using (public.is_member(business_id) or public.is_staff());
create policy orders_upd  on public.orders for update using (public.can_use(business_id, 'menu')) with check (public.can_use(business_id, 'menu'));
create policy oitems_read on public.order_items for select using (public.is_member(business_id) or public.is_staff());
revoke insert, delete on public.orders, public.order_items from anon, authenticated;
revoke update on public.orders from anon, authenticated;
grant update (status, updated_at) on public.orders to authenticated;

-- Public menu for m.html
create or replace function public.public_menu(p_slug text, p_table uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b public.businesses; ms public.menu_settings; t public.dining_tables;
begin
  select * into b from public.businesses where slug = p_slug;
  if b.id is null or not public.biz_open(b.id) or not public.has_module(b.id, 'menu') then return null; end if;
  select * into ms from public.menu_settings where business_id = b.id;
  if p_table is not null then select * into t from public.dining_tables where id = p_table and business_id = b.id and active; end if;
  return jsonb_build_object(
    'name', b.name, 'city', b.city, 'slug', b.slug,
    'ordering_on', coalesce(ms.ordering_on, true), 'show_prices', coalesce(ms.show_prices, true), 'note', coalesce(ms.note, ''),
    'table', case when t.id is null then null else jsonb_build_object('id', t.id, 'label', t.label) end,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort, c.name)
                            from public.menu_categories c where c.business_id = b.id and c.active), '[]'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'category_id', i.category_id, 'name', i.name, 'description', i.description,
                        'price', case when coalesce(ms.show_prices, true) then i.price else null end, 'food_type', i.food_type, 'image_url', i.image_url,
                        'available', i.available, 'bestseller', i.bestseller) order by i.sort, i.name)
                       from public.menu_items i left join public.menu_categories c on c.id = i.category_id
                       where i.business_id = b.id and (c.id is null or c.active)), '[]'));
end $$;
revoke execute on function public.public_menu(text, uuid) from public;
grant execute on function public.public_menu(text, uuid) to anon, authenticated;

create or replace function public.place_order(p_slug text, p_table uuid, p_items jsonb, p_name text default '', p_phone text default '', p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.businesses; ms public.menu_settings; t public.dining_tables; v_order uuid; v_no int; v_token text;
        v_total numeric := 0; v_count int := 0; r record; it public.menu_items;
begin
  select * into b from public.businesses where slug = p_slug;
  if b.id is null or not public.biz_open(b.id) or not public.has_module(b.id, 'menu') then raise exception 'This menu is not available right now'; end if;
  select * into ms from public.menu_settings where business_id = b.id;
  if not coalesce(ms.ordering_on, true) then raise exception 'Ordering from the table is switched off. Please order with the staff.'; end if;
  if p_table is not null then
    select * into t from public.dining_tables where id = p_table and business_id = b.id and active;
    if t.id is null then raise exception 'This table QR is no longer valid. Please ask the staff.'; end if;
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Your order is empty'; end if;
  if jsonb_array_length(p_items) > 40 then raise exception 'Too many items in one order'; end if;
  -- simple abuse limits
  if (select count(*) from public.orders where business_id = b.id and created_at > now() - interval '1 minute') >= 30
     or (p_table is not null and (select count(*) from public.orders where table_id = p_table and created_at > now() - interval '5 minutes') >= 6) then
    raise exception 'Too many orders just now. Please wait a minute or ask the staff.';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');
  select coalesce(max(order_no), 0) + 1 into v_no from public.orders where business_id = b.id and created_at >= date_trunc('day', now());
  insert into public.orders (business_id, order_no, table_id, table_label, customer_name, customer_phone, note, token)
  values (b.id, v_no, t.id, coalesce(t.label, 'Counter'), left(trim(coalesce(p_name,'')), 60), left(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 15), left(trim(coalesce(p_note,'')), 300), v_token)
  returning id into v_order;

  for r in select (e->>'id')::uuid as id, greatest(1, least(50, coalesce((e->>'qty')::int, 1))) as qty from jsonb_array_elements(p_items) e loop
    select * into it from public.menu_items where id = r.id and business_id = b.id;
    if it.id is null then raise exception 'An item in your order is no longer on the menu'; end if;
    if not it.available then raise exception '"%" just sold out. Please remove it and try again.', it.name; end if;
    insert into public.order_items (order_id, business_id, item_id, name, price, qty, food_type) values (v_order, b.id, it.id, it.name, it.price, r.qty, it.food_type);
    v_total := v_total + it.price * r.qty; v_count := v_count + r.qty;
  end loop;
  update public.orders set total = v_total, item_count = v_count where id = v_order;
  return jsonb_build_object('id', v_order, 'token', v_token, 'order_no', v_no, 'total', v_total);
end $$;
revoke execute on function public.place_order(text, uuid, jsonb, text, text, text) from public;
grant execute on function public.place_order(text, uuid, jsonb, text, text, text) to anon, authenticated;

create or replace function public.order_status(p_id uuid, p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('order_no', o.order_no, 'status', o.status, 'total', o.total, 'table', o.table_label, 'created_at', o.created_at,
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty, 'price', i.price)) from public.order_items i where i.order_id = o.id), '[]'))
  from public.orders o where o.id = p_id and o.token = p_token
$$;
revoke execute on function public.order_status(uuid, text) from public;
grant execute on function public.order_status(uuid, text) to anon, authenticated;
