-- Snack categories that each club manages (Snacks, Drinks, ... plus their own). Items keep their category as text.
alter table public.gc_settings add column if not exists snack_categories text[] not null default '{Snacks,Drinks,Food,Accessories}';
update public.gc_settings s set snack_categories = (
  select array_agg(distinct c order by c) from (
    select unnest(s.snack_categories) c union select category from public.gc_products p where p.business_id = s.business_id and coalesce(category, '') <> '') x);

-- Rename or remove a category for every item at once (owners/admins only)
create or replace function public.gc_category(p_business uuid, p_action text, p_name text, p_new text default null) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_name text := trim(coalesce(p_name, '')); v_new text := trim(coalesce(p_new, '')); cats text[];
begin
  if not public.gc_can_setup(p_business) then raise exception 'Not allowed'; end if;
  perform public.gc_cfg(p_business);
  select snack_categories into cats from public.gc_settings where business_id = p_business;
  if p_action = 'add' then
    if v_name = '' then raise exception 'Type a category name'; end if;
    if lower(v_name) = any(select lower(unnest(cats))) then raise exception '% is already there', v_name; end if;
    cats := cats || v_name;
  elsif p_action = 'rename' then
    if v_new = '' then raise exception 'Type the new name'; end if;
    if lower(v_new) <> lower(v_name) and lower(v_new) = any(select lower(unnest(cats))) then raise exception '% is already there', v_new; end if;
    cats := array(select case when c = v_name then v_new else c end from unnest(cats) c);
    update public.gc_products set category = v_new where business_id = p_business and category = v_name;
  elsif p_action = 'delete' then
    v_new := coalesce(nullif(v_new, ''), 'Other');
    cats := array(select c from unnest(cats) c where c <> v_name);
    if exists (select 1 from public.gc_products where business_id = p_business and category = v_name) and not v_new = any(cats) then cats := cats || v_new; end if;
    update public.gc_products set category = v_new where business_id = p_business and category = v_name;
  else raise exception 'Unknown action'; end if;
  update public.gc_settings set snack_categories = cats where business_id = p_business;
  return cats;
end $$;
revoke all on function public.gc_category(uuid, text, text, text) from public, anon;
grant execute on function public.gc_category(uuid, text, text, text) to authenticated;
