-- 1) Digital loyalty card link per customer (+ scan to stamp)
-- 2) Team logins: owner / admin / staff with per-area permissions
-- 3) Staff advances recovered from salary in instalments
-- 4) Accounts: heads with classes, double-entry vouchers, reports, GST, Tally export

/* =================== 1. Loyalty card link =================== */
alter table public.customers add column if not exists card_token text;
update public.customers set card_token = substr(replace(gen_random_uuid()::text, '-', ''), 1, 20) where card_token is null;
alter table public.customers alter column card_token set default substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
alter table public.customers alter column card_token set not null;
create unique index if not exists customers_card_token_uq on public.customers (card_token);

-- Public: the customer's own card, opened from the link (no sign-in). Token is unguessable (80 bits).
create or replace function public.public_card(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'customer', jsonb_build_object('name', split_part(c.name, ' ', 1), 'stamps', c.stamps, 'cards_completed', c.cards_completed, 'visits', c.visits, 'token', c.card_token),
    'business', jsonb_build_object('name', b.name, 'slug', b.slug, 'city', b.city, 'phone', b.phone, 'address', b.address,
                                   'google_review_link', b.google_review_link, 'icon', cat.icon),
    'program', (select to_jsonb(p) - 'business_id' from public.loyalty_programs p where p.business_id = b.id),
    'rewards', coalesce((select jsonb_agg(to_jsonb(r) - 'business_id' order by r.visit_no) from public.loyalty_rewards r where r.business_id = b.id), '[]'),
    'offers', coalesce((select jsonb_agg(jsonb_build_object('code', k.code, 'title', k.title, 'type', k.type, 'value', k.value, 'max_discount', k.max_discount, 'min_bill', k.min_bill, 'expiry', k.expiry))
                        from public.coupons k where k.business_id = b.id and k.active and k.show_to_customers
                          and (k.expiry is null or k.expiry >= current_date) and (k.usage_limit = 0 or k.used < k.usage_limit)), '[]'))
  from public.customers c join public.businesses b on b.id = c.business_id left join public.categories cat on cat.id = b.category_id
  where c.card_token = p_token and length(p_token) >= 16
$$;
revoke execute on function public.public_card(text) from public;
grant execute on function public.public_card(text) to anon, authenticated;

/* =================== 2. Team: roles and permissions =================== */
-- Areas: customers (customers, visits, loyalty, offers, feedback) · reviews · whatsapp · menu · attendance · accounts · settings (profile, plan, team)
alter table public.business_members drop constraint if exists business_members_role_check;
alter table public.business_members add constraint business_members_role_check check (role in ('owner', 'admin', 'staff'));
alter table public.business_members add column if not exists perms text[] not null default '{}';
alter table public.business_members add column if not exists created_at timestamptz not null default now();

create table if not exists public.business_invites (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  email       text not null check (email = lower(trim(email)) and email like '%_@_%'),
  role        text not null default 'staff' check (role in ('admin', 'staff')),
  perms       text[] not null default '{}',
  invited_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (business_id, email)
);
alter table public.business_invites enable row level security;
-- no direct table access; the team_* functions below handle it

create or replace function public.perm_areas() returns text[] language sql immutable as $$
  select '{customers,reviews,whatsapp,menu,attendance,accounts,settings}'::text[]
$$;

create or replace function public.member_has_perm(b uuid, u uuid, area text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.business_members m where m.business_id = b and m.user_id = u
                 and (m.role in ('owner', 'admin') or area = any(m.perms)))
