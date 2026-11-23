-- New pricing (approved 23 Nov 2026). GST is not charged yet.
--  Single products: Loyalty ₹199, Review & Feedback ₹299, Staff Attendance ₹299, QR Menu ₹249 per 6 tables.
--  Plans: Basic ₹499, Growth ₹899, Pro ₹1,699. Gaming: Game Club ₹850, Game Club Premium ₹1,500 (no add-ons).
--  Yearly = 10 × monthly everywhere.

insert into public.settings (key, value, public) values ('gst', '{"rate":0}', true)
on conflict (key) do update set value = jsonb_set(coalesce(public.settings.value, '{}'), '{rate}', '0');

-- 'plan' = bundle, 'single' = one product sold on its own (has its own page on the site)
alter table public.packages add column if not exists kind text not null default 'plan';
alter table public.packages add column if not exists max_tables int;   -- QR menu tables included (null = no limit)
alter table public.packages add column if not exists page text;         -- store page for a single product
alter table public.businesses add column if not exists table_limit int; -- per-business override set by Branditude

-- Reviews is now sold on its own, so it is no longer switched on for everyone
update public.modules set core = false where key = 'reviews';
update public.modules m set addon_price = v.p from (values
  ('reviews',299),('loyalty',199),('attendance',299),('menu',249),('campaigns',99),('seo',149),
  ('google_replies',149),('bulk_whatsapp',299),('accounting',249)) v(k,p) where m.key = v.k;
update public.modules set addon_price = null where key in ('gaming','wa_billing');  -- gaming: plans only
-- Same names as the products on the website
update public.modules m set name = v.n from (values ('reviews','Review & Feedback'),('loyalty','Loyalty Card & coupons'),
  ('attendance','Staff Attendance & Salary'),('menu','QR Menu & table orders')) v(k,n) where m.key = v.k;

-- Plans
update public.packages set monthly_price = 499, yearly_price = 4990, name = 'Basic', tagline = 'Reviews, loyalty and your regulars, in one place',
  modules = array['reviews','customers','loyalty','campaigns'], max_locations = 1, max_tables = null, is_popular = false, sort = 10,
  features = array['Review & Feedback: review QR, counter screen, private inbox for unhappy customers',
    'Loyalty Card: digital stamp card, rewards and coupons','Daily alerts: birthdays, lost regulars, offers ending',
    'Customer list with visits, birthdays and spend','AI assistant for your sales and customers',
    'Automatic WhatsApp reminders (credits extra)','Team logins with permissions']
  where slug = 'starter';
update public.packages set monthly_price = 899, yearly_price = 8990, tagline = 'Run the shop and bring customers back',
  modules = array['reviews','customers','loyalty','campaigns','attendance','seo'], max_locations = 1, max_tables = null, is_popular = true, sort = 20,
  features = array['Everything in Basic','Staff Attendance & Salary: PIN check-in, leave, advances, salary slips',
    'Keywords & SEO studio for your Google profile','AI assistant on WhatsApp','Monthly growth report']
  where slug = 'growth';
update public.packages set monthly_price = 1699, yearly_price = 16990, tagline = 'Every tool, for busy and multi-branch businesses',
  modules = array['reviews','customers','loyalty','campaigns','attendance','seo','menu','bulk_whatsapp','accounting'],
  max_locations = 3, max_tables = 6, is_popular = false, sort = 30,
  features = array['Everything in Growth','QR Menu & table orders (up to 6 tables)','WhatsApp broadcasts and your own templates (credits extra)',
    'Accounts: P&L, balance sheet, GST reports, Tally export','Up to 3 locations','Priority support']
  where slug = 'pro';
update public.packages set kind = 'plan' where slug in ('starter','growth','pro','game-club','game-club-pro');

-- Gaming clubs: two plans, nothing sold separately
update public.packages set monthly_price = 850, yearly_price = 8500, modules = array['gaming','reviews','customers'], is_popular = false where slug = 'game-club';
update public.packages set name = 'Game Club Premium', monthly_price = 1500, yearly_price = 15000, is_popular = true,
  modules = array['gaming','wa_billing','loyalty','campaigns','attendance','reviews','customers'],
  features = array['Everything in Game Club','Bills, payment follow-ups and daily report on WhatsApp (credits extra)','Time-up reminder to the customer on WhatsApp',
    'Loyalty card and coupons','Birthday and win-back messages','Staff attendance and salary']
  where slug = 'game-club-pro';

