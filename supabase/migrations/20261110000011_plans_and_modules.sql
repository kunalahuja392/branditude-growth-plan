-- Plans ₹299–₹999 built from modules, plus paid add-on modules.
-- Core modules (reviews, customers) are in every plan. Each other module is in a plan, or bought as a monthly add-on.
-- During the free trial every module is unlocked.

create table if not exists public.modules (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  blurb       text not null default '',
  icon        text not null default '',
  core        boolean not null default false,       -- in every plan
  addon_price numeric(10,2) check (addon_price is null or addon_price >= 0),   -- per month; null = not sold on its own
  active      boolean not null default true,
  sort        int not null default 100
);
alter table public.modules enable row level security;
drop policy if exists mod_read on public.modules;
create policy mod_read on public.modules for select using (true);
drop policy if exists mod_staff on public.modules;
create policy mod_staff on public.modules for all using (public.is_staff()) with check (public.is_staff());
grant select on public.modules to anon, authenticated;
grant insert, update, delete on public.modules to authenticated;

insert into public.modules (key, name, blurb, icon, core, addon_price, sort) values
  ('reviews',        'Google reviews & feedback', 'Review QR, counter screen, feedback page with a private inbox for unhappy customers, review writing helper', '⭐', true,  null, 10),
  ('customers',      'Customer list & visits',    'Every visit saves name, number, birthday and spend; growth report', '👥', true,  null, 20),
  ('loyalty',        'Loyalty card & coupons',    'Digital stamp card with rewards, festival and birthday coupon codes', '🎁', false, 149, 30),
  ('campaigns',      'WhatsApp offers & alerts',  'Messages to birthdays, regulars and people who stopped coming; daily alerts', '💬', false, 149, 40),
  ('seo',            'Keywords & SEO studio',     'Profile description, Google posts, FAQs and review replies with the right keywords', '🔎', false, 99,  50),
  ('google_replies', 'Google review auto-replies','Replies to every Google review automatically, or drafts for you to check', '🤖', false, 149, 60),
  ('attendance',     'Staff attendance & salary', 'PIN check-in, late marks, leave and salary slips worked out for you', '🕘', false, 199, 70),
  ('menu',           'QR menu & table orders',    'Menu with photos, a QR per table, orders on a kitchen board', '🍽️', false, 199, 80)
on conflict (key) do update set name = excluded.name, blurb = excluded.blurb, icon = excluded.icon, core = excluded.core,
  addon_price = excluded.addon_price, sort = excluded.sort;

alter table public.businesses add column if not exists addon_modules text[] not null default '{}';

-- A module is on when: it's core, the plan has it, it was bought as an add-on, or the business is on its free trial.
create or replace function public.has_module(b uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.businesses x left join public.packages p on p.id = x.package_id
    where x.id = b and (
      x.status = 'trial'
      or m = any(coalesce(p.modules, '{}'))
      or m = any(x.addon_modules)
      or exists (select 1 from public.modules mm where mm.key = m and mm.core)))
$$;
revoke execute on function public.has_module(uuid, text) from public, anon;
grant execute on function public.has_module(uuid, text) to authenticated, service_role;

