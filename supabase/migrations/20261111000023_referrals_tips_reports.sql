-- 1) WhatsApp delivery report for a business (broadcasts + automatic messages)
-- 2) Sales agents and business referrals: codes, attribution, commissions on plan + add-on payments, manual payouts
-- 3) Tips: shared or per-person, paid through salary (salary_adjustments kind 'tip')

-- ---------- 1) Delivery report ----------
create or replace function public.wa_delivery_report(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.has_perm(p_business, 'whatsapp') or public.is_staff()) then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'broadcasts', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select b.id, b.title, b.audience, b.created_at, b.recipients, b.sent, b.failed,
               count(*) filter (where d.status in ('delivered','read')) as delivered,
               count(*) filter (where d.status = 'read') as read,
               count(*) filter (where d.status = 'failed') as failed_later
        from public.broadcasts b left join public.wa_messages m on m.broadcast_id = b.id
             left join public.wa_delivery d on d.wa_message_id = m.wa_message_id
        where b.business_id = p_business and b.created_at > now() - interval '90 days'
        group by b.id order by b.created_at desc limit 30) x), '[]'::jsonb),
    'auto', coalesce((select jsonb_agg(x) from (
        select l.kind, count(*) filter (where l.status = 'sent') as sent, count(*) filter (where l.status = 'failed') as failed,
               count(*) filter (where d.status in ('delivered','read')) as delivered, count(*) filter (where d.status = 'read') as read,
               count(*) filter (where d.status = 'failed') as failed_later
        from public.auto_msg_log l left join public.wa_delivery d on d.wa_message_id = l.wa_message_id
        where l.business_id = p_business and l.created_at > now() - interval '30 days' group by l.kind) x), '[]'::jsonb),
    'problems', coalesce((select jsonb_agg(x order by x.at desc) from (
        select coalesce(d.updated_at, m.created_at) as at, m.phone, coalesce(d.error, m.error) as error, m.template_name
        from public.wa_messages m left join public.wa_delivery d on d.wa_message_id = m.wa_message_id
        where m.business_id = p_business and m.created_at > now() - interval '30 days' and (m.status = 'failed' or d.status = 'failed')
        union all
        select coalesce(d.updated_at, l.created_at), c.phone, coalesce(d.error, l.error), l.kind
        from public.auto_msg_log l left join public.wa_delivery d on d.wa_message_id = l.wa_message_id left join public.customers c on c.id = l.customer_id
        where l.business_id = p_business and l.created_at > now() - interval '30 days' and (l.status = 'failed' or d.status = 'failed')
        order by 1 desc limit 20) x), '[]'::jsonb),
    'tracking', exists (select 1 from public.wa_delivery));
end $$;
revoke execute on function public.wa_delivery_report(uuid) from public, anon;
grant execute on function public.wa_delivery_report(uuid) to authenticated;

