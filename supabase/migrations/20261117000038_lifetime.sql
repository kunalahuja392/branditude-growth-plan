-- Lifetime businesses (set by Branditude only): every feature unlocked, never expires, no plan prices or payments shown.
alter table public.businesses add column if not exists lifetime boolean not null default false;

create or replace function public.has_module(b uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.businesses x left join public.packages p on p.id = x.package_id
    where x.id = b and (
      x.status = 'trial'
      or (x.lifetime and x.status = 'active')
      or m = any(coalesce(p.modules, '{}'))
      or m = any(x.addon_modules)
      or exists (select 1 from public.modules mm where mm.key = m and mm.core)))
$$;
revoke execute on function public.has_module(uuid, text) from public, anon;
grant execute on function public.has_module(uuid, text) to authenticated, service_role;

-- Owners can't switch it on themselves: only Branditude's team can change the flag
create or replace function public.businesses_lifetime_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.lifetime is distinct from old.lifetime and auth.uid() is not null and not public.is_staff() then
    raise exception 'Only Branditude can change lifetime access'; end if;
  if new.lifetime then new.status := 'active'; new.subscription_ends := null; end if;
  return new;
end $$;
revoke execute on function public.businesses_lifetime_guard() from public, anon, authenticated;
drop trigger if exists businesses_lifetime_guard on public.businesses;
create trigger businesses_lifetime_guard before update on public.businesses for each row execute function public.businesses_lifetime_guard();

-- Lifetime businesses never get a plan payment created for them
create or replace function public.no_plan_payment_for_lifetime() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('subscription','module') and exists (select 1 from public.businesses where id = new.business_id and lifetime) then
    raise exception 'This business has lifetime access: nothing to pay'; end if;
  return new;
end $$;
revoke execute on function public.no_plan_payment_for_lifetime() from public, anon, authenticated;
drop trigger if exists no_plan_payment_for_lifetime on public.payments;
create trigger no_plan_payment_for_lifetime before insert on public.payments for each row execute function public.no_plan_payment_for_lifetime();

create or replace function public.admin_update_business(p_business uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  update public.businesses set
    lifetime          = coalesce((p->>'lifetime')::boolean, lifetime),
    status            = case when coalesce((p->>'lifetime')::boolean, lifetime) then 'active' else coalesce(p->>'status', status) end,
    package_id        = coalesce(nullif(p->>'package_id','')::uuid, package_id),
    billing           = coalesce(p->>'billing', billing),
    subscription_ends = case when coalesce((p->>'lifetime')::boolean, lifetime) then null
                             when lifetime and not coalesce((p->>'lifetime')::boolean, true) then coalesce(nullif(p->>'subscription_ends','')::date, current_date + 30)
                             else coalesce(nullif(p->>'subscription_ends','')::date, subscription_ends) end,
    wa_enabled        = coalesce((p->>'wa_enabled')::boolean, wa_enabled),
    wa_phone_number_id= coalesce(p->>'wa_phone_number_id', wa_phone_number_id),
    category_id       = coalesce(nullif(p->>'category_id','')::uuid, category_id),
    addon_modules     = case when p ? 'addon_modules' then array(select jsonb_array_elements_text(p->'addon_modules')) else addon_modules end
  where id = p_business;
end $$;

-- Gaming Loft: lifetime access
update public.businesses set lifetime = true where name = 'Gaming Loft';
