-- Subscriptions and clean-ups (16 Nov 2026)
-- 1. Customers are no longer tagged "New" forever (the "New (1 visit)" filter already covers new customers).
-- 2. Businesses can cancel a payment they started but didn't finish; a late Razorpay payment still goes through.
-- 3. Plans end: 3 days of grace after the paid-until date, then the account pauses until renewed (data is kept).
-- 4. Plan renewal / trial ending reminders on WhatsApp (platform template "plan_reminder", sent by the daily job).
-- 5. Starter is renamed Basic. 6. Readable referral codes (e.g. DRIPIN10).

-- 1 ---------------------------------------------------------------
create or replace function public.customers_no_new_tag() returns trigger language plpgsql as $$
begin new.tags := array_remove(coalesce(new.tags, '{}'), 'New'); return new; end $$;
drop trigger if exists customers_no_new_tag on public.customers;
create trigger customers_no_new_tag before insert on public.customers for each row execute function public.customers_no_new_tag();
update public.customers set tags = array_remove(tags, 'New') where 'New' = any(tags);

-- 2 ---------------------------------------------------------------
alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check check (status in ('pending','confirmed','rejected','cancelled'));

create or replace function public.cancel_payment(p_payment uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pay record;
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  if not (public.is_super_admin() or public.member_has_perm(pay.business_id, auth.uid(), 'settings')) then raise exception 'Only the owner or an admin can do this'; end if;
  if pay.status <> 'pending' then raise exception 'This payment is already %', pay.status; end if;
  update public.payments set status = 'cancelled', confirmed_at = now(), confirmed_by = auth.uid() where id = p_payment;
end $$;
revoke execute on function public.cancel_payment(uuid) from public, anon;
grant execute on function public.cancel_payment(uuid) to authenticated;

-- a Razorpay payment that arrives after the business cancelled it is still applied
create or replace function public.razorpay_paid(p_payment uuid, p_order text, p_rzp_payment text, p_paise bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pay record;
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  if pay.status = 'confirmed' and pay.utr = p_rzp_payment then return jsonb_build_object('ok', true, 'already', true); end if;
  if pay.status not in ('pending','cancelled') then raise exception 'Payment is not pending'; end if;
  if coalesce(pay.meta->>'rzp_order','') <> p_order then raise exception 'Order does not match'; end if;
  if p_paise <> round(pay.total * 100) then raise exception 'Amount does not match'; end if;
  update public.payments set status = 'pending', utr = p_rzp_payment, meta = meta || jsonb_build_object('method','razorpay','rzp_payment',p_rzp_payment) where id = p_payment;
  perform public.apply_payment(p_payment, true, null);
  return jsonb_build_object('ok', true, 'kind', pay.kind);
end $$;

-- payments are online only now: the Razorpay setting is always on
insert into public.settings (key, value, public) values ('razorpay', '{"enabled": true}', true)
on conflict (key) do update set value = public.settings.value || '{"enabled": true}';

-- 3 ---------------------------------------------------------------
create or replace function public.grace_days() returns int language sql immutable as $$ select 3 $$;

-- open = can make changes. A paid plan stays open until 3 days after its paid-until date.
create or replace function public.biz_open(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.businesses x where x.id = b and (
      (x.status = 'active' and (x.subscription_ends is null or x.subscription_ends + public.grace_days() >= current_date))
      or (x.status = 'trial' and x.subscription_ends >= current_date)
      or (x.status in ('trial','pending_payment') and exists (
            select 1 from public.payments p where p.business_id = x.id and p.kind = 'subscription'
              and p.status = 'pending' and p.utr is not null))
    ))
$$;

-- daily: pause plans past the grace period (renewing makes them active again from the payment day)
create or replace function public.expire_plans() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.businesses set status = 'paused'
   where status = 'active' and subscription_ends is not null and subscription_ends + public.grace_days() < current_date;
  get diagnostics n = row_count; return n;
end $$;
revoke execute on function public.expire_plans() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'expire-plans-daily';
    perform cron.schedule('expire-plans-daily', '7 19 * * *', $job$ select public.expire_plans(); $job$); -- 00:37 IST
  end if;
end $$;

-- 4 ---------------------------------------------------------------
insert into public.wa_templates (name, language, category, title, body_preview, params, sample, credits_per_message, active, status)
select 'plan_reminder', 'en', 'utility', 'Plan renewal reminder (to business owners)',
  'Hi {{1}}, a reminder about the Branditude Growth Plan for {{2}}: {{3}}. Renew here to keep your reviews, loyalty cards and offers running: {{4}}',
  array['Business name','What is happening (e.g. it ends on 20 Nov)','Renew link'],
  array['Drip In','it ends on 20 Nov','https://scale.branditudeglobal.com/app.html#plan'], 1, false, 'pending'
where not exists (select 1 from public.wa_templates t where t.name = 'plan_reminder' and t.business_id is null);

create table if not exists public.plan_reminder_log (
  business_id uuid not null references public.businesses(id) on delete cascade,
  ends        date not null,
  days_left   int  not null,
  status      text not null default 'sent',
  error       text,
  created_at  timestamptz not null default now(),
  primary key (business_id, ends, days_left)
);
alter table public.plan_reminder_log enable row level security;
drop policy if exists plan_reminder_log_read on public.plan_reminder_log;
create policy plan_reminder_log_read on public.plan_reminder_log for select using (public.is_super_admin() or public.is_member(business_id));

-- Owners to remind today: paid plans 7, 3 and 1 day before the end, on the day and when the grace ends; trials 1 day before and on the day.
create or replace function public.plan_reminders_due() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('business_id', x.id, 'name', x.name, 'phone', x.phone, 'ends', x.subscription_ends,
           'days_left', x.subscription_ends - current_date, 'trial', x.status = 'trial',
           'owner', coalesce((select split_part(coalesce(nullif(p.full_name, ''), 'there'), ' ', 1) from public.business_members m join public.profiles p on p.id = m.user_id
                              where m.business_id = x.id and m.role = 'owner' limit 1), 'there'))), '[]'::jsonb)
  from public.businesses x
  where x.subscription_ends is not null and x.phone ~ '^\d{11,15}$'
    and ((x.status = 'active' and x.subscription_ends - current_date in (7, 3, 1, 0, -public.grace_days()))
      or (x.status = 'trial' and x.subscription_ends - current_date in (1, 0)))
    and not exists (select 1 from public.plan_reminder_log l where l.business_id = x.id and l.ends = x.subscription_ends and l.days_left = x.subscription_ends - current_date)
