-- WhatsApp credits by type + Meta balance tracking
-- 1) Two balances per business: promotional (Meta "marketing") and utility. Each template's category decides which is used.
-- 2) Credit packs have a type; their price must give Branditude a 20–40% margin over Meta's rate + GST (rates editable).
-- 3) Businesses can also type any number of credits of each type (priced at the custom margin, inside the 20-40% band).
-- 4) Super admin records Meta prepaid top-ups and sees spend, remaining balance and the credits businesses still hold.

alter table public.wa_credit_packs add column if not exists kind text not null default 'marketing';
alter table public.wa_credit_packs drop constraint if exists wa_credit_packs_kind_check;
alter table public.wa_credit_packs add constraint wa_credit_packs_kind_check check (kind in ('marketing', 'utility'));
alter table public.wa_wallets add column if not exists utility_balance int not null default 0;
alter table public.wa_wallets drop constraint if exists wa_wallets_utility_balance_check;
alter table public.wa_wallets add constraint wa_wallets_utility_balance_check check (utility_balance >= 0);
alter table public.wa_ledger add column if not exists kind text not null default 'marketing';

-- Meta's India rates (per delivered message, before GST) and the margin rule. Staff-only setting.
insert into public.settings (key, value, public) values
  ('meta_rates', '{"marketing": 0.8631, "utility": 0.115, "gst": 18, "min_margin": 20, "max_margin": 40, "custom_margin": 40}', false)
on conflict (key) do nothing;
update public.settings set value = value || '{"custom_margin": 40}' where key = 'meta_rates' and not value ? 'custom_margin';

create or replace function public.meta_cost(p_kind text) returns numeric
language sql stable security definer set search_path = public as $$
  select round(((value->>case when p_kind = 'utility' then 'utility' else 'marketing' end)::numeric) * (1 + coalesce((value->>'gst')::numeric, 18) / 100), 4)
  from public.settings where key = 'meta_rates'
$$;

-- Pack price must sit inside the margin band
create or replace function public.check_pack_margin() returns trigger
language plpgsql security definer set search_path = public as $$
declare c numeric := public.meta_cost(new.kind); s jsonb := (select value from public.settings where key = 'meta_rates');
        lo numeric := coalesce((s->>'min_margin')::numeric, 20); hi numeric := coalesce((s->>'max_margin')::numeric, 40); per numeric; m numeric;
begin
  if not new.active or c is null or c <= 0 then return new; end if;
  per := new.price / new.credits; m := round((per - c) / c * 100, 1);
  if m < lo or m > hi then
    raise exception 'This price gives a % percent margin (Rs % per message). Keep the margin between % and % percent: Rs % to Rs % per message, which is Rs % to Rs % for % credits.',
      m, round(per, 3), lo, hi, round(c * (1 + lo / 100), 3), round(c * (1 + hi / 100), 3),
      ceil(c * (1 + lo / 100) * new.credits), floor(c * (1 + hi / 100) * new.credits), new.credits;
  end if;
  return new;
end $$;
drop trigger if exists wa_pack_margin on public.wa_credit_packs;
create trigger wa_pack_margin before insert or update on public.wa_credit_packs for each row execute function public.check_pack_margin();

-- New packs (old ones kept for payment history, switched off)
update public.wa_credit_packs set active = false where kind = 'marketing' and name in ('Starter pack', 'Business pack', 'Bulk pack');
insert into public.wa_credit_packs (name, credits, price, active, sort, kind)
select * from (values
  ('Promotional 500',   500,   699.00, true, 10, 'marketing'),
  ('Promotional 2,000', 2000, 2599.00, true, 11, 'marketing'),
  ('Promotional 5,000', 5000, 6199.00, true, 12, 'marketing'),
  ('Utility 1,000',     1000,  189.00, true, 20, 'utility'),
  ('Utility 5,000',     5000,  879.00, true, 21, 'utility'),
  ('Utility 20,000',   20000, 3299.00, true, 22, 'utility')) v(name, credits, price, active, sort, kind)