-- ---------- 2) Agents & referrals ----------
create table if not exists public.agents (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'agent' check (kind in ('agent', 'business')),
  name            text not null check (length(trim(name)) between 1 and 120),
  phone           text not null default '',
  email           text not null default '',
  business_id     uuid unique references public.businesses(id) on delete cascade,   -- for business referrers
  commission_pct  numeric(5,2) not null default 20 check (commission_pct between 0 and 60),
  months          int check (months is null or months between 1 and 120),            -- null = lifetime
  payout_details  text not null default '',                                          -- UPI / bank
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
alter table public.promo_codes add column if not exists agent_id uuid references public.agents(id) on delete set null;
alter table public.promo_codes drop constraint if exists promo_codes_value_check;
alter table public.promo_codes add constraint promo_codes_value_check check (value >= 0);
alter table public.businesses add column if not exists agent_id uuid references public.agents(id) on delete set null;
alter table public.businesses add column if not exists referred_at timestamptz;

create table if not exists public.agent_payouts (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references public.agents(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  paid_on     date not null default current_date,
  utr         text not null default '',
  proof_path  text,
  note        text not null default '',
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create table if not exists public.commissions (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references public.agents(id) on delete cascade,
  business_id  uuid not null references public.businesses(id) on delete cascade,
  payment_id   uuid not null unique references public.payments(id) on delete cascade,
  base         numeric(12,2) not null,
  pct          numeric(5,2) not null,
  amount       numeric(12,2) not null,
  status       text not null default 'due' check (status in ('due', 'paid', 'cancelled')),
  payout_id    uuid references public.agent_payouts(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists commissions_agent on public.commissions (agent_id, status);

insert into public.settings (key, value, public) values ('referral', '{"business_pct": 10, "business_months": 12}', false) on conflict (key) do nothing;

alter table public.agents enable row level security;
alter table public.agent_payouts enable row level security;
alter table public.commissions enable row level security;
drop policy if exists ag_staff on public.agents;          create policy ag_staff on public.agents for all using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists ag_team on public.agents;           create policy ag_team on public.agents for select using (public.is_staff());
drop policy if exists ap_staff on public.agent_payouts;   create policy ap_staff on public.agent_payouts for all using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists cm_staff on public.commissions;     create policy cm_staff on public.commissions for all using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists cm_team on public.commissions;      create policy cm_team on public.commissions for select using (public.is_staff());
grant select, insert, update, delete on public.agents, public.agent_payouts, public.commissions to authenticated;

-- Quote: a 0-value code is a referral code (no discount, but valid and remembered)
create or replace function public.quote(p_package uuid, p_billing text, p_products uuid[], p_promo text, p_category uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_pkg numeric := 0; v_prod numeric := 0; v_promo numeric := 0; v_sub numeric; v_gst numeric; r record; pc record;
  v_lines jsonb := '[]'; v_msg text := null; v_ref boolean := false; v_who text;
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
    elsif pc.value = 0 then
      v_ref := true; select name into v_who from public.agents where id = pc.agent_id;
      v_msg := 'Referral code applied' || coalesce(' (referred by ' || v_who || ')', '');
    else
      v_promo := case when pc.type = 'percent' then round(v_pkg * pc.value / 100.0, 2) else least(pc.value, v_pkg) end;
      v_lines := v_lines || jsonb_build_object('label', 'Promo ' || upper(pc.code), 'amount', -v_promo);
      v_msg := 'Promo applied';
    end if;
  end if;
  v_sub := greatest(v_pkg + v_prod - v_promo, 0);
  v_gst := round(v_sub * public.gst_rate(), 2);
  return jsonb_build_object('lines', v_lines, 'subtotal', v_sub, 'gst', v_gst, 'total', v_sub + v_gst,
                            'promo_ok', v_promo > 0 or v_ref, 'referral', v_ref, 'promo_message', v_msg);
end $$;

-- Attribution: a sign-up with an agent's code (discount or referral) links the business to that agent
create or replace function public.lead_attribution() returns trigger
language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  if new.business_id is null or coalesce(new.promo_code, '') = '' then return new; end if;
  select pc.agent_id into a from public.promo_codes pc join public.agents g on g.id = pc.agent_id
   where upper(pc.code) = upper(new.promo_code) and g.active and coalesce(g.business_id, '00000000-0000-0000-0000-000000000000'::uuid) <> new.business_id;
  if a is not null then
    update public.businesses set agent_id = a, referred_at = coalesce(referred_at, now()) where id = new.business_id and agent_id is null;
  end if;
  return new;
end $$;
drop trigger if exists leads_attribution on public.leads;
create trigger leads_attribution after insert on public.leads for each row execute function public.lead_attribution();

-- Commission when a plan or add-on payment is confirmed (not WhatsApp credits or one-time services)
create or replace function public.payment_commission() returns trigger
language plpgsql security definer set search_path = public as $$
declare b record; g record; v_pct numeric; v_disc numeric := 0; pc record;
begin
  if new.status <> 'confirmed' or old.status = 'confirmed' or new.kind not in ('subscription', 'module') then return new; end if;
  select * into b from public.businesses where id = new.business_id;
  if b.agent_id is null then return new; end if;
  select * into g from public.agents where id = b.agent_id;
  if not found or not g.active then return new; end if;
  if g.months is not null and now() > coalesce(b.referred_at, b.created_at) + make_interval(months => g.months) then return new; end if;
  -- the agent's own discount code on this payment comes out of the agent's share
  if coalesce(new.meta->>'promo_code', '') <> '' then
    select * into pc from public.promo_codes where upper(code) = upper(new.meta->>'promo_code') and agent_id = g.id;
    if found and pc.type = 'percent' then v_disc := pc.value; end if;
  end if;
  v_pct := greatest(g.commission_pct - v_disc, 0);
  if v_pct <= 0 or coalesce(new.amount, 0) <= 0 then return new; end if;
  insert into public.commissions (agent_id, business_id, payment_id, base, pct, amount)
  values (g.id, b.id, new.id, new.amount, v_pct, round(new.amount * v_pct / 100, 2)) on conflict (payment_id) do nothing;
  return new;
end $$;
drop trigger if exists payments_commission on public.payments;
create trigger payments_commission after update of status on public.payments for each row execute function public.payment_commission();

-- Agent codes: discount can't be more than the agent's commission
create or replace function public.check_agent_code() returns trigger
language plpgsql security definer set search_path = public as $$
declare p numeric;
begin
  if new.agent_id is null then return new; end if;
  select commission_pct into p from public.agents where id = new.agent_id;
  if new.type <> 'percent' and new.value > 0 then raise exception 'Agent codes must be a percent discount'; end if;
  if new.value > p then raise exception 'This agent earns % percent, so their code can give at most % percent off', p, p; end if;
  return new;
end $$;
drop trigger if exists promo_agent_check on public.promo_codes;
create trigger promo_agent_check before insert or update on public.promo_codes for each row execute function public.check_agent_code();

-- Business "Refer & earn": creates the business's referrer record + code on first use; returns link, referrals and earnings
create or replace function public.my_referral(p_business uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g record; s jsonb := (select value from public.settings where key = 'referral'); v_code text; b record;
begin
  if not public.biz_admin(p_business) then raise exception 'Only the owner or an admin can see referrals'; end if;
  select * into b from public.businesses where id = p_business;
  select * into g from public.agents where business_id = p_business;
  if not found then
    insert into public.agents (kind, name, phone, email, business_id, commission_pct, months)
    values ('business', b.name, coalesce(b.phone, ''), coalesce(b.email, ''), p_business, coalesce((s->>'business_pct')::numeric, 10), nullif(coalesce((s->>'business_months')::int, 12), 0))
    returning * into g;
  end if;
  select code into v_code from public.promo_codes where agent_id = g.id order by created_at limit 1;
  if v_code is null then
    v_code := upper(left(regexp_replace(b.name, '[^A-Za-z0-9]', '', 'g'), 8)) || upper(substr(md5(random()::text), 1, 3));
    insert into public.promo_codes (code, type, value, agent_id) values (v_code, 'percent', 0, g.id);
  end if;
  return jsonb_build_object('code', v_code, 'pct', g.commission_pct, 'months', g.months,
    'referred', (select count(*) from public.businesses where agent_id = g.id),
    'paying', (select count(*) from public.businesses where agent_id = g.id and status = 'active'),
    'due', (select coalesce(sum(amount), 0) from public.commissions where agent_id = g.id and status = 'due'),
    'paid', (select coalesce(sum(amount), 0) from public.commissions where agent_id = g.id and status = 'paid'),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'paid_on', paid_on, 'utr', utr) order by paid_on desc) from public.agent_payouts where agent_id = g.id), '[]'::jsonb),
    'businesses', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'status', status, 'since', referred_at) order by referred_at desc) from public.businesses where agent_id = g.id), '[]'::jsonb));
