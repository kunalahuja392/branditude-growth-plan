-- Keyword studio: agency-suggested keywords per category, each business's chosen keywords,
-- saved AI/template content (profile description, Google posts, FAQ, review replies), AI usage log.
-- Keywords go into content the BUSINESS publishes itself (allowed by Google), never into customer reviews.

create table if not exists public.category_keywords (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  keyword     text not null,                 -- may contain {city}
  sort        int not null default 100,
  created_at  timestamptz not null default now(),
  unique (category_id, keyword)
);

create table if not exists public.business_keywords (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  keyword     text not null check (length(trim(keyword)) between 2 and 80),
  source      text not null default 'own' check (source in ('suggested','ai','own')),
  created_at  timestamptz not null default now()
);
create unique index if not exists business_keywords_uniq on public.business_keywords (business_id, lower(keyword));

create table if not exists public.business_content (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind        text not null check (kind in ('description','post','faq','reply')),
  title       text default '',
  body        text not null,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

create table if not exists public.ai_usage (
  id          bigserial primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind        text not null,
  created_at  timestamptz not null default now()
);

alter table public.category_keywords enable row level security;
alter table public.business_keywords enable row level security;
alter table public.business_content  enable row level security;
alter table public.ai_usage          enable row level security;

create policy ck_read  on public.category_keywords for select using (auth.uid() is not null);
create policy ck_write on public.category_keywords for all using (public.is_staff()) with check (public.is_staff());
create policy bk_rw on public.business_keywords for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id));
create policy bc_rw on public.business_content  for all using (public.is_member(business_id) or public.is_staff()) with check (public.can_write(business_id));
create policy ai_read on public.ai_usage for select using (public.is_member(business_id) or public.is_staff());

-- Starter suggestions (agency edits these in Admin → Keyword suggestions)
insert into public.category_keywords (category_id, keyword, sort)
select c.id, k.kw, k.n from public.categories c
join (values
  ('cafe-restaurant','best café in {city}',1),('cafe-restaurant','cafe near me',2),('cafe-restaurant','coffee shop in {city}',3),('cafe-restaurant','family restaurant {city}',4),('cafe-restaurant','breakfast place in {city}',5),('cafe-restaurant','pure veg restaurant {city}',6),('cafe-restaurant','cafe for work and meetings',7),('cafe-restaurant','birthday party venue {city}',8),
  ('salon-spa','best salon in {city}',1),('salon-spa','unisex salon near me',2),('salon-spa','hair spa in {city}',3),('salon-spa','bridal makeup {city}',4),('salon-spa','keratin treatment {city}',5),('salon-spa','facial and cleanup near me',6),('salon-spa','men''s grooming {city}',7),
  ('clinic-dental','best dentist in {city}',1),('clinic-dental','dental clinic near me',2),('clinic-dental','root canal treatment {city}',3),('clinic-dental','teeth whitening {city}',4),('clinic-dental','braces and aligners {city}',5),('clinic-dental','child-friendly doctor {city}',6),
  ('gym-fitness','best gym in {city}',1),('gym-fitness','gym near me',2),('gym-fitness','personal trainer {city}',3),('gym-fitness','weight loss program {city}',4),('gym-fitness','women''s fitness classes {city}',5),('gym-fitness','crossfit and functional training',6),
  ('retail-boutique','boutique in {city}',1),('retail-boutique','designer kurtis {city}',2),('retail-boutique','ethnic wear shop near me',3),('retail-boutique','bridal lehenga {city}',4),('retail-boutique','affordable fashion {city}',5),
  ('bakery-sweets','best bakery in {city}',1),('bakery-sweets','custom birthday cakes {city}',2),('bakery-sweets','eggless cakes {city}',3),('bakery-sweets','sweet shop near me',4),('bakery-sweets','fresh bread and pastries',5),('bakery-sweets','cake delivery {city}',6),
  ('coaching-education','best coaching classes in {city}',1),('coaching-education','tuition near me',2),('coaching-education','IIT JEE coaching {city}',3),('coaching-education','NEET coaching {city}',4),('coaching-education','spoken English classes {city}',5),
  ('hotel-homestay','budget hotel in {city}',1),('hotel-homestay','homestay near me',2),('hotel-homestay','family stay {city}',3),('hotel-homestay','hotel with parking {city}',4),('hotel-homestay','couple friendly hotel {city}',5),
  ('real-estate','flats for sale in {city}',1),('real-estate','2 BHK in {city}',2),('real-estate','real estate agent near me',3),('real-estate','new projects {city}',4),('real-estate','RERA approved projects {city}',5),
  ('auto-service','car service centre {city}',1),('auto-service','bike repair near me',2),('auto-service','car wash {city}',3),('auto-service','car AC repair {city}',4),('auto-service','wheel alignment {city}',5)
) as k(slug, kw, n) on k.slug = c.slug
on conflict do nothing;
