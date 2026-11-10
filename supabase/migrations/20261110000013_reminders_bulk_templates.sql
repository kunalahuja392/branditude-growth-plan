-- 1. Bulk WhatsApp is Pro-only (new module bulk_whatsapp). Starter/Growth can still send one-to-one messages and
--    optional automatic reminders, charged per message from WhatsApp credits.
-- 2. Automatic reminders (birthday, loyalty reward, offer ending, win-back): owner sets when and how many times.
-- 3. Pro businesses submit their own WhatsApp templates; Branditude approves / sends them to Meta.

insert into public.modules (key, name, blurb, icon, core, addon_price, sort) values
  ('reminders',     'Automatic WhatsApp reminders', 'Optional. Birthday wishes, loyalty reward and offer-ending reminders, win-back messages. You choose when and how many times. Charged per message from WhatsApp credits.', '⏰', true, null, 25),
  ('bulk_whatsapp', 'WhatsApp bulk messaging & own templates', 'Send one message to hundreds of customers in one click, with message templates you submit through Branditude. Charged per message from credits.', '📣', false, null, 45)
on conflict (key) do update set name = excluded.name, blurb = excluded.blurb, icon = excluded.icon, core = excluded.core, addon_price = excluded.addon_price, sort = excluded.sort;
update public.modules set name = 'Daily alerts & win-back lists',
  blurb = 'Every morning: birthdays coming up, regulars who stopped coming and offers about to end, with one-tap WhatsApp to each customer'
  where key = 'campaigns';

update public.packages set
  features = '{"Review QR and counter rating screen","Loyalty card and coupons","Unhappy customers tell you privately first","Customer list with visits, birthdays and spend","Automatic WhatsApp reminders (optional, charged per message)","1 location"}'
  where slug = 'starter';
update public.packages set
  features = '{"Everything in Starter","Staff attendance and salary","Daily alerts: birthdays, lost regulars, offers ending","Keywords & SEO studio for your Google profile","Growth report","1 location"}'
  where slug = 'growth';
update public.packages set modules = array(select distinct unnest(modules || '{bulk_whatsapp}')),
  features = '{"Everything in Growth","QR menu and table orders","Google review auto-replies","WhatsApp bulk messaging with your own templates (credits extra)","Up to 3 locations","Priority support"}'
  where slug = 'pro';

-- ---------- Automatic reminders ----------
create table if not exists public.auto_msgs (
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind        text not null check (kind in ('birthday','loyalty','offer_expiry','win_back')),
  enabled     boolean not null default false,
  days        int not null default 3 check (days between 0 and 365),     -- birthday/offer: days before; loyalty/win_back: days after last visit
  times       int not null default 1 check (times between 1 and 5),      -- how many reminders at most
  gap_days    int not null default 3 check (gap_days between 1 and 60),  -- days between repeat reminders
  offer       text not null default '',                                   -- text for {{offer}} in birthday / win-back messages
  daily_cap   int not null default 50 check (daily_cap between 1 and 1000),
  last_run_at timestamptz,
  last_note   text,
  updated_at  timestamptz not null default now(),
  primary key (business_id, kind)
);
alter table public.auto_msgs enable row level security;
drop policy if exists am_rw on public.auto_msgs;
create policy am_rw on public.auto_msgs for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id) or public.is_staff());
grant select, insert, update, delete on public.auto_msgs to authenticated;

create table if not exists public.auto_msg_log (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind        text not null,
  customer_id uuid references public.customers(id) on delete cascade,
  ref         text not null,       -- birthday year / last visit date / coupon id
  n           int not null default 1,
  status      text not null check (status in ('sent','failed')),
  credits     int not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  unique (business_id, kind, customer_id, ref, n)
);
create index if not exists auto_msg_log_biz on public.auto_msg_log(business_id, created_at desc);
alter table public.auto_msg_log enable row level security;
drop policy if exists aml_read on public.auto_msg_log;
create policy aml_read on public.auto_msg_log for select using (public.is_member(business_id) or public.is_staff());
grant select on public.auto_msg_log to authenticated;