$$;
revoke execute on function public.plan_reminders_due() from public, anon, authenticated;

-- 5 ---------------------------------------------------------------
update public.packages set name = 'Basic' where slug = 'starter' and name = 'Starter';
update public.packages set features = array(select replace(f, 'Everything in Starter', 'Everything in Basic') from unnest(features) f) where 'Everything in Starter' = any(features);

-- 6 ---------------------------------------------------------------
-- readable code from the business name and the commission, e.g. DRIPIN10; a number is added only if it's taken
create or replace function public.make_ref_code(p_name text, p_pct numeric) returns text
language plpgsql volatile security definer set search_path = public as $$
declare base text := upper(left(regexp_replace(coalesce(p_name, ''), '[^A-Za-z]', '', 'g'), 8)); c text; i int := 1;
begin
  if length(base) < 3 then base := 'REF' || base; end if;
  c := base || coalesce(round(p_pct)::int, 10);
  while exists (select 1 from public.promo_codes where upper(code) = c) loop i := i + 1; c := base || coalesce(round(p_pct)::int, 10) || '-' || i; end loop;
  return c;
end $$;
revoke execute on function public.make_ref_code(text, numeric) from public, anon, authenticated;

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
    v_code := public.make_ref_code(b.name, g.commission_pct);
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

-- rename unused business referral codes to the readable form
do $$ declare r record; begin
  for r in select p.id, a.name, a.commission_pct from public.promo_codes p join public.agents a on a.id = p.agent_id
           where a.kind = 'business' and p.used = 0 and p.value = 0 loop
    update public.promo_codes set code = public.make_ref_code(r.name, r.commission_pct) where id = r.id;
  end loop;
end $$;

-- Plans that had already ended before this rule existed get the normal grace from today (agreed 16 Nov):
-- treated as ending today, so they get reminders and lock only if still unpaid after 3 days.
update public.businesses set subscription_ends = current_date
 where status = 'active' and subscription_ends is not null and subscription_ends < current_date;
