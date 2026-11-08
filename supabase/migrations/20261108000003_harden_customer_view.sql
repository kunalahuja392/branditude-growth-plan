-- Replace the security-definer view with a function, and pin search_path on helper functions (Supabase advisor fixes)
drop view if exists public.my_businesses;
create or replace function public.my_businesses()
returns table (id uuid, name text, slug text, city text, phone text, google_review_link text, category text, icon text)
language sql stable security definer set search_path = public as $$
  select b.id, b.name, b.slug, b.city, b.phone, b.google_review_link, cat.name, cat.icon
  from public.businesses b left join public.categories cat on cat.id = b.category_id
  where public.my_phone() is not null
    and exists (select 1 from public.customers c where c.business_id = b.id and c.phone = public.my_phone())
$$;
revoke execute on function public.my_businesses() from public, anon;
grant execute on function public.my_businesses() to authenticated;
alter function public.norm_phone(text, text) set search_path = public;
alter function public.reward_discount(text, numeric, numeric, numeric) set search_path = public;
alter function public.slugify(text) set search_path = public;