where not exists (select 1 from public.wa_credit_packs p where p.name = v.name);

-- Reserve / refund from the right balance
drop function if exists public.wa_reserve(uuid, int, text);
create or replace function public.wa_reserve(p_business uuid, p_credits int, p_ref text, p_kind text default 'marketing') returns boolean
language plpgsql security definer set search_path = public as $$
declare v_ok boolean; k text := case when p_kind = 'utility' then 'utility' else 'marketing' end;
begin
  if not (select wa_enabled from public.businesses where id = p_business and status = 'active') then return false; end if;
  if k = 'utility' then
    update public.wa_wallets set utility_balance = utility_balance - p_credits, updated_at = now() where business_id = p_business and utility_balance >= p_credits;
  else
    update public.wa_wallets set balance = balance - p_credits, updated_at = now() where business_id = p_business and balance >= p_credits;
  end if;
  v_ok := found;
  if v_ok then insert into public.wa_ledger (business_id, delta, reason, ref, kind) values (p_business, -p_credits, 'WhatsApp messages', p_ref, k); end if;
  return v_ok;
end $$;
drop function if exists public.wa_refund(uuid, int, text);
create or replace function public.wa_refund(p_business uuid, p_credits int, p_ref text, p_kind text default 'marketing') returns void
language plpgsql security definer set search_path = public as $$
declare k text := case when p_kind = 'utility' then 'utility' else 'marketing' end;
begin
  if p_credits <= 0 then return; end if;
  if k = 'utility' then update public.wa_wallets set utility_balance = utility_balance + p_credits, updated_at = now() where business_id = p_business;
  else update public.wa_wallets set balance = balance + p_credits, updated_at = now() where business_id = p_business; end if;
  insert into public.wa_ledger (business_id, delta, reason, ref, kind) values (p_business, p_credits, 'Refund for failed messages', p_ref, k);
end $$;
revoke execute on function public.wa_reserve(uuid, int, text, text), public.wa_refund(uuid, int, text, text) from public, anon, authenticated;
grant execute on function public.wa_reserve(uuid, int, text, text), public.wa_refund(uuid, int, text, text) to service_role;

drop function if exists public.admin_adjust_credits(uuid, int, text);
create or replace function public.admin_adjust_credits(p_business uuid, p_delta int, p_reason text, p_kind text default 'marketing') returns int
language plpgsql security definer set search_path = public as $$
declare v int; k text := case when p_kind = 'utility' then 'utility' else 'marketing' end;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  insert into public.wa_wallets (business_id, balance) values (p_business, 0) on conflict do nothing;
  if k = 'utility' then update public.wa_wallets set utility_balance = utility_balance + p_delta, updated_at = now() where business_id = p_business returning utility_balance into v;
  else update public.wa_wallets set balance = balance + p_delta, updated_at = now() where business_id = p_business returning balance into v; end if;
  insert into public.wa_ledger (business_id, delta, reason, created_by, kind) values (p_business, p_delta, coalesce(nullif(p_reason, ''), 'Manual adjustment'), auth.uid(), k);
  return v;
end $$;
revoke execute on function public.admin_adjust_credits(uuid, int, text, text) from public, anon;
grant execute on function public.admin_adjust_credits(uuid, int, text, text) to authenticated;

-- Price per credit when a business types its own quantity (custom margin, kept inside the min/max band)
create or replace function public.wa_custom_rates() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s jsonb := (select value from public.settings where key = 'meta_rates'); lo numeric; hi numeric; cm numeric; k text; c numeric; out jsonb := '{}';
begin
  lo := coalesce((s->>'min_margin')::numeric, 20); hi := coalesce((s->>'max_margin')::numeric, 40);
  cm := least(greatest(coalesce((s->>'custom_margin')::numeric, hi), lo), hi);
  foreach k in array array['marketing', 'utility'] loop
    c := public.meta_cost(k);
    out := out || jsonb_build_object(k, trunc(c * (1 + cm / 100), 4));
  end loop;
  return out;