-- For edge functions: account open AND module on
create or replace function public.module_open(b uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.biz_open(b) and public.has_module(b, m)
$$;
revoke execute on function public.module_open(uuid, text) from public, anon;
grant execute on function public.module_open(uuid, text) to authenticated, service_role;

-- Add-ons a business pays for on renewal (bought add-ons the plan doesn't already include)
create or replace function public.addon_bill(b uuid, p_pkg uuid, p_billing text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'keys',   coalesce(jsonb_agg(m.key order by m.sort), '[]'),
    'names',  coalesce(string_agg(m.name, ', ' order by m.sort), ''),
    'amount', coalesce(sum(m.addon_price * case when p_billing = 'yearly' then 10 else 1 end), 0))
  from public.businesses x join public.modules m on m.key = any(x.addon_modules) and m.addon_price is not null
  where x.id = b and not (m.key = any(coalesce((select modules from public.packages where id = p_pkg), '{}')))
$$;
revoke execute on function public.addon_bill(uuid, uuid, text) from public, anon;
grant execute on function public.addon_bill(uuid, uuid, text) to authenticated;

alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments add constraint payments_kind_check check (kind in ('subscription','wa_credits','product','module'));

create or replace function public.create_order(p_business uuid, p_kind text, p_ref uuid, p_billing text default 'monthly') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_amount numeric; v_desc text; v_meta jsonb; v_gst numeric; v_id uuid; r record; v_cat uuid; v_bill text; v_pkgmods text[]; v_add jsonb;
begin
  if not public.is_member(p_business) then raise exception 'Not allowed'; end if;
  select category_id, billing, (select modules from public.packages where id = x.package_id) into v_cat, v_bill, v_pkgmods
    from public.businesses x where id = p_business;
  if p_kind = 'wa_credits' then
    select * into r from public.wa_credit_packs where id = p_ref and active; if not found then raise exception 'Pack not available'; end if;
    v_amount := r.price; v_desc := 'WhatsApp credits: ' || r.name || ' (' || r.credits || ' messages)'; v_meta := jsonb_build_object('pack_id', r.id, 'credits', r.credits);
  elsif p_kind = 'product' then
    select * into r from public.products p where id = p_ref and active
      and (not exists (select 1 from public.product_categories x where x.product_id = p.id) or exists (select 1 from public.product_categories x where x.product_id = p.id and x.category_id = v_cat));
    if not found then raise exception 'Service not available for your category'; end if;
    v_amount := r.price; v_desc := r.name; v_meta := jsonb_build_object('product_id', r.id);
  elsif p_kind = 'module' then
    select * into r from public.modules where id = p_ref and active and not core and addon_price is not null;
    if not found then raise exception 'This add-on is not available'; end if;
    if r.key = any(coalesce(v_pkgmods, '{}')) then raise exception 'Your plan already includes %', r.name; end if;
    if exists (select 1 from public.payments where business_id = p_business and kind = 'module' and status = 'pending' and meta->>'module' = r.key) then
      raise exception 'You already have a payment waiting for %', r.name; end if;
    v_bill := coalesce(v_bill, 'monthly');
    v_amount := r.addon_price * case when v_bill = 'yearly' then 10 else 1 end;
    v_desc := 'Add-on: ' || r.name || ' (' || case when v_bill = 'yearly' then '1 year' else '1 month' end || ')';
    v_meta := jsonb_build_object('module', r.key, 'billing', v_bill);
  elsif p_kind = 'subscription' then
    v_amount := public.package_price(p_ref, coalesce(p_billing,'monthly')); if v_amount is null then raise exception 'Plan not available'; end if;
    v_add := public.addon_bill(p_business, p_ref, coalesce(p_billing,'monthly'));
    select 'Plan: ' || name || ' (' || coalesce(p_billing,'monthly') || ')' into v_desc from public.packages where id = p_ref;
    if (v_add->>'amount')::numeric > 0 then
      v_amount := v_amount + (v_add->>'amount')::numeric; v_desc := v_desc || ' + add-ons: ' || (v_add->>'names');
    end if;
    v_meta := jsonb_build_object('package_id', p_ref, 'billing', coalesce(p_billing,'monthly'), 'modules', v_add->'keys');
  else raise exception 'Unknown order type'; end if;
  v_gst := round(v_amount * public.gst_rate(), 2);
  insert into public.payments (business_id, kind, description, amount, gst, total, meta)
  values (p_business, p_kind, v_desc, v_amount, v_gst, v_amount + v_gst, v_meta) returning id into v_id;
  return jsonb_build_object('payment_id', v_id, 'description', v_desc, 'amount', v_amount, 'gst', v_gst, 'total', v_amount + v_gst);
end $$;

create or replace function public.admin_confirm_payment(p_payment uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare pay record; v_pkg uuid; v_billing text; v_ends date; v_status text; v_cur date; v_mods text[];
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into pay from public.payments where id = p_payment for update;
  if not found or pay.status <> 'pending' then raise exception 'Payment is not pending'; end if;
  update public.payments set status = case when p_approve then 'confirmed' else 'rejected' end,
         confirmed_by = auth.uid(), confirmed_at = now() where id = p_payment;
  if not p_approve then return; end if;
  if pay.kind = 'subscription' then
    v_pkg := (pay.meta->>'package_id')::uuid; v_billing := coalesce(pay.meta->>'billing','monthly');
    select status, subscription_ends into v_status, v_cur from public.businesses where id = pay.business_id;
    v_ends := (case when v_status = 'active' then greatest(coalesce(v_cur, current_date), current_date) else current_date end)
              + case when v_billing='yearly' then interval '1 year' else interval '1 month' end;
    select coalesce(modules, '{}') into v_mods from public.packages where id = v_pkg;
    update public.businesses set status = 'active', package_id = v_pkg, billing = v_billing, subscription_ends = v_ends,
           wa_enabled = wa_enabled or coalesce((select includes_whatsapp from public.packages where id = v_pkg), false),
           addon_modules = array(select unnest(addon_modules) except select unnest(v_mods))   -- the new plan covers these now
     where id = pay.business_id;
    if pay.meta->>'promo_code' is not null then update public.promo_codes set used = used + 1 where upper(code) = pay.meta->>'promo_code'; end if;
    update public.leads set status = 'won', updated_at = now() where id = pay.lead_id;
  elsif pay.kind = 'module' then
    update public.businesses set addon_modules = array(select distinct unnest(addon_modules || array[pay.meta->>'module']))
     where id = pay.business_id;
  elsif pay.kind = 'wa_credits' then
    insert into public.wa_wallets (business_id, balance) values (pay.business_id, 0) on conflict do nothing;
    update public.wa_wallets set balance = balance + (pay.meta->>'credits')::int, updated_at = now() where business_id = pay.business_id;
    insert into public.wa_ledger (business_id, delta, reason, ref, created_by) values (pay.business_id, (pay.meta->>'credits')::int, 'Credit pack purchase', pay.id::text, auth.uid());
    update public.businesses set wa_enabled = true where id = pay.business_id;
  end if;
end $$;

-- Team can switch add-ons on/off by hand (e.g. a free month)
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
    category_id       = coalesce(nullif(p->>'category_id','')::uuid, category_id),
    addon_modules     = case when p ? 'addon_modules' then array(select jsonb_array_elements_text(p->'addon_modules')) else addon_modules end
  where id = p_business;
end $$;

-- Loyalty stamps only count when the loyalty module is on
do $$ declare d text; begin
  d := pg_get_functiondef('public.preview_visit(uuid,text,numeric,text)'::regprocedure);
  if position('has_module(p_business,''loyalty'')' in d) = 0 then
    d := replace(d, 'if lp.enabled then', 'if lp.enabled and public.has_module(p_business,''loyalty'') then');
    d := replace(d, '''loyalty_enabled'', coalesce(lp.enabled,false)', '''loyalty_enabled'', coalesce(lp.enabled,false) and public.has_module(p_business,''loyalty'')');
    execute d;
  end if;
  d := pg_get_functiondef('public.save_loyalty(uuid,jsonb)'::regprocedure);
  if position('has_module' in d) = 0 then
    d := replace(d, 'if not public.can_write(p_business) then raise exception ''Not allowed''; end if;',
                    'if not public.can_write(p_business) then raise exception ''Not allowed''; end if;
  if not public.has_module(p_business, ''loyalty'') then raise exception ''Loyalty card isn''''t in your plan. Add it from Plan & services.''; end if;');
    execute d;
  end if;
end $$;

drop policy if exists coup_rw on public.coupons;
create policy coup_rw on public.coupons for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_use(business_id, 'loyalty'));
drop policy if exists lr_rw on public.loyalty_rewards;
create policy lr_rw on public.loyalty_rewards for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_use(business_id, 'loyalty'));
drop policy if exists bk_rw on public.business_keywords;
create policy bk_rw on public.business_keywords for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_use(business_id, 'seo'));
drop policy if exists bc_rw on public.business_content;
create policy bc_rw on public.business_content for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_use(business_id, 'seo'));

-- The plans
update public.packages set name = 'Starter', tagline = 'Get more Google reviews and know your customers',
  monthly_price = 299, yearly_price = 2990, discount_percent = 0, discount_label = '', max_locations = 1, includes_whatsapp = false, is_popular = false, sort = 10,
  modules = '{reviews,customers}',
  features = '{"Review QR and counter rating screen","Unhappy customers tell you privately first","Review writing helper for customers","Customer list with visits, birthdays and spend","Growth report","1 location"}'
  where slug = 'starter';
update public.packages set name = 'Growth', tagline = 'Bring customers back again and again',
  monthly_price = 599, yearly_price = 5990, discount_percent = 0, discount_label = '', max_locations = 1, includes_whatsapp = false, is_popular = true, sort = 20,
  modules = '{reviews,customers,loyalty,campaigns,seo}',
  features = '{"Everything in Starter","Loyalty card and coupons","WhatsApp offers to birthdays, regulars and lost customers","Daily alerts every morning","Keywords & SEO studio for your Google profile","1 location"}'
  where slug = 'growth';
update public.packages set name = 'Pro', tagline = 'Run the whole shop from one app',
  monthly_price = 999, yearly_price = 9990, discount_percent = 0, discount_label = '', max_locations = 3, includes_whatsapp = true, is_popular = false, sort = 30,
  modules = '{reviews,customers,loyalty,campaigns,seo,google_replies,attendance,menu}',
  features = '{"Everything in Growth","Google review auto-replies","Staff attendance and salary","QR menu and table orders","One-click WhatsApp bulk sending (message credits extra)","Up to 3 locations","Priority support"}'
  where slug = 'pro';

-- The QR menu is now a module, not a separate service; setup help becomes a paid service
update public.products set active = false where name = 'Digital QR menu';
insert into public.products (name, description, price, billing, sort)
select 'Done-for-you setup', 'We set up your review link, import your customer list, create your first offers and train your staff on a call', 999, 'one_time', 5
where not exists (select 1 from public.products where name = 'Done-for-you setup');