-- Single products
insert into public.packages (name, slug, kind, page, tagline, monthly_price, yearly_price, features, modules, categories, max_locations, max_tables, is_popular, sort, active)
select * from (values
  ('Loyalty Card', 'loyalty-card', 'single', 'loyalty-card.html', 'A digital stamp card your customers never lose', 199.00, 1990.00,
   array['Digital stamp card on the customer''s phone, no app to download','Scan to add a stamp in 2 seconds','Rewards at the visits you choose','Birthday and festival coupons','Customer list with visits and spend'],
   array['loyalty','customers'], null::text[], 1, null::int, false, 101, true),
  ('Review & Feedback', 'review-feedback', 'single', 'reviews.html', 'More 5-star Google reviews, fewer public complaints', 299.00, 2990.00,
   array['Review QR for the counter and tables','AI writes the review for happy customers in their words','Unhappy customers come to your private inbox, not Google','Counter screen showing your rating','Customer list with visits'],
   array['reviews','customers'], null, 1, null, false, 102, true),
  ('Staff Attendance & Salary', 'staff-attendance', 'single', 'staff-attendance.html', 'Attendance, leave and salary, worked out for you', 299.00, 2990.00,
   array['Check-in with a PIN on the shop phone','Late marks, half days and leave','Advances and tips','Salary slips worked out every month','Staff logins with permissions'],
   array['attendance'], null, 1, null, false, 103, true),
  ('QR Menu', 'qr-menu-6', 'single', 'qr-menu.html', 'Menu and table orders, up to 6 tables', 249.00, 2490.00,
   array['Menu with photos and prices','A QR code for every table','Orders go straight to the kitchen board','Change prices or hide items any time'],
   array['menu'], array['cafe-restaurant','bakery-sweets','hotel-homestay'], 1, 6, false, 104, true),
  ('QR Menu', 'qr-menu-12', 'single', 'qr-menu.html', 'Menu and table orders, up to 12 tables', 498.00, 4980.00,
   array['Menu with photos and prices','A QR code for every table','Orders go straight to the kitchen board','Change prices or hide items any time'],
   array['menu'], array['cafe-restaurant','bakery-sweets','hotel-homestay'], 1, 12, false, 105, true),
  ('QR Menu', 'qr-menu-18', 'single', 'qr-menu.html', 'Menu and table orders, up to 18 tables', 747.00, 7470.00,
   array['Menu with photos and prices','A QR code for every table','Orders go straight to the kitchen board','Change prices or hide items any time'],
   array['menu'], array['cafe-restaurant','bakery-sweets','hotel-homestay'], 1, 18, false, 106, true),
  ('QR Menu', 'qr-menu-24', 'single', 'qr-menu.html', 'Menu and table orders, up to 24 tables', 996.00, 9960.00,
   array['Menu with photos and prices','A QR code for every table','Orders go straight to the kitchen board','Change prices or hide items any time'],
   array['menu'], array['cafe-restaurant','bakery-sweets','hotel-homestay'], 1, 24, false, 107, true)
) v(name, slug, kind, page, tagline, monthly_price, yearly_price, features, modules, categories, max_locations, max_tables, is_popular, sort, active)
where not exists (select 1 from public.packages p where p.slug = v.slug);

-- QR menu table limit: plan/single limit, or 6 when the menu was bought as an add-on. Trial, lifetime and override = per business.
create or replace function public.menu_table_limit(b uuid) returns int language sql stable security definer set search_path = public as $$
  select case when x.status = 'trial' or (x.lifetime and x.status = 'active') then null
              when x.table_limit is not null then x.table_limit
              when 'menu' = any(coalesce(p.modules,'{}')) then p.max_tables
              when 'menu' = any(x.addon_modules) then 6 else 0 end
  from public.businesses x left join public.packages p on p.id = x.package_id where x.id = b
$$;
grant execute on function public.menu_table_limit(uuid) to authenticated;

create or replace function public.dining_tables_limit() returns trigger language plpgsql security definer set search_path = public as $$
declare lim int := public.menu_table_limit(new.business_id);
begin
  if public.is_staff() or lim is null then return new; end if;
  if (select count(*) from public.dining_tables where business_id = new.business_id) >= lim then
    raise exception 'Your plan includes up to % tables. To add more, upgrade your QR Menu (₹249 per 6 tables).', lim; end if;
  return new;
end $$;
drop trigger if exists dining_tables_limit on public.dining_tables;
create trigger dining_tables_limit before insert on public.dining_tables for each row execute function public.dining_tables_limit();
