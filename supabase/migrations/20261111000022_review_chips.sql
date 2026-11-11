-- Happy-customer review helper: "What did you like?" chips + where the business is, for the public feedback page.
-- Chips come from the business's own keywords (short, no "near me"/"best"/location phrases) plus plain ones added in the page.
-- City and locality are used by the suggestions (AI or built-in) so some suggestions mention the area naturally.
alter table public.businesses add column if not exists locality text not null default '';

drop function if exists public.review_chips(text);
create or replace function public.review_chips(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  with b as (select id, name, coalesce(city, '') as city, coalesce(locality, '') as locality,
                    (select c.name from public.categories c where c.id = x.category_id) as category
             from public.businesses x where slug = p_slug and status in ('active','trial','pending_payment')),
  k as (
    select distinct on (lower(trim(bk.keyword))) trim(regexp_replace(bk.keyword, '\s+', ' ', 'g')) as kw, bk.created_at
    from public.business_keywords bk join b on b.id = bk.business_id
    where length(trim(bk.keyword)) between 3 and 32
      and bk.keyword !~* '(near me|best|top|cheap|no\.?\s*1|number one|\{city\}|[0-9]{3,})'
      and bk.keyword !~* '\s(in|at|near)\s+\S+$'
      and (b.city = '' or position(lower(b.city) in lower(bk.keyword)) = 0)
    order by lower(trim(bk.keyword)), bk.created_at)
  select jsonb_build_object(
    'chips', coalesce((select jsonb_agg(kw order by created_at) from (select * from k order by created_at limit 8) x), '[]'::jsonb),
    'city', (select city from b), 'locality', (select locality from b), 'category', (select category from b))
$$;
revoke execute on function public.review_chips(text) from public;
grant execute on function public.review_chips(text) to anon, authenticated;