-- Who is due today for one reminder rule. Service role only (the daily job).
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
        array[coalesce(nullif(regexp_replace(lp.name, '\s*card$', '', 'i'), ''), lp.name), s.st || ' of ' || lp.stamps,
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

-- Owner's preview: how many customers would get each reminder today (no names, no sending)
create or replace function public.auto_msgs_preview(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb := '{}'; k text; n int;
begin
  if not (public.is_member(p_business) or public.is_staff()) then raise exception 'Not allowed'; end if;
  foreach k in array array['birthday','loyalty','offer_expiry','win_back'] loop
    select count(*) into n from public.due_auto_msgs(p_business, k);
    out := out || jsonb_build_object(k, n);
  end loop;
  return out;
end $$;
revoke execute on function public.auto_msgs_preview(uuid) from public, anon;
grant execute on function public.auto_msgs_preview(uuid) to authenticated;

-- ---------- Business-submitted WhatsApp templates (Pro) ----------
alter table public.wa_templates add column if not exists business_id uuid references public.businesses(id) on delete cascade;
alter table public.wa_templates add column if not exists status text not null default 'approved';
alter table public.wa_templates drop constraint if exists wa_templates_status_check;
alter table public.wa_templates add constraint wa_templates_status_check check (status in ('pending','submitted','approved','rejected'));
alter table public.wa_templates add column if not exists sample text[] not null default '{}';
alter table public.wa_templates add column if not exists reject_reason text;
alter table public.wa_templates add column if not exists meta_id text;
alter table public.wa_templates add column if not exists submitted_by uuid references auth.users(id);

drop policy if exists tpl_read on public.wa_templates;
create policy tpl_read on public.wa_templates for select using (
  public.is_staff()
  or (auth.uid() is not null and active and status = 'approved' and business_id is null)
  or (business_id is not null and public.is_member(business_id)));

create or replace function public.submit_wa_template(p_business uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_body text := trim(coalesce(p->>'body','')); v_title text := trim(coalesce(p->>'title',''));
  v_n int; v_params text[]; v_sample text[]; v_name text; v_id uuid; v_cat text := coalesce(nullif(p->>'category',''),'marketing');
begin
  if not public.is_member(p_business) then raise exception 'Not allowed'; end if;
  if not public.can_use(p_business, 'bulk_whatsapp') then raise exception 'Own templates are part of the Pro plan. Upgrade to Pro to submit templates.'; end if;
  if length(v_title) < 3 then raise exception 'Give the template a short title'; end if;
  if length(v_body) < 15 or length(v_body) > 1024 then raise exception 'The message must be 15 to 1,024 characters'; end if;
  if v_body !~ '\{\{1\}\}' then raise exception 'Start with {{1}} for the customer''s first name, e.g. "Hi {{1}}, …"'; end if;
  if v_cat not in ('marketing','utility') then raise exception 'Choose marketing or utility'; end if;
  select coalesce(max((m[1])::int), 1) into v_n from regexp_matches(v_body, '\{\{(\d+)\}\}', 'g') m;
  select coalesce(array_agg(x), '{}') into v_params from jsonb_array_elements_text(coalesce(p->'params','[]')) x;
  select coalesce(array_agg(x), '{}') into v_sample from jsonb_array_elements_text(coalesce(p->'sample','[]')) x;
  if coalesce(array_length(v_params,1),0) <> v_n - 1 then raise exception 'Give a label for each blank from {{2}} to {{%}}', v_n; end if;
  if (select count(*) from public.wa_templates where business_id = p_business and status in ('pending','submitted')) >= 5 then
    raise exception 'You have 5 templates waiting for approval. Please wait for those first.'; end if;
  v_name := left(regexp_replace(lower(v_title), '[^a-z0-9]+', '_', 'g'), 40) || '_' || substr(md5(random()::text), 1, 5);
  insert into public.wa_templates (name, language, category, title, body_preview, params, sample, credits_per_message, active, business_id, status, submitted_by)
  values (v_name, coalesce(nullif(p->>'language',''),'en'), v_cat, v_title, v_body, v_params, v_sample,
          case when v_cat = 'marketing' then 1 else 1 end, false, p_business, 'pending', auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'name', v_name);
end $$;
revoke execute on function public.submit_wa_template(uuid, jsonb) from public, anon;
grant execute on function public.submit_wa_template(uuid, jsonb) to authenticated;

-- ---------- Daily job for automatic reminders (10:07 am IST = 04:37 UTC) ----------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('auto-messages-daily') where exists (select 1 from cron.job where jobname = 'auto-messages-daily');
    perform cron.schedule('auto-messages-daily', '37 4 * * *', $job$
      select net.http_post(
        url := 'https://dumninwceiqvevndpupc.supabase.co/functions/v1/auto-messages',
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-cron-secret', (select value from public.internal_secrets where key = 'cron_secret')),
        body := '{"action":"cron"}'::jsonb,
        timeout_milliseconds := 120000)
    $job$);
  end if;
end $$;
