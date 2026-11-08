-- =====================================================================
-- Branditude Growth Plan: platform schema (Supabase / Postgres 15+)
-- Roles: super_admin + team (agency staff), business (owner/staff), customer
-- Every table has Row Level Security. Money-moving and cross-table work
-- happens only inside SECURITY DEFINER functions (RPCs) below.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('super_admin','team','business','customer');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.norm_phone(p text, cc text default '91')
returns text language sql immutable as $$
  select case
    when d = '' then ''
    when length(d) = 10 then coalesce(nullif(regexp_replace(cc,'\D','','g'),''),'91') || d
    when length(d) = 11 and left(d,1) = '0' then coalesce(nullif(regexp_replace(cc,'\D','','g'),''),'91') || substr(d,2)
    when left(d,2) = '00' then substr(d,3)
    else d end
  from (select regexp_replace(coalesce(p,''),'\D','','g') as d) x
$$;

-- ---------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        public.app_role not null default 'customer',
  full_name   text,
  email       text,
  phone       text,
  created_at  timestamptz not null default now()
);

create or replace function public.my_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('super_admin','team') from public.profiles where id = auth.uid()), false)
$$;
create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'super_admin' from public.profiles where id = auth.uid()), false)
$$;
-- Verified phone of the signed-in user (from phone OTP), digits only
create or replace function public.my_phone() returns text
language sql stable security definer set search_path = public, auth as $$
  select nullif(regexp_replace(coalesce((select phone from auth.users where id = auth.uid()),''),'\D','','g'),'')
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, full_name, email, phone)
  values (new.id, 'customer',
          coalesce(new.raw_user_meta_data->>'full_name', ''),
          new.email,
          nullif(regexp_replace(coalesce(new.phone,''),'\D','','g'),''))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Agency catalogue: categories, products, packages, promo codes, settings
-- ---------------------------------------------------------------------
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  slug       text not null unique,
  icon       text default '🏪',
  active     boolean not null default true,
  sort       int not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists public.products (            -- category-specific services, e.g. Zomato optimisation for cafés
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text default '',
  price       numeric(10,2) not null check (price >= 0),
  billing     text not null default 'one_time' check (billing in ('one_time','monthly')),
  active      boolean not null default true,
  sort        int not null default 100,
  created_at  timestamptz not null default now()
);
create table if not exists public.product_categories (  -- no rows = available to every category
  product_id  uuid references public.products(id) on delete cascade,
  category_id uuid references public.categories(id) on delete cascade,
  primary key (product_id, category_id)
);

create table if not exists public.packages (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  tagline          text default '',
  monthly_price    numeric(10,2) not null check (monthly_price >= 0),
  yearly_price     numeric(10,2) not null check (yearly_price >= 0),
  discount_percent numeric(5,2) not null default 0 check (discount_percent between 0 and 90),
  discount_label   text default '',
  features         text[] not null default '{}',
  max_locations    int not null default 1,
  includes_whatsapp boolean not null default false,
  is_popular       boolean not null default false,
  active           boolean not null default true,
  sort             int not null default 100,
  created_at       timestamptz not null default now()
);

