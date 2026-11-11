-- International phone numbers: a number typed with "+" or "00" is kept as is; otherwise the business country code is added.
create or replace function public.norm_phone(p text, cc text default '91')
returns text language sql immutable as $$
  select case
    when x.d = '' then ''
    when btrim(coalesce(p,'')) like '+%' then x.d
    when left(x.d,2) = '00' then substr(x.d,3)
    when y.n = '' then ''
    when left(y.n, length(x.c)) = x.c and length(y.n) >= length(x.c) + 9 then y.n
    else x.c || y.n end
  from (select regexp_replace(coalesce(p,''),'\D','','g') as d,
               coalesce(nullif(regexp_replace(coalesce(cc,''),'\D','','g'),''),'91') as c) x,
       lateral (select regexp_replace(x.d,'^0+','') as n) y
$$;

-- public pages need the business country to default the phone picker
create or replace function public.public_business(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'name', b.name, 'google_review_link', b.google_review_link, 'city', b.city,
    'country_code', coalesce(nullif(b.country_code,''),'91'))
  from public.businesses b where b.slug = p_slug and b.status in ('active','trial','pending_payment')
$$;

create or replace function public.public_menu(p_slug text, p_table uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b public.businesses; ms public.menu_settings; t public.dining_tables;
begin
  select * into b from public.businesses where slug = p_slug;
  if b.id is null or not public.biz_open(b.id) or not public.has_module(b.id, 'menu') then return null; end if;
  select * into ms from public.menu_settings where business_id = b.id;
  if p_table is not null then select * into t from public.dining_tables where id = p_table and business_id = b.id and active; end if;
  return jsonb_build_object(
    'name', b.name, 'city', b.city, 'slug', b.slug, 'country_code', coalesce(nullif(b.country_code,''),'91'),
    'ordering_on', coalesce(ms.ordering_on, true), 'show_prices', coalesce(ms.show_prices, true), 'note', coalesce(ms.note, ''),
    'table', case when t.id is null then null else jsonb_build_object('id', t.id, 'label', t.label) end,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort, c.name)
                            from public.menu_categories c where c.business_id = b.id and c.active), '[]'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'category_id', i.category_id, 'name', i.name, 'description', i.description,
                        'price', case when coalesce(ms.show_prices, true) then i.price else null end, 'food_type', i.food_type, 'image_url', i.image_url,
                        'available', i.available, 'bestseller', i.bestseller) order by i.sort, i.name)
                       from public.menu_items i left join public.menu_categories c on c.id = i.category_id
                       where i.business_id = b.id and (c.id is null or c.active)), '[]'));
end $$;
revoke execute on function public.public_menu(text, uuid) from public;
grant execute on function public.public_menu(text, uuid) to anon, authenticated;