end $$;
revoke execute on function public.my_referral(uuid) from public, anon;
grant execute on function public.my_referral(uuid) to authenticated;

-- Admin: record a payout for an agent and mark the chosen due commissions as paid
create or replace function public.agent_payout(p_agent uuid, p_commissions uuid[], p_amount numeric, p_paid_on date, p_utr text, p_proof text, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not public.is_super_admin() then raise exception 'Not allowed'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the amount paid'; end if;
  if coalesce(trim(p_utr), '') = '' and coalesce(p_proof, '') = '' then raise exception 'Add the UTR or a screenshot'; end if;
  insert into public.agent_payouts (agent_id, amount, paid_on, utr, proof_path, note, created_by)
  values (p_agent, p_amount, coalesce(p_paid_on, current_date), coalesce(trim(p_utr), ''), nullif(p_proof, ''), coalesce(p_note, ''), auth.uid()) returning id into v;
  update public.commissions set status = 'paid', payout_id = v where agent_id = p_agent and status = 'due' and id = any(coalesce(p_commissions, '{}'));
  return v;
end $$;
revoke execute on function public.agent_payout(uuid, uuid[], numeric, date, text, text, text) from public, anon;
grant execute on function public.agent_payout(uuid, uuid[], numeric, date, text, text, text) to authenticated;

-- Agent's own view (an agent signs in with the email the admin saved for them)
create or replace function public.agent_me() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare g record; e text := lower(coalesce((select email from auth.users where id = auth.uid()), ''));
begin
  if e = '' then return null; end if;
  select * into g from public.agents where kind = 'agent' and active and lower(email) = e limit 1;
  if not found then return null; end if;
  return jsonb_build_object('name', g.name, 'pct', g.commission_pct, 'months', g.months,
    'codes', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'off', value, 'used', used)) from public.promo_codes where agent_id = g.id and active), '[]'::jsonb),
    'businesses', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'status', status, 'since', referred_at, 'city', city) order by referred_at desc) from public.businesses where agent_id = g.id), '[]'::jsonb),
    'due', (select coalesce(sum(amount), 0) from public.commissions where agent_id = g.id and status = 'due'),
    'paid', (select coalesce(sum(amount), 0) from public.commissions where agent_id = g.id and status = 'paid'),
    'commissions', coalesce((select jsonb_agg(jsonb_build_object('business', b.name, 'amount', c.amount, 'pct', c.pct, 'status', c.status, 'at', c.created_at) order by c.created_at desc)
                     from public.commissions c join public.businesses b on b.id = c.business_id where c.agent_id = g.id), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'paid_on', paid_on, 'utr', utr) order by paid_on desc) from public.agent_payouts where agent_id = g.id), '[]'::jsonb));