create table if not exists public.promo_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  type        text not null check (type in ('percent','flat')),
  value       numeric(10,2) not null check (value > 0),
  package_ids uuid[],                                       -- null = all packages
  valid_until date,
  max_uses    int,
  used        int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.settings (               -- public = readable on the store
  key        text primary key,
  value      jsonb not null,
  public     boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Businesses, members, leads, payments
-- ---------------------------------------------------------------------
create table if not exists public.businesses (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  name                text not null,
  category_id         uuid references public.categories(id),
  owner_id            uuid references auth.users(id),
  phone               text,
  email               text,
  city                text,
  address             text,
  country_code        text not null default '91',
  google_review_link  text default '',
  review_template     text not null default 'Hi {name}, thank you for visiting {business}! Loved it? A quick Google review would mean a lot: {review_link}. Something not right? Just reply here and the owner will put it right.',
  package_id          uuid references public.packages(id),
  billing             text not null default 'monthly' check (billing in ('monthly','yearly')),
  status              text not null default 'pending_payment' check (status in ('pending_payment','active','paused','cancelled')),
  subscription_ends   date,
  wa_enabled          boolean not null default false,
  wa_phone_number_id  text,                                -- per-business WhatsApp number (optional)
  created_at          timestamptz not null default now()
);

create table if not exists public.business_members (
  business_id uuid references public.businesses(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner','staff')),
  primary key (business_id, user_id)
);

create or replace function public.is_member(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.business_members where business_id = b and user_id = auth.uid())
$$;
create or replace function public.can_write(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or (
    public.is_member(b) and exists (select 1 from public.businesses where id = b and status in ('pending_payment','active')))
$$;

create table if not exists public.leads (
  id             uuid primary key default gen_random_uuid(),
  ref            text not null unique default ('BGP-' || to_char(now(),'YYMMDD') || '-' || upper(substr(md5(random()::text),1,4))),
  source         text not null default 'store' check (source in ('store','enquiry','registration','manual')),
  business_name  text not null,
  contact_name   text,
  phone          text not null,
  email          text,
  city           text,
  category_id    uuid references public.categories(id),
  package_id     uuid references public.packages(id),
  billing        text default 'monthly',
  product_ids    uuid[] not null default '{}',
  promo_code     text,
  amount         numeric(10,2) not null default 0,   -- before GST
  gst            numeric(10,2) not null default 0,
  total          numeric(10,2) not null default 0,
  message        text,
  status         text not null default 'new' check (status in ('new','contacted','payment_pending','won','lost')),
  notes          text default '',
  assigned_to    uuid references auth.users(id),
  business_id    uuid references public.businesses(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references public.businesses(id) on delete cascade,
  lead_id      uuid references public.leads(id) on delete set null,
  kind         text not null check (kind in ('subscription','wa_credits','product')),
  description  text not null,
  amount       numeric(10,2) not null,      -- before GST
  gst          numeric(10,2) not null,
  total        numeric(10,2) not null,
  meta         jsonb not null default '{}', -- package_id/billing, pack credits, product_id
  utr          text,
  status       text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Business data
-- ---------------------------------------------------------------------
create table if not exists public.customers (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses(id) on delete cascade,
  name                text not null,
  phone               text not null,           -- normalised digits incl. country code
  email               text,
  birthday            date,
  tags                text[] not null default '{}',
  notes               text default '',
  visits              int not null default 0,
  spend               numeric(12,2) not null default 0,
  last_visit          timestamptz,
  review_status       text not null default 'none' check (review_status in ('none','requested','reviewed')),
  review_requested_at timestamptz,
  stamps              int not null default 0,
  cards_completed     int not null default 0,
  created_at          timestamptz not null default now(),
  unique (business_id, phone)
);
create index if not exists customers_phone_idx on public.customers(phone);

create table if not exists public.coupons (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  code               text not null,
  title              text default '',
  type               text not null check (type in ('percent','flat')),
  value              numeric(10,2) not null check (value > 0),
  max_discount       numeric(10,2) not null default 0,
  min_bill           numeric(10,2) not null default 0,
  expiry             date,
  usage_limit        int not null default 0,
  used               int not null default 0,
  active             boolean not null default true,
  show_to_customers  boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (business_id, code)
);

create table if not exists public.loyalty_programs (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  enabled     boolean not null default true,
  name        text not null default 'Loyalty card',
  stamps      int not null default 10 check (stamps between 2 and 20),
  theme       text not null default 'saffron'
);
create table if not exists public.loyalty_rewards (
  business_id  uuid not null references public.businesses(id) on delete cascade,
  visit_no     int not null check (visit_no between 1 and 20),
  type         text not null check (type in ('percent','flat','free')),
  value        numeric(10,2) not null default 0,
  max_discount numeric(10,2) not null default 0,
  note         text default '',
  primary key (business_id, visit_no)
);

create table if not exists public.visits (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  customer_id     uuid references public.customers(id) on delete set null,
  gross           numeric(12,2) not null,
  discount        numeric(12,2) not null default 0,
  net             numeric(12,2) not null,
  coupon_code     text,
  loyalty_visit   int not null default 0,
  loyalty_reward  text,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now()
);
create index if not exists visits_business_idx on public.visits(business_id, created_at desc);

create table if not exists public.feedback (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  customer_id   uuid references public.customers(id) on delete set null,
  rating        int not null check (rating between 1 and 5),
  tags          text[] not null default '{}',
  text          text default '',
  name          text default '',
  phone         text default '',
  source        text not null default 'counter' check (source in ('counter','link','customer_app')),
  status        text not null default 'open' check (status in ('happy','open','resolved')),
  opened_google boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists public.reminders (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  text        text not null,
  due         date,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- WhatsApp (optional add-on, prepaid credits per message)
-- ---------------------------------------------------------------------
create table if not exists public.wa_credit_packs (
  id       uuid primary key default gen_random_uuid(),
  name     text not null,
  credits  int not null check (credits > 0),
  price    numeric(10,2) not null check (price >= 0),
  active   boolean not null default true,
  sort     int not null default 100
);
create table if not exists public.wa_templates (           -- must match templates approved in Meta WhatsApp Manager
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,                 -- Meta template name
  language            text not null default 'en',
  category            text not null default 'marketing' check (category in ('marketing','utility')),
  title               text not null,
  body_preview        text not null,                        -- with {{1}} {{2}} …
  params              text[] not null default '{}',         -- labels for {{2}}… ({{1}} is always customer first name)
  credits_per_message int not null default 1 check (credits_per_message > 0),
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
create table if not exists public.wa_wallets (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  balance     int not null default 0 check (balance >= 0),
  updated_at  timestamptz not null default now()
);
create table if not exists public.wa_ledger (
  id          bigserial primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  delta       int not null,
  reason      text not null,
  ref         text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create table if not exists public.broadcasts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  template_id  uuid references public.wa_templates(id),
  title        text not null,
  audience     text not null,
  params       jsonb not null default '[]',
  recipients   int not null default 0,
  sent         int not null default 0,
  failed       int not null default 0,
  credits_used int not null default 0,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create table if not exists public.wa_messages (
  id            bigserial primary key,
  business_id   uuid not null references public.businesses(id) on delete cascade,
  broadcast_id  uuid references public.broadcasts(id) on delete set null,
  customer_id   uuid references public.customers(id) on delete set null,
  phone         text not null,
  template_name text not null,
  status        text not null check (status in ('sent','failed')),
  error         text,
  wa_message_id text,
  credits       int not null default 0,
  created_at    timestamptz not null default now()
);

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles           enable row level security;
alter table public.categories         enable row level security;
alter table public.products           enable row level security;
alter table public.product_categories enable row level security;
alter table public.packages           enable row level security;
alter table public.promo_codes        enable row level security;
alter table public.settings           enable row level security;
alter table public.businesses         enable row level security;
alter table public.business_members   enable row level security;
alter table public.leads              enable row level security;
alter table public.payments           enable row level security;
alter table public.customers          enable row level security;
alter table public.coupons            enable row level security;
alter table public.loyalty_programs   enable row level security;
alter table public.loyalty_rewards    enable row level security;
alter table public.visits             enable row level security;
alter table public.feedback           enable row level security;
alter table public.reminders          enable row level security;
alter table public.wa_credit_packs    enable row level security;
alter table public.wa_templates       enable row level security;
alter table public.wa_wallets         enable row level security;
alter table public.wa_ledger          enable row level security;
alter table public.broadcasts         enable row level security;
alter table public.wa_messages        enable row level security;

-- profiles: own row, staff see all; only full_name is self-editable
create policy profiles_select on public.profiles for select using (id = auth.uid() or public.is_staff());
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
revoke update on public.profiles from authenticated, anon;
grant update (full_name) on public.profiles to authenticated;

-- public catalogue: everyone reads active rows, staff manage
create policy cat_read  on public.categories for select using (active or public.is_staff());
create policy cat_write on public.categories for all using (public.is_staff()) with check (public.is_staff());
create policy prod_read  on public.products for select using (active or public.is_staff());
create policy prod_write on public.products for all using (public.is_staff()) with check (public.is_staff());
create policy pc_read  on public.product_categories for select using (true);
create policy pc_write on public.product_categories for all using (public.is_staff()) with check (public.is_staff());
create policy pkg_read  on public.packages for select using (active or public.is_staff());
create policy pkg_write on public.packages for all using (public.is_staff()) with check (public.is_staff());
create policy promo_all on public.promo_codes for all using (public.is_staff()) with check (public.is_staff());
create policy set_read  on public.settings for select using (public or public.is_staff());
create policy set_write on public.settings for all using (public.is_super_admin()) with check (public.is_super_admin());
create policy pack_read  on public.wa_credit_packs for select using (active or public.is_staff());
create policy pack_write on public.wa_credit_packs for all using (public.is_staff()) with check (public.is_staff());
create policy tpl_read  on public.wa_templates for select using ((active and auth.uid() is not null) or public.is_staff());
create policy tpl_write on public.wa_templates for all using (public.is_staff()) with check (public.is_staff());

-- businesses: members read; members edit their own profile columns; staff via RPC
create policy biz_read   on public.businesses for select using (public.is_member(id) or public.is_staff());
create policy biz_update on public.businesses for update using (public.can_write(id)) with check (public.can_write(id));
revoke update on public.businesses from authenticated, anon;
grant update (name, phone, email, city, address, country_code, google_review_link, review_template) on public.businesses to authenticated;
create policy bm_read on public.business_members for select using (user_id = auth.uid() or public.is_member(business_id) or public.is_staff());

-- leads & payments
create policy leads_staff on public.leads for all using (public.is_staff()) with check (public.is_staff());
create policy pay_read  on public.payments for select using (public.is_member(business_id) or public.is_staff());
create policy pay_staff on public.payments for update using (public.is_staff()) with check (public.is_staff());

-- business-owned data: members (while active/pending) read+write, staff read+write
create policy cust_rw on public.customers for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id));
create policy cust_self on public.customers for select using (phone = public.my_phone());
create policy coup_rw on public.coupons for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id));
create policy coup_cust on public.coupons for select using (show_to_customers and active and exists (select 1 from public.customers c where c.business_id = coupons.business_id and c.phone = public.my_phone()));
create policy lp_rw on public.loyalty_programs for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id));
create policy lp_cust on public.loyalty_programs for select using (exists (select 1 from public.customers c where c.business_id = loyalty_programs.business_id and c.phone = public.my_phone()));
create policy lr_rw on public.loyalty_rewards for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id));
create policy lr_cust on public.loyalty_rewards for select using (exists (select 1 from public.customers c where c.business_id = loyalty_rewards.business_id and c.phone = public.my_phone()));
create policy visits_read on public.visits for select using (public.is_member(business_id) or public.is_staff());
create policy visits_cust on public.visits for select using (exists (select 1 from public.customers c where c.id = visits.customer_id and c.phone = public.my_phone()));
create policy visits_del on public.visits for delete using (public.can_write(business_id));
create policy fb_rw on public.feedback for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id));
create policy rem_rw on public.reminders for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id));
create policy wal_read on public.wa_wallets for select using (public.is_member(business_id) or public.is_staff());
create policy led_read on public.wa_ledger for select using (public.is_member(business_id) or public.is_staff());
create policy bc_read on public.broadcasts for select using (public.is_member(business_id) or public.is_staff());
create policy msg_read on public.wa_messages for select using (public.is_member(business_id) or public.is_staff());