$$;
create or replace function public.has_perm(b uuid, area text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.member_has_perm(b, auth.uid(), area)
$$;
revoke execute on function public.member_has_perm(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.member_has_perm(uuid, uuid, text) to service_role;
revoke execute on function public.has_perm(uuid, text) from public, anon;
grant execute on function public.has_perm(uuid, text) to authenticated;

-- Which area a module belongs to
create or replace function public.mod_area(m text) returns text language sql immutable as $$
  select case when m in ('menu') then 'menu' when m in ('attendance') then 'attendance' when m in ('accounting') then 'accounts'
              when m in ('bulk_whatsapp', 'campaigns') then 'whatsapp' when m in ('seo', 'google_replies') then 'reviews' else 'customers' end
$$;

-- Core writes (customers, visits, loyalty, coupons, feedback…) need the "customers" area
create or replace function public.can_write(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or (public.has_perm(b, 'customers') and public.biz_open(b))
$$;
create or replace function public.can_area(b uuid, area text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or (public.has_perm(b, area) and public.biz_open(b))
$$;
create or replace function public.can_use(b uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or (public.has_perm(b, public.mod_area(m)) and public.biz_open(b) and public.has_module(b, m))
$$;
revoke execute on function public.can_area(uuid, text) from public, anon;
grant execute on function public.can_area(uuid, text) to authenticated;

-- Business profile changes need "settings"
drop policy if exists biz_update on public.businesses;
create policy biz_update on public.businesses for update
  using (public.is_staff() or (public.has_perm(id, 'settings') and public.biz_open(id)))
  with check (public.is_staff() or (public.has_perm(id, 'settings') and public.biz_open(id)));
-- Billing is visible to people who manage settings
drop policy if exists pay_read on public.payments;
create policy pay_read on public.payments for select using (public.has_perm(business_id, 'settings') or public.is_staff());

-- Salaries and attendance are only visible to people with the attendance area
drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select using (public.has_perm(business_id, 'attendance') or public.is_staff());
do $$ declare t text; begin
  foreach t in array array['att_settings', 'attendance', 'holidays', 'salary_adjustments', 'salary_slips'] loop
    execute format('drop policy if exists %1$s_read on public.%1$s', t);
    execute format('create policy %1$s_read on public.%1$s for select using (public.has_perm(business_id, ''attendance'') or public.is_staff())', t);
  end loop;
end $$;

-- Deletes on core tables need write access too (the shared "for all" policies only checked membership for deletes)
do $$ declare t text; begin
  foreach t in array array['customers', 'coupons', 'feedback', 'reminders', 'loyalty_rewards', 'loyalty_programs'] loop
    execute format('drop policy if exists %1$s_del_guard on public.%1$s', t);
    execute format('create policy %1$s_del_guard on public.%1$s as restrictive for delete using (public.can_write(business_id))', t);
  end loop;
end $$;

-- Team management (needs "settings"). Admins can't change the owner or other admins unless they are the owner.
create or replace function public.team_list(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_business, 'settings') or public.is_staff()) then raise exception 'Only the owner or an admin can manage the team'; end if;
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'perms', m.perms, 'email', u.email,
                 'name', coalesce(pr.full_name, ''), 'me', m.user_id = auth.uid(), 'since', m.created_at) order by (m.role = 'owner') desc, m.role, u.email)
               from public.business_members m left join auth.users u on u.id = m.user_id left join public.profiles pr on pr.id = m.user_id
               where m.business_id = p_business), '[]'),
    'invites', coalesce((select jsonb_agg(to_jsonb(i) - 'business_id' - 'invited_by' order by i.created_at) from public.business_invites i where i.business_id = p_business), '[]'));
end $$;

