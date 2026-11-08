-- Free trial for new businesses (default 3 days, set in settings.trial.days).
-- Trial = full access until subscription_ends. After that the account is read-only
-- until a plan payment is confirmed, except while a payment with a UPI ref is waiting
-- for confirmation (so a paying business isn't locked out while the team checks).
-- One trial per business phone number.

alter table public.businesses drop constraint if exists businesses_status_check;
alter table public.businesses add constraint businesses_status_check
  check (status in ('trial','pending_payment','active','paused','cancelled'));

insert into public.settings (key, value, public) values ('trial', '{"days":3}', true)
on conflict (key) do nothing;

create or replace function public.trial_days() returns int
language sql stable security definer set search_path = public as $$
  select greatest(0, coalesce((select (value->>'days')::int from public.settings where key = 'trial'), 3))
$$;

-- Can this business still write? (used by RLS and every business RPC)
create or replace function public.biz_open(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.businesses x where x.id = b and (
      x.status = 'active'
      or (x.status = 'trial' and x.subscription_ends >= current_date)
      or (x.status in ('trial','pending_payment') and exists (
            select 1 from public.payments p where p.business_id = x.id and p.kind = 'subscription'
              and p.status = 'pending' and p.utr is not null))
    ))
$$;

create or replace function public.can_write(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() or (public.is_member(b) and public.biz_open(b))
$$;

-- Readable reason for a locked account
create or replace function public.locked_reason(b uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when x.status = 'paused' then 'Your account is paused. Contact Branditude.'
    when x.status = 'cancelled' then 'Your plan is cancelled. Choose a plan to start again.'
    when x.status = 'trial' then 'Your free trial has ended. Pay for your plan to keep using the app.'
    else 'Your plan isn''t active yet. Pay for your plan to start using the app.' end
  from public.businesses x where x.id = b
$$;

-- Registration: start a trial (once per phone number), plan payment stays pending
create or replace function public.register_business(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_b uuid; v_slug text; v_q jsonb; v_lead uuid; v_pay uuid; v_products uuid[]; v_pkg uuid; v_billing text;
  v_phone text; v_trial boolean; v_days int := public.trial_days();
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if coalesce(trim(p->>'name'),'') = '' then raise exception 'Business name is required'; end if;
  if (select role from public.profiles where id = v_uid) in ('super_admin','team') then raise exception 'Agency accounts cannot register a business'; end if;
  v_pkg := nullif(p->>'package_id','')::uuid;
  if v_pkg is null then raise exception 'Choose a plan'; end if;
  v_billing := coalesce(nullif(p->>'billing',''),'monthly');
  v_phone := public.norm_phone(p->>'phone');
  select coalesce(array_agg(x::uuid), '{}') into v_products from jsonb_array_elements_text(coalesce(p->'product_ids','[]')) x;
  v_q := public.quote(v_pkg, v_billing, v_products, p->>'promo_code', nullif(p->>'category_id','')::uuid);
  v_trial := v_days > 0 and not exists (select 1 from public.businesses where phone = v_phone);

  v_slug := public.slugify(p->>'name') || '-' || substr(md5(random()::text),1,4);
  insert into public.businesses (slug, name, category_id, owner_id, phone, email, city, address, package_id, billing, status, subscription_ends)
  values (v_slug, trim(p->>'name'), nullif(p->>'category_id','')::uuid, v_uid, v_phone,
          nullif(p->>'email',''), p->>'city', p->>'address', v_pkg, v_billing,
          case when v_trial then 'trial' else 'pending_payment' end,
          case when v_trial then current_date + v_days end)
  returning id into v_b;
  insert into public.business_members (business_id, user_id, role) values (v_b, v_uid, 'owner');
  insert into public.wa_wallets (business_id, balance) values (v_b, 0);
  insert into public.loyalty_programs (business_id) values (v_b);
  insert into public.loyalty_rewards (business_id, visit_no, type, value, note) values
    (v_b, 1, 'percent', 10, 'Welcome offer: 10% off'), (v_b, 5, 'percent', 15, ''), (v_b, 10, 'free', 300, 'Free item worth up to ₹300');
  update public.profiles set role = 'business', full_name = coalesce(nullif(p->>'contact_name',''), full_name),
         phone = coalesce(phone, v_phone) where id = v_uid and role = 'customer';

  insert into public.leads (source, business_name, contact_name, phone, email, city, category_id, package_id, billing, product_ids,
                            promo_code, amount, gst, total, status, business_id, notes)
  values ('registration', trim(p->>'name'), p->>'contact_name', v_phone, nullif(p->>'email',''), p->>'city',
          nullif(p->>'category_id','')::uuid, v_pkg, v_billing, v_products,
          case when (v_q->>'promo_ok')::boolean then upper(p->>'promo_code') end,
          (v_q->>'subtotal')::numeric, (v_q->>'gst')::numeric, (v_q->>'total')::numeric, 'payment_pending', v_b,
          case when v_trial then 'On free trial until ' || to_char(current_date + v_days, 'DD Mon YYYY') else 'No trial: phone already used by another business' end)
  returning id into v_lead;
  insert into public.payments (business_id, lead_id, kind, description, amount, gst, total, meta)
  values (v_b, v_lead, 'subscription', 'Plan sign-up', (v_q->>'subtotal')::numeric, (v_q->>'gst')::numeric, (v_q->>'total')::numeric,
          jsonb_build_object('package_id', v_pkg, 'billing', v_billing, 'product_ids', to_jsonb(v_products),
                             'promo_code', case when (v_q->>'promo_ok')::boolean then upper(p->>'promo_code') end))
  returning id into v_pay;
  return v_q || jsonb_build_object('business_id', v_b, 'payment_id', v_pay, 'lead_id', v_lead, 'slug', v_slug,
                                   'trial', v_trial, 'trial_ends', case when v_trial then current_date + v_days end);
end $$;

-- Confirmed payment after a trial: plan starts today (unused trial days are not added on top)
create or replace function public.admin_confirm_payment(p_payment uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare pay record; v_pkg uuid; v_billing text; v_ends date; v_status text; v_cur date;
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

-- Friendly lock message on the main business action
create or replace function public.log_visit(p_business uuid, p_phone text, p_name text, p_gross numeric, p_coupon text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pv jsonb; v_c uuid; v_use text; v_disc numeric; v_label text; v_stamps int; v_done int := 0; v_completed boolean;
begin
  if not public.can_write(p_business) then raise exception '%', coalesce(public.locked_reason(p_business), 'Not allowed'); end if;
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

-- Public feedback link keeps working during a trial
create or replace function public.public_business(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'name', b.name, 'google_review_link', b.google_review_link, 'city', b.city)
  from public.businesses b where b.slug = p_slug and b.status in ('active','trial','pending_payment')
$$;
create or replace function public.submit_feedback(p_slug text, p_rating int, p_tags text[], p_text text, p_name text, p_phone text, p_opened_google boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b record; v_phone text; v_cust uuid; v_recent int;
begin
  select * into b from public.businesses where slug = p_slug and status in ('active','trial','pending_payment');
  if not found then raise exception 'Business not found'; end if;
  if p_rating not between 1 and 5 then raise exception 'Rating must be 1 to 5'; end if;
  v_phone := coalesce(public.my_phone(), nullif(public.norm_phone(p_phone, b.country_code),''));
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

-- Agency overview: trial counts
create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'businesses_active', (select count(*) from businesses where status = 'active'),
    'businesses_pending', (select count(*) from businesses where status = 'pending_payment'),
    'businesses_trial', (select count(*) from businesses where status = 'trial' and subscription_ends >= current_date),
    'trials_ending_48h', (select count(*) from businesses where status = 'trial' and subscription_ends between current_date and current_date + 2),
    'trials_expired', (select count(*) from businesses where status = 'trial' and subscription_ends < current_date),
    'businesses_total', (select count(*) from businesses),
    'mrr', (select coalesce(sum(case when b.billing = 'yearly' then p.yearly_price/12 else p.monthly_price end * (1 - p.discount_percent/100.0)),0)
              from businesses b join packages p on p.id = b.package_id where b.status = 'active'),
    'leads_new_7d', (select count(*) from leads where created_at > now() - interval '7 days'),
    'leads_open', (select count(*) from leads where status in ('new','contacted','payment_pending')),
    'payments_pending', (select count(*) from payments where status = 'pending' and utr is not null),
    'payments_pending_amount', (select coalesce(sum(total),0) from payments where status = 'pending' and utr is not null),
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

revoke execute on function public.trial_days(), public.biz_open(uuid), public.locked_reason(uuid) from public, anon;
grant execute on function public.trial_days() to anon, authenticated;
grant execute on function public.biz_open(uuid), public.locked_reason(uuid) to authenticated;

-- Existing unpaid sign-ups get the trial from their sign-up date
update public.businesses b set status = 'trial', subscription_ends = (b.created_at at time zone 'Asia/Kolkata')::date + public.trial_days()
 where b.status = 'pending_payment'
   and not exists (select 1 from public.payments p where p.business_id = b.id and p.status = 'confirmed');