end $$;
revoke execute on function public.agent_me() from public, anon;
grant execute on function public.agent_me() to authenticated;

-- ---------- 3) Tips through salary ----------
alter table public.salary_adjustments drop constraint if exists salary_adjustments_kind_check;
alter table public.salary_adjustments add constraint salary_adjustments_kind_check check (kind in ('bonus', 'allowance', 'advance', 'deduction', 'tip'));
alter table public.salary_adjustments add column if not exists tip_day date;

-- ---------- 4) WhatsApp inbox: owners chat with the AI assistant; anyone can reply STOP ----------
create table if not exists public.wa_optout (
  phone       text primary key,
  created_at  timestamptz not null default now()
);
create table if not exists public.wa_chat (
  id          bigserial primary key,
  phone       text not null,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists wa_chat_phone on public.wa_chat (phone, created_at desc);
alter table public.wa_optout enable row level security;
alter table public.wa_chat enable row level security;
drop policy if exists wo_staff on public.wa_optout; create policy wo_staff on public.wa_optout for select using (public.is_staff());
drop policy if exists wc_staff on public.wa_chat;   create policy wc_staff on public.wa_chat for select using (public.is_staff());
grant select on public.wa_optout, public.wa_chat to authenticated;

-- Who is writing on WhatsApp: a business owner/admin/staff whose login or business uses this number
create or replace function public.wa_member_by_phone(p_phone text) returns table (user_id uuid, business_id uuid, role text, business_name text)
language sql stable security definer set search_path = public as $$
  select m.user_id, m.business_id, m.role, b.name
  from public.business_members m join public.businesses b on b.id = m.business_id
  left join auth.users u on u.id = m.user_id left join public.profiles p on p.id = m.user_id
  where b.status in ('active', 'trial') and (u.phone = p_phone or p.phone = p_phone or (m.role = 'owner' and b.phone = p_phone))
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, b.created_at
  limit 1
$$;
revoke execute on function public.wa_member_by_phone(text) from public, anon, authenticated;
grant execute on function public.wa_member_by_phone(text) to service_role;
