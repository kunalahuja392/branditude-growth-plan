-- Branditude can turn an existing login (e.g. one that signed up by mistake as a customer)
-- into a business owner. The owner fills in the business details the next time they sign in.
alter table public.businesses add column if not exists needs_setup boolean not null default false;

create or replace function public.admin_make_business(p_email text, p_package uuid default null, p_lifetime boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid; v_b uuid; v_pkg uuid := p_package;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_uid is null then raise exception 'No login found with this email. Ask them to sign up first.'; end if;
  if (select role from public.profiles where id = v_uid) in ('super_admin','team') then raise exception 'This is a Branditude team login'; end if;
  if exists (select 1 from public.business_members where user_id = v_uid) then raise exception 'This login already belongs to a business'; end if;
  if v_pkg is null then select id into v_pkg from public.packages where lower(name) = 'pro' order by sort limit 1; end if;
  insert into public.businesses (slug, name, owner_id, email, package_id, billing, status, subscription_ends, lifetime, needs_setup)
  values ('new-business-' || substr(md5(random()::text),1,6), 'New business', v_uid, lower(trim(p_email)), v_pkg, 'monthly',
          case when p_lifetime then 'active' else 'trial' end,
          case when p_lifetime then null else current_date + public.trial_days() end, p_lifetime, true)
  returning id into v_b;
  insert into public.business_members (business_id, user_id, role) values (v_b, v_uid, 'owner');
  insert into public.wa_wallets (business_id, balance) values (v_b, 0) on conflict do nothing;
  insert into public.loyalty_programs (business_id) values (v_b) on conflict do nothing;
  insert into public.loyalty_rewards (business_id, visit_no, type, value, note) values
    (v_b, 1, 'percent', 10, 'Welcome offer: 10% off'), (v_b, 5, 'percent', 15, ''), (v_b, 10, 'free', 300, 'Free item worth up to ₹300');
  update public.profiles set role = 'business' where id = v_uid and role = 'customer';
  return v_b;
end $$;
revoke execute on function public.admin_make_business(text, uuid, boolean) from public, anon;
grant execute on function public.admin_make_business(text, uuid, boolean) to authenticated;

-- The owner completes the details on first sign-in
create or replace function public.finish_business_setup(p_business uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.business_members where business_id = p_business and user_id = auth.uid() and role = 'owner')
    then raise exception 'Not allowed'; end if;
  if coalesce(trim(p->>'name'),'') = '' then raise exception 'Business name is required'; end if;
  if nullif(p->>'category_id','') is null then raise exception 'Choose your business type'; end if;
  update public.businesses set
    name = trim(p->>'name'), slug = public.slugify(p->>'name') || '-' || substr(md5(random()::text),1,4),
    category_id = (p->>'category_id')::uuid, phone = public.norm_phone(p->>'phone'),
    city = nullif(trim(p->>'city'),''), address = nullif(trim(p->>'address'),''), needs_setup = false
  where id = p_business and needs_setup;
  update public.profiles set full_name = coalesce(nullif(trim(p->>'contact_name'),''), full_name),
         phone = coalesce(phone, public.norm_phone(p->>'phone')) where id = auth.uid();
end $$;
revoke execute on function public.finish_business_setup(uuid, jsonb) from public, anon;
grant execute on function public.finish_business_setup(uuid, jsonb) to authenticated;
