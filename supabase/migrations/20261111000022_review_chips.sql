-- Happy-customer review helper: "What did you like?" chips for the public feedback page.
-- Chips come from the business's own keywords (short, no "near me"/"best"/city stuffing) plus a few plain ones.
-- The customer ticks what they actually liked; suggestions are built only from their picks and they edit before posting.
create or replace function public.review_chips(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  with b as (select id, lower(coalesce(city, '')) as city from public.businesses where slug = p_slug and status in ('active','trial','pending_payment')),
  k as (
    select distinct on (lower(trim(bk.keyword))) trim(regexp_replace(bk.keyword, '\s+', ' ', 'g')) as kw, bk.created_at
    from public.business_keywords bk join b on b.id = bk.business_id
    where length(trim(bk.keyword)) between 3 and 32
      and bk.keyword !~* '(near me|best|top|cheap|no\.?\s*1|number one|\{city\}|[0-9]{3,})'
      and bk.keyword !~* '\s(in|at|near)\s+\S+$'
      and (b.city = '' or position(b.city in lower(bk.keyword)) = 0)
    order by lower(trim(bk.keyword)), bk.created_at)
  select coalesce((select jsonb_agg(kw order by created_at) from (select * from k order by created_at limit 8) x), '[]'::jsonb)
$$;
revoke execute on function public.review_chips(text) from public;
grant execute on function public.review_chips(text) to anon, authenticated;