-- businesses can see customer-facing name/category of businesses where they are a customer
create or replace view public.my_businesses with (security_invoker = false) as
  select b.id, b.name, b.slug, b.city, b.phone, b.google_review_link, cat.name as category, cat.icon
  from public.businesses b
  left join public.categories cat on cat.id = b.category_id
  where exists (select 1 from public.customers c where c.business_id = b.id and c.phone = public.my_phone());
grant select on public.my_businesses to authenticated;

-- =====================================================================
-- Pricing helpers
-- =====================================================================
create or replace function public.gst_rate() returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select (value->>'rate')::numeric from public.settings where key = 'gst'), 0.18)
$$;

create or replace function public.package_price(p_package uuid, p_billing text) returns numeric
language sql stable security definer set search_path = public as $$
  select round((case when p_billing = 'yearly' then yearly_price else monthly_price end) * (1 - discount_percent/100.0), 2)
  from public.packages where id = p_package and active
$$;

-- Quote = package (after package discount) + products, minus promo code, plus GST
create or replace function public.quote(p_package uuid, p_billing text, p_products uuid[], p_promo text, p_category uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_pkg numeric := 0; v_prod numeric := 0; v_promo numeric := 0; v_sub numeric; v_gst numeric; r record; pc record;
  v_lines jsonb := '[]'; v_msg text := null;
begin
  if p_billing not in ('monthly','yearly') then p_billing := 'monthly'; end if;
  if p_package is not null then
    select * into r from public.packages where id = p_package and active;
    if not found then raise exception 'Package not available'; end if;
    v_pkg := public.package_price(p_package, p_billing);
    v_lines := v_lines || jsonb_build_object('label', r.name || ' plan (' || case when p_billing='yearly' then '1 year' else '1 month' end || ')', 'amount', v_pkg);
  end if;
  for r in select p.* from public.products p where p.id = any(coalesce(p_products,'{}')) and p.active
           and (p_category is null or not exists (select 1 from public.product_categories x where x.product_id = p.id)
                or exists (select 1 from public.product_categories x where x.product_id = p.id and x.category_id = p_category)) loop
    v_prod := v_prod + r.price;
    v_lines := v_lines || jsonb_build_object('label', r.name || case when r.billing='monthly' then ' (1 month)' else '' end, 'amount', r.price);
  end loop;
  if coalesce(trim(p_promo),'') <> '' then
    select * into pc from public.promo_codes where upper(code) = upper(trim(p_promo));
    if not found or not pc.active then v_msg := 'Promo code not valid';
    elsif pc.valid_until is not null and pc.valid_until < current_date then v_msg := 'Promo code has expired';
    elsif pc.max_uses is not null and pc.used >= pc.max_uses then v_msg := 'Promo code has been fully used';
    elsif pc.package_ids is not null and (p_package is null or not p_package = any(pc.package_ids)) then v_msg := 'Promo code does not apply to this plan';
    else
      v_promo := case when pc.type = 'percent' then round(v_pkg * pc.value / 100.0, 2) else least(pc.value, v_pkg) end;
      v_lines := v_lines || jsonb_build_object('label', 'Promo ' || upper(pc.code), 'amount', -v_promo);
      v_msg := 'Promo applied';
    end if;
  end if;
  v_sub := greatest(v_pkg + v_prod - v_promo, 0);
  v_gst := round(v_sub * public.gst_rate(), 2);
  return jsonb_build_object('lines', v_lines, 'subtotal', v_sub, 'gst', v_gst, 'total', v_sub + v_gst,
                            'promo_ok', v_promo > 0, 'promo_message', v_msg);
end $$;

-- =====================================================================
-- Public RPCs (store)
-- =====================================================================
-- Enquiry / order from the public store. Server computes the price.
create or replace function public.submit_lead(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_q jsonb; v_id uuid; v_ref text; v_products uuid[];
begin
  if coalesce(trim(p->>'business_name'),'') = '' then raise exception 'Business name is required'; end if;
  if length(regexp_replace(coalesce(p->>'phone',''),'\D','','g')) < 10 then raise exception 'A valid phone number is required'; end if;
  select coalesce(array_agg(x::uuid), '{}') into v_products from jsonb_array_elements_text(coalesce(p->'product_ids','[]')) x;
  v_q := public.quote(nullif(p->>'package_id','')::uuid, coalesce(p->>'billing','monthly'), v_products, p->>'promo_code', nullif(p->>'category_id','')::uuid);
  insert into public.leads (source, business_name, contact_name, phone, email, city, category_id, package_id, billing,
                            product_ids, promo_code, amount, gst, total, message, status)
  values (coalesce(nullif(p->>'source',''),'store'), trim(p->>'business_name'), p->>'contact_name', public.norm_phone(p->>'phone'),
          nullif(p->>'email',''), p->>'city', nullif(p->>'category_id','')::uuid, nullif(p->>'package_id','')::uuid,
          coalesce(p->>'billing','monthly'), v_products, case when (v_q->>'promo_ok')::boolean then upper(p->>'promo_code') end,
          (v_q->>'subtotal')::numeric, (v_q->>'gst')::numeric, (v_q->>'total')::numeric, p->>'message', 'new')
  returning id, ref into v_id, v_ref;
  return v_q || jsonb_build_object('lead_id', v_id, 'ref', v_ref);
end $$;

-- Public feedback link: /f.html?b=<slug>
create or replace function public.public_business(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'name', b.name, 'google_review_link', b.google_review_link, 'city', b.city)
  from public.businesses b where b.slug = p_slug and b.status in ('active','pending_payment')
$$;

create or replace function public.submit_feedback(p_slug text, p_rating int, p_tags text[], p_text text, p_name text, p_phone text, p_opened_google boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b record; v_phone text; v_cust uuid; v_recent int;
begin
  select * into b from public.businesses where slug = p_slug and status in ('active','pending_payment');
  if not found then raise exception 'Business not found'; end if;
  if p_rating not between 1 and 5 then raise exception 'Rating must be 1 to 5'; end if;
  v_phone := coalesce(public.my_phone(), nullif(public.norm_phone(p_phone, b.country_code),''));
  -- light abuse guard: max 5 submissions per phone per business per day
  if v_phone is not null then
    select count(*) into v_recent from public.feedback where business_id = b.id and phone = v_phone and created_at > now() - interval '1 day';
    if v_recent >= 5 then raise exception 'Thanks, we already have your feedback for today'; end if;
    select id into v_cust from public.customers where business_id = b.id and phone = v_phone;
  end if;
  insert into public.feedback (business_id, customer_id, rating, tags, text, name, phone, source, status, opened_google)
  values (b.id, v_cust, p_rating, coalesce(p_tags,'{}'), left(coalesce(p_text,''), 2000), left(coalesce(p_name,''),120), coalesce(v_phone,''),
          case when auth.uid() is null then 'link' else 'customer_app' end,
          case when p_rating >= 4 then 'happy' else 'open' end, coalesce(p_opened_google,false));
  return jsonb_build_object('ok', true, 'google_review_link', b.google_review_link);
end $$;

-- =====================================================================
-- Business registration & billing
-- =====================================================================
create or replace function public.slugify(t text) returns text language sql immutable as $$
  select trim(both '-' from regexp_replace(lower(coalesce(t,'')), '[^a-z0-9]+', '-', 'g'))
$$;

create or replace function public.register_business(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_b uuid; v_slug text; v_q jsonb; v_lead uuid; v_pay uuid; v_products uuid[]; v_pkg uuid; v_billing text;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if coalesce(trim(p->>'name'),'') = '' then raise exception 'Business name is required'; end if;
  if (select role from public.profiles where id = v_uid) in ('super_admin','team') then raise exception 'Agency accounts cannot register a business'; end if;
  v_pkg := nullif(p->>'package_id','')::uuid;
  if v_pkg is null then raise exception 'Choose a plan'; end if;
  v_billing := coalesce(nullif(p->>'billing',''),'monthly');
  select coalesce(array_agg(x::uuid), '{}') into v_products from jsonb_array_elements_text(coalesce(p->'product_ids','[]')) x;
  v_q := public.quote(v_pkg, v_billing, v_products, p->>'promo_code', nullif(p->>'category_id','')::uuid);

  v_slug := public.slugify(p->>'name') || '-' || substr(md5(random()::text),1,4);
  insert into public.businesses (slug, name, category_id, owner_id, phone, email, city, address, package_id, billing, status)
  values (v_slug, trim(p->>'name'), nullif(p->>'category_id','')::uuid, v_uid, public.norm_phone(p->>'phone'),
          nullif(p->>'email',''), p->>'city', p->>'address', v_pkg, v_billing, 'pending_payment')
  returning id into v_b;
  insert into public.business_members (business_id, user_id, role) values (v_b, v_uid, 'owner');
  insert into public.wa_wallets (business_id, balance) values (v_b, 0);
  insert into public.loyalty_programs (business_id) values (v_b);
  insert into public.loyalty_rewards (business_id, visit_no, type, value, note) values
    (v_b, 1, 'percent', 10, 'Welcome offer: 10% off'), (v_b, 5, 'percent', 15, ''), (v_b, 10, 'free', 300, 'Free item worth up to ₹300');
  update public.profiles set role = 'business', full_name = coalesce(nullif(p->>'contact_name',''), full_name),
         phone = coalesce(phone, public.norm_phone(p->>'phone')) where id = v_uid and role = 'customer';

  insert into public.leads (source, business_name, contact_name, phone, email, city, category_id, package_id, billing, product_ids,
                            promo_code, amount, gst, total, status, business_id)
  values ('registration', trim(p->>'name'), p->>'contact_name', public.norm_phone(p->>'phone'), nullif(p->>'email',''), p->>'city',
          nullif(p->>'category_id','')::uuid, v_pkg, v_billing, v_products,
          case when (v_q->>'promo_ok')::boolean then upper(p->>'promo_code') end,
          (v_q->>'subtotal')::numeric, (v_q->>'gst')::numeric, (v_q->>'total')::numeric, 'payment_pending', v_b)
  returning id into v_lead;
  insert into public.payments (business_id, lead_id, kind, description, amount, gst, total, meta)
  values (v_b, v_lead, 'subscription', 'Plan sign-up', (v_q->>'subtotal')::numeric, (v_q->>'gst')::numeric, (v_q->>'total')::numeric,
          jsonb_build_object('package_id', v_pkg, 'billing', v_billing, 'product_ids', to_jsonb(v_products),
                             'promo_code', case when (v_q->>'promo_ok')::boolean then upper(p->>'promo_code') end))
  returning id into v_pay;
  return v_q || jsonb_build_object('business_id', v_b, 'payment_id', v_pay, 'lead_id', v_lead, 'slug', v_slug);
end $$;

create or replace function public.submit_utr(p_payment uuid, p_utr text) returns void
language plpgsql security definer set search_path = public as $$
declare v_b uuid;
begin
  select business_id into v_b from public.payments where id = p_payment and status = 'pending';
  if v_b is null or not public.is_member(v_b) then raise exception 'Payment not found'; end if;
  if coalesce(p_utr,'') !~ '^[A-Za-z0-9]{8,22}$' then raise exception 'Enter the 12-digit UPI transaction ID'; end if;
  update public.payments set utr = p_utr where id = p_payment;
end $$;

-- Business buys a WhatsApp credit pack, a category product, or renews/changes plan → pending payment
create or replace function public.create_order(p_business uuid, p_kind text, p_ref uuid, p_billing text default 'monthly') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_amount numeric; v_desc text; v_meta jsonb; v_gst numeric; v_id uuid; r record; v_cat uuid;
begin
  if not public.is_member(p_business) then raise exception 'Not allowed'; end if;
  select category_id into v_cat from public.businesses where id = p_business;
  if p_kind = 'wa_credits' then
    select * into r from public.wa_credit_packs where id = p_ref and active; if not found then raise exception 'Pack not available'; end if;
    v_amount := r.price; v_desc := 'WhatsApp credits: ' || r.name || ' (' || r.credits || ' messages)'; v_meta := jsonb_build_object('pack_id', r.id, 'credits', r.credits);
  elsif p_kind = 'product' then
    select * into r from public.products p where id = p_ref and active
      and (not exists (select 1 from public.product_categories x where x.product_id = p.id) or exists (select 1 from public.product_categories x where x.product_id = p.id and x.category_id = v_cat));
    if not found then raise exception 'Service not available for your category'; end if;
    v_amount := r.price; v_desc := r.name; v_meta := jsonb_build_object('product_id', r.id);
  elsif p_kind = 'subscription' then
    v_amount := public.package_price(p_ref, coalesce(p_billing,'monthly')); if v_amount is null then raise exception 'Plan not available'; end if;
    select 'Plan: ' || name || ' (' || coalesce(p_billing,'monthly') || ')' into v_desc from public.packages where id = p_ref;
    v_meta := jsonb_build_object('package_id', p_ref, 'billing', coalesce(p_billing,'monthly'));
  else raise exception 'Unknown order type'; end if;
  v_gst := round(v_amount * public.gst_rate(), 2);
  insert into public.payments (business_id, kind, description, amount, gst, total, meta)
  values (p_business, p_kind, v_desc, v_amount, v_gst, v_amount + v_gst, v_meta) returning id into v_id;
  return jsonb_build_object('payment_id', v_id, 'description', v_desc, 'amount', v_amount, 'gst', v_gst, 'total', v_amount + v_gst);
end $$;

-- =====================================================================
-- Staff (agency) RPCs
-- =====================================================================
create or replace function public.admin_confirm_payment(p_payment uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare pay record; v_pkg uuid; v_billing text; v_ends date;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into pay from public.payments where id = p_payment for update;
  if not found or pay.status <> 'pending' then raise exception 'Payment is not pending'; end if;
  update public.payments set status = case when p_approve then 'confirmed' else 'rejected' end,
         confirmed_by = auth.uid(), confirmed_at = now() where id = p_payment;
  if not p_approve then return; end if;
  if pay.kind = 'subscription' then
    v_pkg := (pay.meta->>'package_id')::uuid; v_billing := coalesce(pay.meta->>'billing','monthly');
    select greatest(coalesce(subscription_ends, current_date), current_date) + case when v_billing='yearly' then interval '1 year' else interval '1 month' end
      into v_ends from public.businesses where id = pay.business_id;
    update public.businesses set status = 'active', package_id = v_pkg, billing = v_billing, subscription_ends = v_ends,
           wa_enabled = wa_enabled or coalesce((select includes_whatsapp from public.packages where id = v_pkg), false)
     where id = pay.business_id;
    if pay.meta->>'promo_code' is not null then update public.promo_codes set used = used + 1 where upper(code) = pay.meta->>'promo_code'; end if;
    update public.leads set status = 'won', updated_at = now() where id = pay.lead_id;
  elsif pay.kind = 'wa_credits' then
    insert into public.wa_wallets (business_id, balance) values (pay.business_id, 0) on conflict do nothing;
    update public.wa_wallets set balance = balance + (pay.meta->>'credits')::int, updated_at = now() where business_id = pay.business_id;
    insert into public.wa_ledger (business_id, delta, reason, ref, created_by) values (pay.business_id, (pay.meta->>'credits')::int, 'Credit pack purchase', pay.id::text, auth.uid());
    update public.businesses set wa_enabled = true where id = pay.business_id;
  end if;
end $$;

create or replace function public.admin_update_business(p_business uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  update public.businesses set
    status            = coalesce(p->>'status', status),
    package_id        = coalesce(nullif(p->>'package_id','')::uuid, package_id),
    billing           = coalesce(p->>'billing', billing),
    subscription_ends = coalesce(nullif(p->>'subscription_ends','')::date, subscription_ends),
    wa_enabled        = coalesce((p->>'wa_enabled')::boolean, wa_enabled),
    wa_phone_number_id= coalesce(p->>'wa_phone_number_id', wa_phone_number_id),
    category_id       = coalesce(nullif(p->>'category_id','')::uuid, category_id)
  where id = p_business;
end $$;

create or replace function public.admin_adjust_credits(p_business uuid, p_delta int, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  insert into public.wa_wallets (business_id, balance) values (p_business, 0) on conflict do nothing;
  update public.wa_wallets set balance = balance + p_delta, updated_at = now() where business_id = p_business returning balance into v;
  insert into public.wa_ledger (business_id, delta, reason, created_by) values (p_business, p_delta, coalesce(nullif(p_reason,''),'Manual adjustment'), auth.uid());
  return v;
end $$;

create or replace function public.set_user_role(p_email text, p_role public.app_role) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Only a super admin can change roles'; end if;
  if lower(p_email) = lower((select email from public.profiles where id = auth.uid())) then raise exception 'You cannot change your own role'; end if;
  update public.profiles set role = p_role where lower(email) = lower(p_email);
  if not found then raise exception 'No account with that email. Ask them to sign up first.'; end if;
end $$;

create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'businesses_active', (select count(*) from businesses where status = 'active'),
    'businesses_pending', (select count(*) from businesses where status = 'pending_payment'),
    'businesses_total', (select count(*) from businesses),
    'mrr', (select coalesce(sum(case when b.billing = 'yearly' then p.yearly_price/12 else p.monthly_price end * (1 - p.discount_percent/100.0)),0)
              from businesses b join packages p on p.id = b.package_id where b.status = 'active'),
    'leads_new_7d', (select count(*) from leads where created_at > now() - interval '7 days'),
    'leads_open', (select count(*) from leads where status in ('new','contacted','payment_pending')),
    'payments_pending', (select count(*) from payments where status = 'pending'),
    'payments_pending_amount', (select coalesce(sum(total),0) from payments where status = 'pending'),
    'revenue_30d', (select coalesce(sum(total),0) from payments where status = 'confirmed' and confirmed_at > now() - interval '30 days'),
    'wa_credits_sold_30d', (select coalesce(sum(delta),0) from wa_ledger where delta > 0 and reason = 'Credit pack purchase' and created_at > now() - interval '30 days'),
    'wa_messages_30d', (select count(*) from wa_messages where status = 'sent' and created_at > now() - interval '30 days'),
    'revenue_by_month', (select coalesce(jsonb_agg(x order by x.month), '[]') from (
        select to_char(date_trunc('month', confirmed_at),'YYYY-MM') as month, sum(total) as total
        from payments where status = 'confirmed' and confirmed_at > date_trunc('month', now()) - interval '5 months'
        group by 1) x),
    'by_category', (select coalesce(jsonb_agg(x order by x.count desc), '[]') from (
        select coalesce(c.name,'Uncategorised') as name, count(b.id) as count from businesses b left join categories c on c.id = b.category_id group by 1) x),
    'leads_by_status', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from leads group by status) x),
    'by_package', (select coalesce(jsonb_agg(x), '[]') from (
        select p.name, count(b.id) as count from packages p left join businesses b on b.package_id = p.id and b.status = 'active' group by p.name, p.sort order by p.sort) x)
  ) into v;
  return v;
end $$;

-- Per-business report for staff and the business itself
create or replace function public.business_report(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_member(p_business) or public.is_staff()) then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'customers', (select count(*) from customers where business_id = p_business),
    'new_customers_30d', (select count(*) from customers where business_id = p_business and created_at > now() - interval '30 days'),
    'repeat_customers', (select count(*) from customers where business_id = p_business and visits > 1),
    'visits_30d', (select count(*) from visits where business_id = p_business and created_at > now() - interval '30 days'),
    'revenue_30d', (select coalesce(sum(net),0) from visits where business_id = p_business and created_at > now() - interval '30 days'),
    'revenue_prev_30d', (select coalesce(sum(net),0) from visits where business_id = p_business and created_at between now() - interval '60 days' and now() - interval '30 days'),
    'discount_30d', (select coalesce(sum(discount),0) from visits where business_id = p_business and created_at > now() - interval '30 days'),
    'reviews_reviewed', (select count(*) from customers where business_id = p_business and review_status = 'reviewed'),
    'reviews_asked', (select count(*) from customers where business_id = p_business and review_status <> 'none'),
    'avg_rating_30d', (select round(avg(rating)::numeric,2) from feedback where business_id = p_business and created_at > now() - interval '30 days'),
    'complaints_open', (select count(*) from feedback where business_id = p_business and status = 'open'),
    'loyalty_rewards_30d', (select count(*) from visits where business_id = p_business and loyalty_reward is not null and created_at > now() - interval '30 days'),
    'wa_balance', (select balance from wa_wallets where business_id = p_business),
    'wa_sent_30d', (select count(*) from wa_messages where business_id = p_business and status = 'sent' and created_at > now() - interval '30 days'),
    'daily', (select coalesce(jsonb_agg(x order by x.day), '[]') from (
        select to_char(d::date,'YYYY-MM-DD') as day, coalesce((select sum(net) from visits v where v.business_id = p_business and v.created_at::date = d::date),0) as revenue
        from generate_series(current_date - 13, current_date, interval '1 day') d) x)
  );
end $$;

-- =====================================================================
-- Business RPCs: visits with coupon + loyalty (best offer wins)
-- =====================================================================
create or replace function public.reward_discount(p_type text, p_value numeric, p_max numeric, p_gross numeric) returns numeric
language sql immutable as $$
  select greatest(0, least(
    round(case when p_type = 'percent' then p_gross * p_value / 100.0 else p_value end, 0),
    case when p_type = 'percent' and coalesce(p_max,0) > 0 then p_max else p_gross end,
    p_gross))
$$;

create or replace function public.preview_visit(p_business uuid, p_phone text, p_gross numeric, p_coupon text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b record; c record; k record; lp record; lr record; v_phone text; v_visit int := 0;
  v_cd numeric := 0; v_ld numeric := 0; v_use text := 'none'; v_has_lr boolean := false; v_coupon_msg text := null; v_coupon_ok boolean := true; v_next jsonb := null;
begin
  if not public.is_member(p_business) and not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into b from public.businesses where id = p_business;
  v_phone := public.norm_phone(p_phone, b.country_code);
  select * into c from public.customers where business_id = p_business and phone = v_phone;
  select * into lp from public.loyalty_programs where business_id = p_business;
  if lp.enabled then
    v_visit := least(coalesce(c.stamps,0), lp.stamps) + 1;
    select * into lr from public.loyalty_rewards where business_id = p_business and visit_no = v_visit and visit_no <= lp.stamps;
    if found then v_has_lr := true; v_ld := public.reward_discount(lr.type, lr.value, lr.max_discount, p_gross); end if;
    select jsonb_build_object('visit', visit_no, 'type', type, 'value', value, 'note', note) into v_next
      from public.loyalty_rewards where business_id = p_business and visit_no > v_visit and visit_no <= lp.stamps order by visit_no limit 1;
  end if;
  if coalesce(trim(p_coupon),'') <> '' then
    select * into k from public.coupons where business_id = p_business and upper(code) = upper(trim(p_coupon));
    if not found then v_coupon_ok := false; v_coupon_msg := 'No coupon with this code';
    elsif not k.active then v_coupon_ok := false; v_coupon_msg := k.code || ' is paused';
    elsif k.expiry is not null and k.expiry < current_date then v_coupon_ok := false; v_coupon_msg := k.code || ' has expired';
    elsif k.usage_limit > 0 and k.used >= k.usage_limit then v_coupon_ok := false; v_coupon_msg := k.code || ' is used up';
    elsif p_gross < k.min_bill then v_coupon_ok := false; v_coupon_msg := 'Needs a bill of at least ₹' || k.min_bill::int;
    else v_cd := public.reward_discount(k.type, k.value, k.max_discount, p_gross); v_coupon_msg := k.code || ' applied';
    end if;
  end if;
  if v_coupon_ok and v_cd > 0 and v_cd > v_ld then v_use := 'coupon';
  elsif v_has_lr then v_use := 'loyalty'; end if;
  return jsonb_build_object(
    'customer', case when c.id is null then null else jsonb_build_object('id', c.id, 'name', c.name, 'visits', c.visits, 'spend', c.spend, 'review_status', c.review_status, 'stamps', c.stamps) end,
    'phone', v_phone,
    'loyalty_enabled', coalesce(lp.enabled,false), 'loyalty_stamps', lp.stamps, 'visit_no', v_visit,
    'loyalty_reward', case when not v_has_lr then null else jsonb_build_object('type', lr.type, 'value', lr.value, 'note', lr.note, 'discount', v_ld) end,
    'next_reward', v_next,
    'coupon_ok', v_coupon_ok, 'coupon_message', v_coupon_msg, 'coupon_discount', v_cd,
    'use', v_use,
    'discount', case v_use when 'coupon' then v_cd when 'loyalty' then v_ld else 0 end,
    'completes_card', coalesce(lp.enabled,false) and v_visit >= coalesce(lp.stamps, 999));
end $$;

create or replace function public.log_visit(p_business uuid, p_phone text, p_name text, p_gross numeric, p_coupon text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pv jsonb; v_c uuid; v_use text; v_disc numeric; v_label text; v_stamps int; v_done int := 0; v_completed boolean;
begin
  if not public.can_write(p_business) then raise exception 'Your account is paused. Contact Branditude.'; end if;
  if p_gross is null or p_gross < 0 then raise exception 'Enter the bill amount'; end if;
  pv := public.preview_visit(p_business, p_phone, p_gross, p_coupon);
  if coalesce(trim(p_coupon),'') <> '' and not (pv->>'coupon_ok')::boolean then raise exception '%', pv->>'coupon_message'; end if;
  if length(pv->>'phone') < 11 then raise exception 'Enter a valid phone number'; end if;
  v_use := pv->>'use'; v_disc := (pv->>'discount')::numeric; v_completed := (pv->>'completes_card')::boolean;
  v_c := nullif(pv->'customer'->>'id','')::uuid;
  if v_c is null then
    if coalesce(trim(p_name),'') = '' then raise exception 'Enter the customer''s name'; end if;
    insert into public.customers (business_id, name, phone, tags) values (p_business, trim(p_name), pv->>'phone', '{New}') returning id into v_c;
  end if;
  v_stamps := case when (pv->>'loyalty_enabled')::boolean then (pv->>'visit_no')::int else (select stamps from public.customers where id = v_c) end;
  if v_completed then v_stamps := 0; v_done := 1; end if;
  update public.customers set visits = visits + 1, spend = spend + (p_gross - v_disc), last_visit = now(),
         name = coalesce(nullif(trim(p_name),''), name), stamps = v_stamps, cards_completed = cards_completed + v_done
   where id = v_c;
  if v_use = 'loyalty' then
    v_label := coalesce(nullif(pv->'loyalty_reward'->>'note',''),
      case pv->'loyalty_reward'->>'type' when 'percent' then (pv->'loyalty_reward'->>'value')::numeric::int || '% off'
                                         when 'flat' then '₹' || (pv->'loyalty_reward'->>'value')::numeric::int || ' off' else 'Free gift' end);
  end if;
  insert into public.visits (business_id, customer_id, gross, discount, net, coupon_code, loyalty_visit, loyalty_reward, created_by)
  values (p_business, v_c, p_gross, v_disc, p_gross - v_disc, case when v_use = 'coupon' then upper(trim(p_coupon)) end,
          case when (pv->>'loyalty_enabled')::boolean then (pv->>'visit_no')::int else 0 end, v_label, auth.uid());
  if v_use = 'coupon' then update public.coupons set used = used + 1 where business_id = p_business and upper(code) = upper(trim(p_coupon)); end if;
  return pv || jsonb_build_object('customer_id', v_c, 'net', p_gross - v_disc, 'reward_label', v_label,
                                  'stamps_after', v_stamps, 'completed', v_completed);
end $$;

-- Save loyalty program + rewards in one call
create or replace function public.save_loyalty(p_business uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int;
begin
  if not public.can_write(p_business) then raise exception 'Not allowed'; end if;
  n := greatest(2, least(20, coalesce((p->>'stamps')::int, 10)));
  insert into public.loyalty_programs (business_id, enabled, name, stamps, theme)
  values (p_business, coalesce((p->>'enabled')::boolean, true), coalesce(nullif(p->>'name',''),'Loyalty card'), n, coalesce(p->>'theme','saffron'))
  on conflict (business_id) do update set enabled = excluded.enabled, name = excluded.name, stamps = excluded.stamps, theme = excluded.theme;
  delete from public.loyalty_rewards where business_id = p_business;
  for r in select * from jsonb_array_elements(coalesce(p->'rewards','[]')) loop
    if (r->>'visit_no')::int between 1 and n then
      insert into public.loyalty_rewards (business_id, visit_no, type, value, max_discount, note)
      values (p_business, (r->>'visit_no')::int, r->>'type', coalesce((r->>'value')::numeric,0), coalesce((r->>'max_discount')::numeric,0), coalesce(r->>'note',''))
      on conflict (business_id, visit_no) do update set type = excluded.type, value = excluded.value, max_discount = excluded.max_discount, note = excluded.note;
    end if;
  end loop;
end $$;

-- Feedback captured on the business's own device (counter screen)
create or replace function public.counter_feedback(p_business uuid, p_customer uuid, p_rating int, p_tags text[], p_text text, p_phone text, p_opened_google boolean, p_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; c record; b record;
begin
  if not public.can_write(p_business) then raise exception 'Not allowed'; end if;
  select * into b from public.businesses where id = p_business;
  select * into c from public.customers where id = p_customer and business_id = p_business;
  if p_id is not null and exists (select 1 from public.feedback where id = p_id and business_id = p_business) then
    update public.feedback set rating = p_rating, tags = coalesce(p_tags, tags), text = coalesce(p_text, text),
           phone = coalesce(nullif(public.norm_phone(p_phone, b.country_code),''), phone),
           opened_google = opened_google or coalesce(p_opened_google,false),
           status = case when p_rating >= 4 then 'happy' else 'open' end where id = p_id returning id into v_id;
    return v_id;
  end if;
  insert into public.feedback (business_id, customer_id, rating, tags, text, name, phone, source, status, opened_google)
  values (p_business, c.id, p_rating, coalesce(p_tags,'{}'), coalesce(p_text,''), coalesce(c.name,''),
          coalesce(c.phone, nullif(public.norm_phone(p_phone, b.country_code),''), ''), 'counter',
          case when p_rating >= 4 then 'happy' else 'open' end, coalesce(p_opened_google,false))
  returning id into v_id;
  return v_id;
end $$;

-- =====================================================================
-- WhatsApp credit reservation (called only by the Edge Function with the service key)
-- =====================================================================
create or replace function public.wa_reserve(p_business uuid, p_credits int, p_ref text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_ok boolean;
begin
  if not (select wa_enabled from public.businesses where id = p_business and status = 'active') then return false; end if;
  update public.wa_wallets set balance = balance - p_credits, updated_at = now()
   where business_id = p_business and balance >= p_credits;
  v_ok := found;
  if v_ok then insert into public.wa_ledger (business_id, delta, reason, ref) values (p_business, -p_credits, 'WhatsApp messages', p_ref); end if;
  return v_ok;
end $$;
create or replace function public.wa_refund(p_business uuid, p_credits int, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_credits <= 0 then return; end if;
  update public.wa_wallets set balance = balance + p_credits, updated_at = now() where business_id = p_business;
  insert into public.wa_ledger (business_id, delta, reason, ref) values (p_business, p_credits, 'Refund for failed messages', p_ref);
end $$;

-- =====================================================================
-- Function privileges
-- =====================================================================
revoke execute on all functions in schema public from public, anon;
grant execute on function public.norm_phone(text,text), public.slugify(text), public.reward_discount(text,numeric,numeric,numeric),
  public.quote(uuid,text,uuid[],text,uuid), public.package_price(uuid,text), public.gst_rate(),
  public.submit_lead(jsonb), public.public_business(text), public.submit_feedback(text,int,text[],text,text,text,boolean),
  public.my_role(), public.is_staff(), public.is_super_admin(), public.my_phone(), public.is_member(uuid), public.can_write(uuid)
  to anon, authenticated;
grant execute on function public.register_business(jsonb), public.submit_utr(uuid,text), public.create_order(uuid,text,uuid,text),
  public.admin_confirm_payment(uuid,boolean), public.admin_update_business(uuid,jsonb), public.admin_adjust_credits(uuid,int,text),
  public.set_user_role(text,public.app_role), public.admin_stats(), public.business_report(uuid),
  public.preview_visit(uuid,text,numeric,text), public.log_visit(uuid,text,text,numeric,text),
  public.save_loyalty(uuid,jsonb), public.counter_feedback(uuid,uuid,int,text[],text,text,boolean,uuid)
  to authenticated;
revoke execute on function public.wa_reserve(uuid,int,text), public.wa_refund(uuid,int,text), public.handle_new_user() from authenticated;
grant execute on function public.wa_reserve(uuid,int,text), public.wa_refund(uuid,int,text) to service_role;