create or replace function public.team_save(p_business uuid, p_email text, p_role text, p_perms text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_user uuid; v_my text; v_cur text; v_perms text[];
begin
  if not public.can_area(p_business, 'settings') then raise exception 'Only the owner or an admin can manage the team'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if p_role not in ('admin', 'staff') then raise exception 'Role must be admin or staff'; end if;
  select role into v_my from public.business_members where business_id = p_business and user_id = auth.uid();
  if p_role = 'admin' and coalesce(v_my, '') <> 'owner' and not public.is_staff() then raise exception 'Only the owner can add an admin'; end if;
  v_perms := case when p_role = 'admin' then '{}'::text[]
                  else array(select distinct x from unnest(coalesce(p_perms, '{}')) x where x = any(public.perm_areas())) end;
  if p_role = 'staff' and cardinality(v_perms) = 0 then raise exception 'Choose at least one thing this person can do'; end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    select role into v_cur from public.business_members where business_id = p_business and user_id = v_user;
    if v_cur = 'owner' then raise exception 'That''s the owner''s login'; end if;
    if v_cur = 'admin' and coalesce(v_my, '') <> 'owner' and not public.is_staff() then raise exception 'Only the owner can change an admin'; end if;
    insert into public.business_members (business_id, user_id, role, perms) values (p_business, v_user, p_role, v_perms)
      on conflict (business_id, user_id) do update set role = excluded.role, perms = excluded.perms;
    update public.profiles set role = 'business' where id = v_user and role = 'customer';
    delete from public.business_invites where business_id = p_business and email = v_email;
    return jsonb_build_object('status', 'added');
  end if;
  insert into public.business_invites (business_id, email, role, perms, invited_by) values (p_business, v_email, p_role, v_perms, auth.uid())
    on conflict (business_id, email) do update set role = excluded.role, perms = excluded.perms;
  return jsonb_build_object('status', 'invited');
end $$;

create or replace function public.team_remove(p_business uuid, p_user uuid default null, p_invite uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_my text; v_cur text;
begin
  if not public.can_area(p_business, 'settings') then raise exception 'Only the owner or an admin can manage the team'; end if;
  if p_invite is not null then delete from public.business_invites where id = p_invite and business_id = p_business; return; end if;
  select role into v_my from public.business_members where business_id = p_business and user_id = auth.uid();
  select role into v_cur from public.business_members where business_id = p_business and user_id = p_user;
  if v_cur = 'owner' then raise exception 'The owner can''t be removed'; end if;
  if v_cur = 'admin' and coalesce(v_my, '') <> 'owner' and not public.is_staff() then raise exception 'Only the owner can remove an admin'; end if;
  delete from public.business_members where business_id = p_business and user_id = p_user;
end $$;

-- Called after sign-in: turns invites for this email into team access
create or replace function public.claim_invites() returns int
language plpgsql security definer set search_path = public as $$
declare v_email text; n int := 0;
begin
  if auth.uid() is null then return 0; end if;
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then return 0; end if;
  insert into public.business_members (business_id, user_id, role, perms)
    select i.business_id, auth.uid(), i.role, i.perms from public.business_invites i where i.email = v_email
    on conflict (business_id, user_id) do nothing;
  get diagnostics n = row_count;
  delete from public.business_invites where email = v_email;
  if n > 0 then update public.profiles set role = 'business' where id = auth.uid() and role = 'customer'; end if;
  return n;
end $$;

revoke execute on function public.team_list(uuid), public.team_save(uuid, text, text, text[]), public.team_remove(uuid, uuid, uuid), public.claim_invites() from public, anon;
grant execute on function public.team_list(uuid), public.team_save(uuid, text, text, text[]), public.team_remove(uuid, uuid, uuid), public.claim_invites() to authenticated;

-- Card scan: find the customer by card token (needs the customers area)
create or replace function public.card_lookup(p_business uuid, p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.has_perm(p_business, 'customers') or public.is_staff() then
    (select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'stamps', c.stamps, 'visits', c.visits)
       from public.customers c where c.business_id = p_business and c.card_token = p_token) end
$$;
revoke execute on function public.card_lookup(uuid, text) from public, anon;
grant execute on function public.card_lookup(uuid, text) to authenticated;

/* =================== 4a. Accounts: tables =================== */
insert into public.modules (key, name, blurb, icon, core, addon_price, sort) values
  ('accounting', 'Accounts & GST reports', 'Income and expenses by category, profit & loss, balance sheet, GST summary and Tally export', '📒', false, 199, 75)
on conflict (key) do update set name = excluded.name, blurb = excluded.blurb, icon = excluded.icon;

update public.packages set modules = array_append(modules, 'accounting') where slug = 'pro' and not ('accounting' = any(modules));
update public.packages set features = array_replace(features, 'Up to 3 locations', 'Accounts: P&L, balance sheet, GST reports, Tally export')
  where slug = 'pro' and not ('Accounts: P&L, balance sheet, GST reports, Tally export' = any(features));
update public.packages set features = array_replace(features, 'Loyalty card and coupons', 'Digital loyalty card on the customer''s phone, scan to stamp')
  where slug = 'starter';
update public.packages set features = features || 'Team logins with set permissions'::text
  where slug = 'starter' and not ('Team logins with set permissions' = any(features));

create table if not exists public.acc_heads (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 80),
  kind        text not null check (kind in ('income', 'expense', 'asset', 'liability', 'equity')),
  class       text not null,
  system_key  text,                  -- cash, bank, debtors, creditors, staff_adv, salary, sales, capital, drawings, gst_*
  gst_rate    numeric(5,2) not null default 0 check (gst_rate between 0 and 40),
  active      boolean not null default true,
  sort        int not null default 100,
  created_at  timestamptz not null default now(),
  unique (business_id, name),
  check (
    (kind = 'income'    and class in ('sales', 'other_income')) or
    (kind = 'expense'   and class in ('purchase', 'direct', 'operating', 'finance', 'depreciation')) or
    (kind = 'asset'     and class in ('cash', 'bank', 'fixed', 'receivable', 'advance', 'deposit', 'stock', 'investment')) or
    (kind = 'liability' and class in ('loan', 'payable', 'tax', 'other_liability')) or
    (kind = 'equity'    and class in ('capital', 'drawings')))
);
create unique index if not exists acc_heads_sys on public.acc_heads (business_id, system_key) where system_key is not null;

create table if not exists public.acc_vouchers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  vdate       date not null,
  vtype       text not null check (vtype in ('sales', 'purchase', 'receipt', 'payment', 'journal', 'contra')),
  entry       text not null check (entry in ('income', 'expense', 'asset', 'loan_in', 'loan_out', 'capital_in', 'drawings', 'transfer', 'opening', 'salary', 'advance')),
  number      int not null,
  head_id     uuid references public.acc_heads(id),
  money_id    uuid references public.acc_heads(id),
  party       text not null default '',
  gstin       text not null default '',
  invoice_no  text not null default '',
  narration   text not null default '',
  taxable     numeric(14,2) not null default 0,
  gst_rate    numeric(5,2) not null default 0,
  gst         numeric(14,2) not null default 0,
  igst        boolean not null default false,
  total       numeric(14,2) not null,
  source      text not null default 'manual',
  source_ref  text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists acc_v_biz_date on public.acc_vouchers (business_id, vdate);
create unique index if not exists acc_v_source on public.acc_vouchers (business_id, source, source_ref) where source_ref is not null;

create table if not exists public.acc_lines (
  id          uuid primary key default gen_random_uuid(),
  voucher_id  uuid not null references public.acc_vouchers(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  vdate       date not null,
  head_id     uuid not null references public.acc_heads(id),
  dr          numeric(14,2) not null default 0 check (dr >= 0),
  cr          numeric(14,2) not null default 0 check (cr >= 0)
);
create index if not exists acc_l_biz on public.acc_lines (business_id, vdate);
create index if not exists acc_l_head on public.acc_lines (head_id);

alter table public.acc_heads enable row level security;
alter table public.acc_vouchers enable row level security;
alter table public.acc_lines enable row level security;
drop policy if exists acc_heads_read on public.acc_heads;
create policy acc_heads_read on public.acc_heads for select using (public.has_perm(business_id, 'accounts') or public.is_staff());
drop policy if exists acc_heads_write on public.acc_heads;
create policy acc_heads_write on public.acc_heads for update using (public.can_use(business_id, 'accounting')) with check (public.can_use(business_id, 'accounting'));
drop policy if exists acc_v_read on public.acc_vouchers;
create policy acc_v_read on public.acc_vouchers for select using (public.has_perm(business_id, 'accounts') or public.is_staff());
drop policy if exists acc_l_read on public.acc_lines;
create policy acc_l_read on public.acc_lines for select using (public.has_perm(business_id, 'accounts') or public.is_staff());
grant select, update on public.acc_heads to authenticated;
grant select on public.acc_vouchers, public.acc_lines to authenticated;
-- Vouchers and lines are only written by acc_post / acc_delete, so the books always balance.

/* =================== 4b. Accounts: setup and heads =================== */
create or replace function public.acc_setup_internal(b uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.acc_heads (business_id, name, kind, class, system_key, sort) values
    (b, 'Sales',                     'income',    'sales',        'sales',      10),
    (b, 'Service income',            'income',    'sales',        null,         11),
    (b, 'Other income',              'income',    'other_income', null,         12),
    (b, 'Purchases (stock & raw material)', 'expense', 'purchase', 'purchases', 20),
    (b, 'Packaging',                 'expense',   'direct',       null,         21),
    (b, 'Transport & delivery',      'expense',   'direct',       null,         22),
    (b, 'Rent',                      'expense',   'operating',    null,         30),
    (b, 'Salaries & wages',          'expense',   'operating',    'salary',     31),
    (b, 'Electricity & water',       'expense',   'operating',    null,         32),
    (b, 'Marketing & ads',           'expense',   'operating',    null,         33),
    (b, 'Repairs & maintenance',     'expense',   'operating',    null,         34),
    (b, 'Internet & phone',          'expense',   'operating',    null,         35),
    (b, 'Software & subscriptions',  'expense',   'operating',    null,         36),
    (b, 'Office & shop supplies',    'expense',   'operating',    null,         37),
    (b, 'Bank charges & interest',   'expense',   'finance',      null,         38),
    (b, 'Other expenses',            'expense',   'operating',    null,         39),
    (b, 'Cash',                      'asset',     'cash',         'cash',       50),
    (b, 'Bank account',              'asset',     'bank',         'bank',       51),
    (b, 'Customers who owe you',     'asset',     'receivable',   'debtors',    52),
    (b, 'Staff advances',            'asset',     'advance',      'staff_adv',  53),
    (b, 'Security deposits',         'asset',     'deposit',      null,         54),
    (b, 'Furniture & fittings',      'asset',     'fixed',        null,         55),
    (b, 'Equipment & machinery',     'asset',     'fixed',        null,         56),
    (b, 'Computers & phones',        'asset',     'fixed',        null,         57),
    (b, 'Suppliers you owe',         'liability', 'payable',      'creditors',  60),
    (b, 'Loans',                     'liability', 'loan',         null,         61),
    (b, 'Output CGST',               'liability', 'tax',          'gst_out_c',  62),
    (b, 'Output SGST',               'liability', 'tax',          'gst_out_s',  63),
    (b, 'Output IGST',               'liability', 'tax',          'gst_out_i',  64),
    (b, 'Input CGST',                'liability', 'tax',          'gst_in_c',   65),
    (b, 'Input SGST',                'liability', 'tax',          'gst_in_s',   66),
    (b, 'Input IGST',                'liability', 'tax',          'gst_in_i',   67),
    (b, 'Owner''s capital',          'equity',    'capital',      'capital',    70),
    (b, 'Owner''s drawings',         'equity',    'drawings',     'drawings',   71)
  on conflict do nothing
$$;
revoke execute on function public.acc_setup_internal(uuid) from public, anon, authenticated;

create or replace function public.acc_setup(p_business uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.has_perm(p_business, 'accounts') or public.is_staff()) then raise exception 'You don''t have access to accounts'; end if;
  perform public.acc_setup_internal(p_business);
end $$;

create or replace function public.acc_head_save(p_business uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_sys text;
begin
  if not public.can_use(p_business, 'accounting') then raise exception 'Accounts are locked for this account'; end if;
  if v_id is not null then
    select system_key into v_sys from public.acc_heads where id = v_id and business_id = p_business;
    if not found then raise exception 'Category not found'; end if;
    update public.acc_heads set name = trim(p->>'name'), gst_rate = coalesce((p->>'gst_rate')::numeric, gst_rate),
      active = coalesce((p->>'active')::boolean, active),
      kind = case when v_sys is null and not exists (select 1 from public.acc_lines where head_id = v_id) then coalesce(p->>'kind', kind) else kind end,
      class = case when v_sys is null and not exists (select 1 from public.acc_lines where head_id = v_id) then coalesce(p->>'class', class) else class end
      where id = v_id;
    return v_id;
  end if;
  insert into public.acc_heads (business_id, name, kind, class, gst_rate)
    values (p_business, trim(p->>'name'), p->>'kind', p->>'class', coalesce((p->>'gst_rate')::numeric, 0)) returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'A category with that name already exists';
end $$;

/* =================== 4c. Accounts: posting =================== */
create or replace function public.acc_sys(b uuid, k text) returns uuid
language sql stable security definer set search_path = public as $$ select id from public.acc_heads where business_id = b and system_key = k $$;
revoke execute on function public.acc_sys(uuid, text) from public, anon, authenticated;

-- Internal: writes a voucher and its balanced lines. Callers check permission.
create or replace function public.acc_post_internal(b uuid, p jsonb, p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid());
  e text := p->>'entry';
  d date := coalesce(nullif(p->>'date', '')::date, current_date);
  h public.acc_heads; mo public.acc_heads;
  amt numeric := round(coalesce((p->>'amount')::numeric, 0), 2);
  rate numeric := coalesce((p->>'gst_rate')::numeric, 0);
  ig boolean := coalesce((p->>'igst')::boolean, false);
  gst numeric := 0; half numeric; tot numeric; vt text; num int; old_num int; old_vt text;
  L jsonb := '[]';
begin
  if amt <= 0 then raise exception 'Enter an amount'; end if;
  if rate < 0 or rate > 40 then raise exception 'GST rate must be between 0 and 40%%'; end if;
  select * into h from public.acc_heads where id = nullif(p->>'head_id', '')::uuid and business_id = b;
  if not found then raise exception 'Choose a category'; end if;
  select * into mo from public.acc_heads where id = nullif(p->>'money_id', '')::uuid and business_id = b;
  if e <> 'opening' and mo.id is null then raise exception 'Choose how it was paid'; end if;
  if e <> 'opening' and mo.id = h.id then raise exception 'Choose two different accounts'; end if;
  if e in ('income', 'expense', 'asset', 'loan_in', 'loan_out', 'capital_in', 'drawings', 'advance', 'salary')
     and not (mo.class in ('cash', 'bank', 'receivable') or mo.class = 'payable') then raise exception 'Paid/received through must be Cash, Bank, or owed'; end if;
  if e in ('income', 'expense', 'asset') and rate > 0 then gst := round(amt * rate / 100, 2); end if;
  tot := amt + gst; half := round(gst / 2, 2);

  case e
    when 'income' then
      if h.kind <> 'income' then raise exception 'Choose an income category'; end if;
      vt := 'sales';
      L := jsonb_build_array(jsonb_build_object('h', mo.id, 'dr', tot), jsonb_build_object('h', h.id, 'cr', amt));
      if gst > 0 and ig then L := L || jsonb_build_array(jsonb_build_object('h', public.acc_sys(b, 'gst_out_i'), 'cr', gst));
      elsif gst > 0 then L := L || jsonb_build_array(jsonb_build_object('h', public.acc_sys(b, 'gst_out_c'), 'cr', half), jsonb_build_object('h', public.acc_sys(b, 'gst_out_s'), 'cr', gst - half)); end if;
    when 'expense', 'asset' then
      if e = 'expense' and h.kind <> 'expense' then raise exception 'Choose an expense category'; end if;
      if e = 'asset' and (h.kind <> 'asset' or h.class in ('cash', 'bank', 'receivable')) then raise exception 'Choose an asset category'; end if;
      vt := case when h.class = 'purchase' or gst > 0 then 'purchase' else 'payment' end;
      L := jsonb_build_array(jsonb_build_object('h', h.id, 'dr', amt), jsonb_build_object('h', mo.id, 'cr', tot));
      if gst > 0 and ig then L := L || jsonb_build_array(jsonb_build_object('h', public.acc_sys(b, 'gst_in_i'), 'dr', gst));
      elsif gst > 0 then L := L || jsonb_build_array(jsonb_build_object('h', public.acc_sys(b, 'gst_in_c'), 'dr', half), jsonb_build_object('h', public.acc_sys(b, 'gst_in_s'), 'dr', gst - half)); end if;
    when 'loan_in', 'capital_in' then
      if e = 'loan_in' and h.kind <> 'liability' then raise exception 'Choose a loan'; end if;
      if e = 'capital_in' and h.kind <> 'equity' then raise exception 'Choose a capital account'; end if;
      vt := 'receipt'; L := jsonb_build_array(jsonb_build_object('h', mo.id, 'dr', amt), jsonb_build_object('h', h.id, 'cr', amt));
    when 'loan_out', 'drawings', 'advance' then
      if e = 'loan_out' and h.kind <> 'liability' then raise exception 'Choose a loan'; end if;
      if e = 'drawings' and h.kind <> 'equity' then raise exception 'Choose drawings'; end if;
      if e = 'advance' and h.class <> 'advance' then raise exception 'Choose an advances account'; end if;
      vt := 'payment'; L := jsonb_build_array(jsonb_build_object('h', h.id, 'dr', amt), jsonb_build_object('h', mo.id, 'cr', amt));
    when 'transfer' then
      -- money moves from money_id to head_id (e.g. customer paid what they owed, paid a supplier, cash deposited to bank)
      vt := case when h.class in ('cash', 'bank') and mo.class in ('cash', 'bank') then 'contra' when h.class in ('cash', 'bank') then 'receipt'
                 when mo.class in ('cash', 'bank') then 'payment' else 'journal' end;
      L := jsonb_build_array(jsonb_build_object('h', h.id, 'dr', amt), jsonb_build_object('h', mo.id, 'cr', amt));
    when 'opening' then
      if h.kind in ('income', 'expense') then raise exception 'Opening balances are for money, assets, loans and capital'; end if;
      vt := 'journal';
      if h.kind = 'asset' then L := jsonb_build_array(jsonb_build_object('h', h.id, 'dr', amt), jsonb_build_object('h', public.acc_sys(b, 'capital'), 'cr', amt));
      else L := jsonb_build_array(jsonb_build_object('h', public.acc_sys(b, 'capital'), 'dr', amt), jsonb_build_object('h', h.id, 'cr', amt)); end if;
    when 'salary' then
      -- p.amount = salary paid; p.recovered = advance recovered from it
      vt := 'payment';
      L := jsonb_build_array(jsonb_build_object('h', h.id, 'dr', amt + coalesce((p->>'recovered')::numeric, 0)), jsonb_build_object('h', mo.id, 'cr', amt));
      if coalesce((p->>'recovered')::numeric, 0) > 0 then L := L || jsonb_build_array(jsonb_build_object('h', public.acc_sys(b, 'staff_adv'), 'cr', (p->>'recovered')::numeric)); end if;
      tot := amt;
    else raise exception 'Unknown entry type';
  end case;

  select number, vtype into old_num, old_vt from public.acc_vouchers where id = v_id and business_id = b;
  if old_num is not null then delete from public.acc_vouchers where id = v_id; end if;
  num := case when old_vt = vt then old_num else coalesce((select max(number) from public.acc_vouchers where business_id = b and vtype = vt), 0) + 1 end;

  insert into public.acc_vouchers (id, business_id, vdate, vtype, entry, number, head_id, money_id, party, gstin, invoice_no, narration, taxable, gst_rate, gst, igst, total, source, source_ref, created_by)
  values (v_id, b, d, vt, e, num, h.id, mo.id, left(coalesce(p->>'party', ''), 120), upper(left(coalesce(p->>'gstin', ''), 15)), left(coalesce(p->>'invoice_no', ''), 40),
          left(coalesce(p->>'narration', ''), 500), amt, case when gst > 0 then rate else 0 end, gst, ig and gst > 0, tot,
          coalesce(p->>'source', 'manual'), nullif(p->>'source_ref', ''), p_user);
  insert into public.acc_lines (voucher_id, business_id, vdate, head_id, dr, cr)
    select v_id, b, d, (x->>'h')::uuid, coalesce((x->>'dr')::numeric, 0), coalesce((x->>'cr')::numeric, 0) from jsonb_array_elements(L) x
    where coalesce((x->>'dr')::numeric, 0) + coalesce((x->>'cr')::numeric, 0) > 0;
  if (select sum(dr) - sum(cr) from public.acc_lines where voucher_id = v_id) <> 0 then raise exception 'Entry does not balance'; end if;
  return v_id;
end $$;
revoke execute on function public.acc_post_internal(uuid, jsonb, uuid) from public, anon, authenticated;

create or replace function public.acc_post(p_business uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_use(p_business, 'accounting') then raise exception 'Accounts are locked for this account'; end if;
  perform public.acc_setup_internal(p_business);
  if nullif(p->>'id', '') is not null and not exists (select 1 from public.acc_vouchers where id = (p->>'id')::uuid and business_id = p_business and source = 'manual') then
    raise exception 'This entry was added automatically. Change it where it came from.'; end if;
  return public.acc_post_internal(p_business, (p - 'source' - 'source_ref'), auth.uid());
end $$;

create or replace function public.acc_delete(p_business uuid, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_use(p_business, 'accounting') then raise exception 'Accounts are locked for this account'; end if;
  delete from public.acc_vouchers where id = p_id and business_id = p_business and source in ('manual', 'visits', 'salary');
end $$;

-- Balances per head: movement in the period and closing balance at p_to
create or replace function public.acc_balances(p_business uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_business, 'accounts') or public.is_staff()) then raise exception 'You don''t have access to accounts'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'kind', h.kind, 'class', h.class, 'system_key', h.system_key,
      'p_dr', coalesce(s.p_dr, 0), 'p_cr', coalesce(s.p_cr, 0), 'c_dr', coalesce(s.c_dr, 0), 'c_cr', coalesce(s.c_cr, 0),
      'o_dr', coalesce(s.o_dr, 0), 'o_cr', coalesce(s.o_cr, 0)) order by h.sort, h.name)
    from public.acc_heads h left join (
      select head_id, sum(dr) filter (where vdate between p_from and p_to) p_dr, sum(cr) filter (where vdate between p_from and p_to) p_cr,
             sum(dr) c_dr, sum(cr) c_cr, sum(dr) filter (where vdate < p_from) o_dr, sum(cr) filter (where vdate < p_from) o_cr
      from public.acc_lines where business_id = p_business and vdate <= p_to group by head_id) s on s.head_id = h.id
    where h.business_id = p_business), '[]');
end $$;

-- Bring in daily sales from logged visits (one sales entry per day; re-running updates it)
create or replace function public.acc_import_visits(p_business uuid, p_from date, p_to date, p_money uuid, p_gst_rate numeric, p_inclusive boolean) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_id uuid; amt numeric;
begin
  if not public.can_use(p_business, 'accounting') then raise exception 'Accounts are locked for this account'; end if;
  perform public.acc_setup_internal(p_business);
  for r in select (v.created_at at time zone 'Asia/Kolkata')::date d, sum(v.net) net, count(*) cnt from public.visits v
           where v.business_id = p_business and (v.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to group by 1 having sum(v.net) > 0 loop
    amt := case when p_inclusive and p_gst_rate > 0 then round(r.net / (1 + p_gst_rate / 100), 2) else r.net end;
    select id into v_id from public.acc_vouchers where business_id = p_business and source = 'visits' and source_ref = r.d::text;
    perform public.acc_post_internal(p_business, jsonb_build_object('id', v_id, 'entry', 'income', 'date', r.d, 'head_id', public.acc_sys(p_business, 'sales'),
      'money_id', p_money, 'amount', amt, 'gst_rate', p_gst_rate, 'narration', format('Sales from %s logged visits', r.cnt), 'source', 'visits', 'source_ref', r.d::text), auth.uid());
    n := n + 1;
  end loop;
  return n;
end $$;

-- Paid salary slips become salary payments (advance recoveries reduce the staff advance)
create or replace function public.acc_import_salary(p_business uuid, p_from date, p_to date, p_money uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_id uuid; rec numeric;
begin
  if not public.can_use(p_business, 'accounting') then raise exception 'Accounts are locked for this account'; end if;
  if not public.has_perm(p_business, 'attendance') and not public.is_staff() then raise exception 'You need access to salaries to bring them in'; end if;
  perform public.acc_setup_internal(p_business);
  for r in select s.id, s.net, coalesce(s.paid_on, (s.month + interval '1 month - 1 day')::date) d, st.name, s.month from public.salary_slips s join public.staff st on st.id = s.staff_id
           where s.business_id = p_business and s.paid and coalesce(s.paid_on, s.month) between p_from and p_to and s.net > 0 loop
    select coalesce(sum(a.amount), 0) into rec from public.salary_adjustments a
      where a.business_id = p_business and a.month = r.month and a.advance_id is not null
        and a.staff_id = (select staff_id from public.salary_slips where id = r.id);
    select id into v_id from public.acc_vouchers where business_id = p_business and source = 'salary' and source_ref = r.id::text;
    perform public.acc_post_internal(p_business, jsonb_build_object('id', v_id, 'entry', 'salary', 'date', r.d, 'head_id', public.acc_sys(p_business, 'salary'),
      'money_id', p_money, 'amount', r.net, 'recovered', rec, 'party', r.name, 'narration', 'Salary ' || to_char(r.month, 'Mon YYYY'),
      'source', 'salary', 'source_ref', r.id::text), auth.uid());
    n := n + 1;
  end loop;
  return n;
end $$;

/* =================== 3. Staff advances =================== */
create table if not exists public.staff_advances (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  staff_id     uuid not null references public.staff(id) on delete cascade,
  given_on     date not null default current_date,
  amount       numeric(12,2) not null check (amount > 0),
  monthly_cut  numeric(12,2) not null check (monthly_cut > 0),
  start_month  date not null check (extract(day from start_month) = 1),
  skip_months  date[] not null default '{}',
  paid_from    text not null default 'cash' check (paid_from in ('cash', 'bank')),
  note         text not null default '',
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create index if not exists sadv_biz on public.staff_advances (business_id, staff_id);
alter table public.staff_advances enable row level security;
drop policy if exists sadv_read on public.staff_advances;
create policy sadv_read on public.staff_advances for select using (public.has_perm(business_id, 'attendance') or public.is_staff());
grant select on public.staff_advances to authenticated;

alter table public.salary_adjustments add column if not exists advance_id uuid references public.staff_advances(id) on delete cascade;
create unique index if not exists sadj_adv_month on public.salary_adjustments (advance_id, month) where advance_id is not null;

create or replace function public.advance_give(p_business uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_staff uuid := (p->>'staff_id')::uuid; v_amt numeric := round((p->>'amount')::numeric, 2);
        v_cut numeric := round(coalesce((p->>'monthly_cut')::numeric, (p->>'amount')::numeric), 2);
        v_given date := coalesce(nullif(p->>'given_on', '')::date, current_date);
        v_start date := coalesce(nullif(p->>'start_month', '')::date, date_trunc('month', v_given)::date);
        v_from text := coalesce(p->>'paid_from', 'cash');
begin
  if not public.can_use(p_business, 'attendance') then raise exception 'Attendance is locked for this account'; end if;
  if not exists (select 1 from public.staff where id = v_staff and business_id = p_business) then raise exception 'Staff member not found'; end if;
  if not (v_amt > 0) then raise exception 'Enter the advance amount'; end if;
  if not (v_cut > 0) then raise exception 'Enter how much to cut each month'; end if;
  insert into public.staff_advances (business_id, staff_id, given_on, amount, monthly_cut, start_month, paid_from, note, created_by)
    values (p_business, v_staff, v_given, v_amt, least(v_cut, v_amt), date_trunc('month', v_start)::date, v_from, left(coalesce(p->>'note', ''), 200), auth.uid())
    returning id into v_id;
  -- Record it in the accounts when the business uses them
  if public.has_module(p_business, 'accounting') then
    perform public.acc_setup_internal(p_business);
    perform public.acc_post_internal(p_business, jsonb_build_object('entry', 'advance', 'date', v_given, 'head_id', public.acc_sys(p_business, 'staff_adv'),
      'money_id', public.acc_sys(p_business, v_from), 'amount', v_amt, 'party', (select name from public.staff where id = v_staff),
      'narration', 'Salary advance' || coalesce(nullif(': ' || (p->>'note'), ': '), ''), 'source', 'advance', 'source_ref', v_id::text), auth.uid());
  end if;
  return v_id;
end $$;

create or replace function public.advance_delete(p_business uuid, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_use(p_business, 'attendance') then raise exception 'Attendance is locked for this account'; end if;
  if exists (select 1 from public.salary_adjustments a join public.salary_slips s on s.staff_id = a.staff_id and s.month = a.month and s.paid
             where a.advance_id = p_id) then raise exception 'Part of this advance was already cut from a paid salary. Remove those cuts first.'; end if;
  delete from public.acc_vouchers where business_id = p_business and source = 'advance' and source_ref = p_id::text;
  delete from public.staff_advances where id = p_id and business_id = p_business;
end $$;

-- Skip (or bring back) the cut for one month
create or replace function public.advance_skip(p_business uuid, p_id uuid, p_month date, p_skip boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_use(p_business, 'attendance') then raise exception 'Attendance is locked for this account'; end if;
  if p_skip then
    update public.staff_advances set skip_months = array_append(array_remove(skip_months, p_month), p_month) where id = p_id and business_id = p_business;
    delete from public.salary_adjustments where advance_id = p_id and month = p_month;
  else
    update public.staff_advances set skip_months = array_remove(skip_months, p_month) where id = p_id and business_id = p_business;
  end if;
end $$;

-- Adds this month's cut for every open advance (once per month). Called when the salary page opens.
create or replace function public.advance_sync(p_business uuid, p_month date) returns int
language plpgsql security definer set search_path = public as $$
declare a record; bal numeric; n int := 0; m date := date_trunc('month', p_month)::date;
begin
  if not public.can_use(p_business, 'attendance') then return 0; end if;
  if m > date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date then return 0; end if;
  for a in select * from public.staff_advances where business_id = p_business and start_month <= m and not (m = any(skip_months)) loop
    if exists (select 1 from public.salary_adjustments where advance_id = a.id and month = m) then continue; end if;
    if exists (select 1 from public.salary_slips where staff_id = a.staff_id and month = m and paid) then continue; end if;
    select a.amount - coalesce(sum(amount), 0) into bal from public.salary_adjustments where advance_id = a.id;
    if bal <= 0 then continue; end if;
    insert into public.salary_adjustments (business_id, staff_id, month, kind, amount, note, advance_id)
      values (p_business, a.staff_id, m, 'advance', least(a.monthly_cut, bal), 'Advance recovery (given ' || to_char(a.given_on, 'DD Mon') || ')', a.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Advances with what's been recovered so far
create or replace function public.advance_list(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_business, 'attendance') or public.is_staff()) then raise exception 'You don''t have access to salaries'; end if;
  return coalesce((select jsonb_agg(to_jsonb(a) || jsonb_build_object('staff_name', s.name,
      'recovered', coalesce((select sum(x.amount) from public.salary_adjustments x where x.advance_id = a.id), 0),
      'recovered_paid', coalesce((select sum(x.amount) from public.salary_adjustments x join public.salary_slips sl on sl.staff_id = x.staff_id and sl.month = x.month and sl.paid where x.advance_id = a.id), 0))
      order by a.given_on desc, a.created_at desc)
    from public.staff_advances a join public.staff s on s.id = a.staff_id where a.business_id = p_business), '[]');
end $$;

revoke execute on function public.acc_setup(uuid), public.acc_head_save(uuid, jsonb), public.acc_post(uuid, jsonb), public.acc_delete(uuid, uuid),
  public.acc_balances(uuid, date, date), public.acc_import_visits(uuid, date, date, uuid, numeric, boolean), public.acc_import_salary(uuid, date, date, uuid),
  public.advance_give(uuid, jsonb), public.advance_delete(uuid, uuid), public.advance_skip(uuid, uuid, date, boolean), public.advance_sync(uuid, date), public.advance_list(uuid)
  from public, anon;
grant execute on function public.acc_setup(uuid), public.acc_head_save(uuid, jsonb), public.acc_post(uuid, jsonb), public.acc_delete(uuid, uuid),
  public.acc_balances(uuid, date, date), public.acc_import_visits(uuid, date, date, uuid, numeric, boolean), public.acc_import_salary(uuid, date, date, uuid),
  public.advance_give(uuid, jsonb), public.advance_delete(uuid, uuid), public.advance_skip(uuid, uuid, date, boolean), public.advance_sync(uuid, date), public.advance_list(uuid)
  to authenticated;
