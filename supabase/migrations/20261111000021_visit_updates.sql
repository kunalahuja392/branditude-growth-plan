-- Instant WhatsApp updates after a visit, always naming the business (messages come from the shared Branditude number):
--   visit_update: thanks for visiting <business>, bill, stamps, next reward, card link
--   reward_used : you have used <reward/coupon> at <business> and saved <amount>, stamps, card link
-- Both are utility messages (1 utility credit). Each business switches them on in Automatic reminders.
-- The daily loyalty reminder now names the business instead of the card.

alter table public.auto_msgs drop constraint if exists auto_msgs_kind_check;
alter table public.auto_msgs add constraint auto_msgs_kind_check check (kind in ('birthday','loyalty','offer_expiry','win_back','visit_update','reward_used'));

insert into public.wa_templates (name, language, category, title, body_preview, params, sample, credits_per_message, active, status)
select * from (values
  ('visit_update', 'en', 'utility', 'Visit update with loyalty stamps',
   'Hi {{1}}, thank you for visiting {{2}} today. Bill paid: {{3}}. Your loyalty card at this store now has {{4}} stamps, and your next reward is {{5}}. You can see your card any time here: {{6}} Please show it at the counter on your next visit.',
   array['Business name','Bill paid','Stamps (e.g. 3 of 10)','Next reward','Card link'],
   array['Drip In','₹450','3 of 10','10% off on visit 5','https://scale.branditudeglobal.com/c.html?t=a1b2c3d4'], 1, false, 'pending'),
  ('reward_used', 'en', 'utility', 'Reward or coupon used',
   'Hi {{1}}, you have used {{2}} at {{3}} today and saved {{4}}. Your loyalty card at this store now has {{5}} stamps. You can see your card any time here: {{6}} Thank you for your visit.',
   array['Reward used','Business name','Amount saved','Stamps (e.g. 0 of 10)','Card link'],
   array['your loyalty reward (10% off)','Drip In','₹45','0 of 10','https://scale.branditudeglobal.com/c.html?t=a1b2c3d4'], 1, false, 'pending')
) v(name, language, category, title, body_preview, params, sample, credits_per_message, active, status)
where not exists (select 1 from public.wa_templates t where t.name = v.name and t.business_id is null);