end $$;
revoke execute on function public.wa_custom_rates() from public, anon;
grant execute on function public.wa_custom_rates() to authenticated;

create or replace function public.order_wa_credits(p_business uuid, p_marketing int, p_utility int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb := public.wa_custom_rates(); m int := greatest(coalesce(p_marketing, 0), 0); u int := greatest(coalesce(p_utility, 0), 0);
        v_amount numeric; v_gst numeric; v_desc text; v_id uuid;
begin
  if not public.is_member(p_business) then raise exception 'Not allowed'; end if;
  if m + u = 0 then raise exception 'Enter how many credits you want'; end if;
  if m > 200000 or u > 200000 then raise exception 'For more than 2,00,000 credits, please contact Branditude'; end if;
  v_amount := round(m * (r->>'marketing')::numeric + u * (r->>'utility')::numeric, 2);
  if v_amount < 1 then raise exception 'The minimum order is Rs 1'; end if;
  v_desc := 'WhatsApp credits: ' || concat_ws(' + ', case when m > 0 then m || ' promotional' end, case when u > 0 then u || ' utility' end);
  v_gst := round(v_amount * public.gst_rate(), 2);
  insert into public.payments (business_id, kind, description, amount, gst, total, meta)
  values (p_business, 'wa_credits', v_desc, v_amount, v_gst, v_amount + v_gst, jsonb_build_object('marketing', m, 'utility', u, 'credits', m + u, 'custom', true))
  returning id into v_id;
  return jsonb_build_object('payment_id', v_id, 'description', v_desc, 'amount', v_amount, 'gst', v_gst, 'total', v_amount + v_gst);
end $$;
revoke execute on function public.order_wa_credits(uuid, int, int) from public, anon;
grant execute on function public.order_wa_credits(uuid, int, int) to authenticated;

-- Pack purchases credit the pack's type
create or replace function public.apply_payment(p_payment uuid, p_approve boolean, p_by uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pay record; v_pkg uuid; v_billing text; v_ends date; v_status text; v_cur date; v_mods text[]; v_kind text; v_cr int;
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found or pay.status <> 'pending' then raise exception 'Payment is not pending'; end if;
  update public.payments set status = case when p_approve then 'confirmed' else 'rejected' end,
         confirmed_by = p_by, confirmed_at = now() where id = p_payment;
  if not p_approve then return; end if;
  if pay.kind = 'subscription' then
    v_pkg := (pay.meta->>'package_id')::uuid; v_billing := coalesce(pay.meta->>'billing','monthly');
    select status, subscription_ends into v_status, v_cur from public.businesses where id = pay.business_id;
    v_ends := (case when v_status = 'active' then greatest(coalesce(v_cur, current_date), current_date) else current_date end)
              + case when v_billing='yearly' then interval '1 year' else interval '1 month' end;
    select coalesce(modules, '{}') into v_mods from public.packages where id = v_pkg;
    update public.businesses set status = 'active', package_id = v_pkg, billing = v_billing, subscription_ends = v_ends,
           wa_enabled = wa_enabled or coalesce((select includes_whatsapp from public.packages where id = v_pkg), false),
           addon_modules = array(select unnest(addon_modules) except select unnest(v_mods))
     where id = pay.business_id;
    if pay.meta->>'promo_code' is not null then update public.promo_codes set used = used + 1 where upper(code) = pay.meta->>'promo_code'; end if;
    update public.leads set status = 'won', updated_at = now() where id = pay.lead_id;
  elsif pay.kind = 'module' then
    update public.businesses set addon_modules = array(select distinct unnest(addon_modules || array[pay.meta->>'module']))
     where id = pay.business_id;
  elsif pay.kind = 'wa_credits' then
    insert into public.wa_wallets (business_id, balance) values (pay.business_id, 0) on conflict do nothing;
    if pay.meta ? 'utility' or pay.meta ? 'marketing' then   -- typed quantities, possibly both types
      if coalesce((pay.meta->>'marketing')::int, 0) > 0 then
        update public.wa_wallets set balance = balance + (pay.meta->>'marketing')::int, updated_at = now() where business_id = pay.business_id;
        insert into public.wa_ledger (business_id, delta, reason, ref, created_by, kind) values (pay.business_id, (pay.meta->>'marketing')::int, 'Promotional credit pack', pay.id::text, p_by, 'marketing');
      end if;
      if coalesce((pay.meta->>'utility')::int, 0) > 0 then
        update public.wa_wallets set utility_balance = utility_balance + (pay.meta->>'utility')::int, updated_at = now() where business_id = pay.business_id;
        insert into public.wa_ledger (business_id, delta, reason, ref, created_by, kind) values (pay.business_id, (pay.meta->>'utility')::int, 'Utility credit pack', pay.id::text, p_by, 'utility');
      end if;
      update public.businesses set wa_enabled = true where id = pay.business_id;
      return;
    end if;
    v_cr := (pay.meta->>'credits')::int;
    v_kind := coalesce(pay.meta->>'kind', (select kind from public.wa_credit_packs where id = nullif(pay.meta->>'pack_id', '')::uuid), 'marketing');
    if v_kind = 'utility' then update public.wa_wallets set utility_balance = utility_balance + v_cr, updated_at = now() where business_id = pay.business_id;
    else update public.wa_wallets set balance = balance + v_cr, updated_at = now() where business_id = pay.business_id; end if;
    insert into public.wa_ledger (business_id, delta, reason, ref, created_by, kind)
      values (pay.business_id, v_cr, case when v_kind = 'utility' then 'Utility credit pack' else 'Promotional credit pack' end, pay.id::text, p_by, v_kind);
    update public.businesses set wa_enabled = true where id = pay.business_id;
  end if;
end $$;
revoke execute on function public.apply_payment(uuid, boolean, uuid) from public, anon, authenticated;

-- Meta prepaid top-ups (recorded by the super admin after adding funds in Meta's billing)
create table if not exists public.meta_recharges (
  id         uuid primary key default gen_random_uuid(),
  amount     numeric(12,2) not null check (amount > 0),
  paid_on    date not null default current_date,
  note       text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.meta_recharges enable row level security;
drop policy if exists mr_admin on public.meta_recharges;
create policy mr_admin on public.meta_recharges for all using (public.is_super_admin()) with check (public.is_super_admin());
grant select, insert, update, delete on public.meta_recharges to authenticated;
insert into public.meta_recharges (amount, paid_on, note)
select 40, '2026-11-11', 'First top-up by UPI' where not exists (select 1 from public.meta_recharges);

-- Summary for the admin: what businesses hold, what was sent, estimated Meta cost
create or replace function public.wa_admin_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb := (select value from public.settings where key = 'meta_rates');
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'rates', r,
    'custom', public.wa_custom_rates(),
    'first_recharge', (select min(paid_on) from public.meta_recharges),
    'cost', jsonb_build_object('marketing', public.meta_cost('marketing'), 'utility', public.meta_cost('utility')),
    'held', (select jsonb_build_object('marketing', coalesce(sum(balance), 0), 'utility', coalesce(sum(utility_balance), 0)) from public.wa_wallets),
    'recharged', (select coalesce(sum(amount), 0) from public.meta_recharges),
    'used', (select jsonb_build_object(
        'marketing', coalesce(-sum(delta) filter (where kind = 'marketing'), 0),
        'utility', coalesce(-sum(delta) filter (where kind = 'utility'), 0))
      from public.wa_ledger where reason in ('WhatsApp messages', 'Refund for failed messages')),
    'sold', (select jsonb_build_object('marketing', coalesce(sum(delta) filter (where kind = 'marketing'), 0), 'utility', coalesce(sum(delta) filter (where kind = 'utility'), 0))
      from public.wa_ledger where delta > 0 and reason like '%credit pack%'));
end $$;
revoke execute on function public.wa_admin_summary() from public, anon;
grant execute on function public.wa_admin_summary() to authenticated;