-- What to send for a customer's latest visit (last 15 minutes). Server-side only.
create or replace function public.visit_message(p_business uuid, p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v record; c record; b record; lp record; nx record; st text; nxt text; link text; lbl text;
begin
  select * into v from public.visits where business_id = p_business and customer_id = p_customer and created_at > now() - interval '15 minutes'
   order by created_at desc limit 1;
  if not found then return jsonb_build_object('skip', 'No recent visit'); end if;
  select * into c from public.customers where id = p_customer and business_id = p_business;
  select * into b from public.businesses where id = p_business;
  select * into lp from public.loyalty_programs where business_id = p_business;
  if not found or not lp.enabled or not public.has_module(p_business, 'loyalty') then return jsonb_build_object('skip', 'Loyalty card is off'); end if;
  st := least(c.stamps, lp.stamps) || ' of ' || lp.stamps;
  select * into nx from public.loyalty_rewards r where r.business_id = p_business and r.visit_no > c.stamps and r.visit_no <= lp.stamps order by r.visit_no limit 1;
  nxt := case when nx.visit_no is null then 'a fresh card' else
           case nx.type when 'percent' then trim(to_char(nx.value, 'FM999')) || '% off' when 'flat' then '₹' || trim(to_char(nx.value, 'FM99999')) || ' off'
                        else coalesce(nullif(nx.note, ''), 'a free treat') end || ' on visit ' || nx.visit_no end;
  link := 'https://scale.branditudeglobal.com/c.html?t=' || c.card_token;
  if v.discount > 0 and (v.loyalty_reward is not null or v.coupon_code is not null) then
    lbl := case when v.loyalty_reward is not null then 'your loyalty reward (' || v.loyalty_reward || ')' else 'coupon ' || v.coupon_code end;
    return jsonb_build_object('kind', 'reward_used', 'template', 'reward_used', 'visit_id', v.id, 'phone', c.phone, 'name', c.name,
      'params', jsonb_build_array(lbl, b.name, '₹' || trim(to_char(v.discount, 'FM9999990.##')), st, link));
  end if;
  return jsonb_build_object('kind', 'visit_update', 'template', 'visit_update', 'visit_id', v.id, 'phone', c.phone, 'name', c.name,
    'params', jsonb_build_array(b.name, '₹' || trim(to_char(v.net, 'FM9999990.##')), st, nxt, link));
end $$;
revoke execute on function public.visit_message(uuid, uuid) from public, anon, authenticated;
grant execute on function public.visit_message(uuid, uuid) to service_role;

-- Loyalty reminder: {{2}} becomes the business name ("Your Drip In loyalty card now has 4 of 10 stamps")
create or replace function public.due_auto_msgs(p_business uuid, p_kind text)
returns table (customer_id uuid, name text, phone text, ref text, n int, params text[])
language plpgsql stable security definer set search_path = public as $$
declare a record; b record; lp record; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into a from public.auto_msgs x where x.business_id = p_business and x.kind = p_kind and x.enabled;
  if not found then return; end if;
  select * into b from public.businesses where id = p_business;
  if p_kind = 'birthday' then
    return query
      select c.id, c.name, c.phone, extract(year from today)::text, 1, array[b.name, coalesce(nullif(a.offer,''), 'a special treat')]
      from public.customers c
      where c.business_id = p_business and c.birthday is not null
        and to_char(c.birthday, 'MM-DD') = to_char(today + a.days, 'MM-DD')
        and not exists (select 1 from public.auto_msg_log l where l.business_id = p_business and l.kind = 'birthday' and l.customer_id = c.id and l.ref = extract(year from today)::text)
      limit a.daily_cap;
  elsif p_kind = 'win_back' then
    return query
      with s as (
        select c.*, (c.last_visit at time zone 'Asia/Kolkata')::date as lv,
          (select count(*) from public.auto_msg_log l where l.business_id = p_business and l.kind = 'win_back' and l.customer_id = c.id and l.ref = ((c.last_visit at time zone 'Asia/Kolkata')::date)::text)::int as sent,
          (select max(l.created_at) from public.auto_msg_log l where l.business_id = p_business and l.kind = 'win_back' and l.customer_id = c.id and l.ref = ((c.last_visit at time zone 'Asia/Kolkata')::date)::text) as last_sent
        from public.customers c where c.business_id = p_business and c.last_visit is not null)
      select s.id, s.name, s.phone, s.lv::text, s.sent + 1, array[b.name, coalesce(nullif(a.offer,''), 'a little something on your next visit')]
      from s where s.lv <= today - a.days and s.sent < a.times and (s.last_sent is null or s.last_sent < now() - make_interval(days => a.gap_days) + interval '2 hours')
      limit a.daily_cap;
  elsif p_kind = 'loyalty' then
    select * into lp from public.loyalty_programs where business_id = p_business;
    if not found or not lp.enabled or not public.has_module(p_business, 'loyalty') then return; end if;
    return query
      with s as (
        select c.*, (c.last_visit at time zone 'Asia/Kolkata')::date as lv, least(c.stamps, lp.stamps) as st,
          (select r from public.loyalty_rewards r where r.business_id = p_business and r.visit_no > least(c.stamps, lp.stamps) and r.visit_no <= lp.stamps order by r.visit_no limit 1) as nx,
          (select count(*) from public.auto_msg_log l where l.business_id = p_business and l.kind = 'loyalty' and l.customer_id = c.id and l.ref = ((c.last_visit at time zone 'Asia/Kolkata')::date)::text)::int as sent,
          (select max(l.created_at) from public.auto_msg_log l where l.business_id = p_business and l.kind = 'loyalty' and l.customer_id = c.id and l.ref = ((c.last_visit at time zone 'Asia/Kolkata')::date)::text) as last_sent
        from public.customers c where c.business_id = p_business and c.last_visit is not null and c.stamps > 0)
      select s.id, s.name, s.phone, s.lv::text, s.sent + 1,
        array[b.name, s.st || ' of ' || lp.stamps,
              'visit ' || (s.nx).visit_no || ': ' || case (s.nx).type when 'percent' then trim(to_char((s.nx).value, 'FM999')) || '% off'
                                                      when 'flat' then '₹' || trim(to_char((s.nx).value, 'FM99999')) || ' off'
                                                      else coalesce(nullif((s.nx).note,''), 'a free treat') end]
      from s where s.nx is not null and s.lv <= today - a.days and s.sent < a.times
        and (s.last_sent is null or s.last_sent < now() - make_interval(days => a.gap_days) + interval '2 hours')
      limit a.daily_cap;
  elsif p_kind = 'offer_expiry' then
    return query
      with k as (select * from public.coupons k where k.business_id = p_business and k.active and k.show_to_customers and k.expiry is not null
                   and k.expiry >= today and k.expiry - today <= a.days and (k.usage_limit = 0 or k.used < k.usage_limit)),
      s as (
        select c.id, c.name, c.phone, k.id as kid, k.code, k.title, k.type, k.value, k.expiry,
          (select count(*) from public.auto_msg_log l where l.business_id = p_business and l.kind = 'offer_expiry' and l.customer_id = c.id and l.ref = k.id::text)::int as sent,
          (select max(l.created_at) from public.auto_msg_log l where l.business_id = p_business and l.kind = 'offer_expiry' and l.customer_id = c.id and l.ref = k.id::text) as last_sent
        from k join public.customers c on c.business_id = p_business and c.last_visit > now() - interval '120 days')
      select s.id, s.name, s.phone, s.kid::text, s.sent + 1,
        array[b.name, coalesce(nullif(s.title,''), case s.type when 'percent' then trim(to_char(s.value,'FM999')) || '% off' else '₹' || trim(to_char(s.value,'FM99999')) || ' off' end) || ' with code ' || s.code,
              to_char(s.expiry, 'DD Mon')]
      from s where s.sent < a.times and (s.last_sent is null or s.last_sent < now() - make_interval(days => a.gap_days) + interval '2 hours')
      limit a.daily_cap;
  end if;
end $$;
revoke execute on function public.due_auto_msgs(uuid, text) from public, anon, authenticated;
grant execute on function public.due_auto_msgs(uuid, text) to service_role;

-- Delivery tracking: Meta's webhook posts sent / delivered / read / failed for every message id
create table if not exists public.wa_delivery (
  wa_message_id text primary key,
  status        text not null,
  error_code    int,
  error         text,
  recipient     text,
  updated_at    timestamptz not null default now()
);
alter table public.wa_delivery enable row level security;
drop policy if exists wd_staff on public.wa_delivery;
create policy wd_staff on public.wa_delivery for select using (public.is_staff());
grant select on public.wa_delivery to authenticated;
alter table public.auto_msg_log add column if not exists wa_message_id text;
insert into public.internal_secrets (key, value)
select 'wa_webhook_verify', md5(random()::text || clock_timestamp()::text) where not exists (select 1 from public.internal_secrets where key = 'wa_webhook_verify');
