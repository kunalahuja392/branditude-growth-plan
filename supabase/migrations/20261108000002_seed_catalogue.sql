-- Starter catalogue. Everything here is editable from the admin portal.

insert into public.settings (key, value, public) values
  ('agency', '{"name":"Branditude","legal_name":"Branditude Global","website":"branditudeglobal.com","whatsapp":"","phone":"","email":"","address":"","hours":"Mon–Sat, 10 am to 7 pm"}', true),
  ('payment', '{"upi_id":"","upi_name":"Branditude Global","gstin":""}', true),
  ('gst', '{"rate":0.18}', true),
  ('whatsapp', '{"price_note":"Charged per message from prepaid credits. 1 credit = 1 message."}', true)
on conflict (key) do nothing;

insert into public.categories (name, slug, icon, sort) values
  ('Café & Restaurant',      'cafe-restaurant',   '☕', 10),
  ('Salon & Spa',            'salon-spa',         '💇', 20),
  ('Clinic & Dental',        'clinic-dental',     '🩺', 30),
  ('Gym & Fitness',          'gym-fitness',       '🏋️', 40),
  ('Retail & Boutique',      'retail-boutique',   '🛍️', 50),
  ('Bakery & Sweets',        'bakery-sweets',     '🧁', 60),
  ('Coaching & Education',   'coaching-education','🎓', 70),
  ('Hotel & Homestay',       'hotel-homestay',    '🏨', 80),
  ('Real Estate',            'real-estate',       '🏠', 90),
  ('Auto Service & Garage',  'auto-service',      '🚗', 100)
on conflict (slug) do nothing;

insert into public.packages (name, slug, tagline, monthly_price, yearly_price, features, max_locations, includes_whatsapp, is_popular, sort) values
  ('Starter', 'starter', 'For a single shop getting started', 999, 9990,
    array['Growth Plan app for 1 location','Google review QR code design','Counter feedback screen','Customer list up to 1,000','Coupons & loyalty card','Onboarding call (30 min)'], 1, false, false, 10),
  ('Growth', 'growth', 'Most popular for busy local businesses', 2499, 24990,
    array['Everything in Starter','Done-for-you setup in 48 hours','Google Business Profile optimisation','Import of your existing customers','Unlimited customers','Monthly growth report call'], 1, false, true, 20),
  ('Pro', 'pro', 'For multi-branch and high-volume brands', 4999, 49990,
    array['Everything in Growth','Up to 3 locations','WhatsApp add-on switched on (credits extra)','Weekly Google Business posts','Review reply management','Dedicated account manager'], 3, true, false, 30)
on conflict (slug) do nothing;

-- Category-specific services ("products")
with p as (
  insert into public.products (name, description, price, billing, sort) values
    ('Zomato & Swiggy listing optimisation', 'Menu photos, descriptions, offers and ratings strategy for both apps', 4999, 'one_time', 10),
    ('Digital QR menu', 'Mobile menu with your branding and a table QR code', 1999, 'one_time', 20),
    ('Food photography shoot', '25 edited dish photos for apps, Google and Instagram', 6999, 'one_time', 30),
    ('Online booking page', 'Appointment booking page with WhatsApp confirmations', 2999, 'one_time', 40),
    ('Before/after content pack', '12 branded before/after posts a month', 3999, 'monthly', 50),
    ('Practo & Justdial profile optimisation', 'Doctor profile, photos, timings and review push', 3999, 'one_time', 60),
    ('Membership referral campaign', 'Refer-a-friend offer, creatives and tracking for members', 3499, 'one_time', 70),
    ('WhatsApp catalogue setup', 'Your products in WhatsApp Business catalogue with prices', 2499, 'one_time', 80),
    ('Festive cake pre-order page', 'Pre-order page and campaign for festivals and birthdays', 2999, 'one_time', 90),
    ('Admission lead campaign', 'Meta lead ads for admissions with follow-up messages', 7999, 'monthly', 100),
    ('OTA listing optimisation', 'MakeMyTrip, Booking.com and Airbnb listing and photos', 5999, 'one_time', 110),
    ('Property lead ads', 'Meta and Google lead ads for your projects', 9999, 'monthly', 120),
    ('Service reminder campaign', 'Automatic service-due reminders for your customers', 2999, 'one_time', 130),
    ('Google Business Profile setup', 'Create, verify and optimise your Business Profile', 2999, 'one_time', 140),
    ('Instagram reels pack', '8 short reels a month, scripted and edited', 5999, 'monthly', 150),
    ('Review QR standee', 'Printed acrylic counter standee with your review QR', 799, 'one_time', 160)
  returning id, name
)
insert into public.product_categories (product_id, category_id)
select p.id, c.id from p join public.categories c on
  (p.name = 'Zomato & Swiggy listing optimisation' and c.slug in ('cafe-restaurant','bakery-sweets')) or
  (p.name = 'Digital QR menu'                     and c.slug in ('cafe-restaurant','bakery-sweets','hotel-homestay')) or
  (p.name = 'Food photography shoot'              and c.slug in ('cafe-restaurant','bakery-sweets')) or
  (p.name = 'Online booking page'                 and c.slug in ('salon-spa','clinic-dental','gym-fitness','auto-service')) or
  (p.name = 'Before/after content pack'           and c.slug in ('salon-spa','clinic-dental','gym-fitness')) or
  (p.name = 'Practo & Justdial profile optimisation' and c.slug in ('clinic-dental')) or
  (p.name = 'Membership referral campaign'        and c.slug in ('gym-fitness','coaching-education')) or
  (p.name = 'WhatsApp catalogue setup'            and c.slug in ('retail-boutique','bakery-sweets')) or
  (p.name = 'Festive cake pre-order page'         and c.slug in ('bakery-sweets')) or
  (p.name = 'Admission lead campaign'             and c.slug in ('coaching-education')) or
  (p.name = 'OTA listing optimisation'            and c.slug in ('hotel-homestay')) or
  (p.name = 'Property lead ads'                   and c.slug in ('real-estate')) or
  (p.name = 'Service reminder campaign'           and c.slug in ('auto-service'));
-- (Google Business Profile setup, Instagram reels pack and Review QR standee have no category rows = offered to everyone)

insert into public.wa_credit_packs (name, credits, price, sort) values
  ('Starter pack', 500, 599, 10),
  ('Business pack', 2000, 2199, 20),
  ('Bulk pack', 5000, 4999, 30);

insert into public.wa_templates (name, language, category, title, body_preview, params, credits_per_message) values
  ('festival_offer', 'en', 'marketing', 'Festival offer',
   'Hi {{1}}! 🎉 {{2}} has a festive treat for you: {{3}}. Show this message at the counter. Valid till {{4}}.',
   array['Business name','Offer (e.g. 20% off with code DIWALI20)','Valid till'], 1),
  ('we_miss_you', 'en', 'marketing', 'We miss you',
   'Hi {{1}}, it''s been a while! We''d love to see you again at {{2}}. Here''s {{3}} on your next visit.',
   array['Business name','Offer'], 1),
  ('birthday_wish', 'en', 'marketing', 'Birthday wish',
   'Happy birthday {{1}}! 🎂 Everyone at {{2}} wishes you a wonderful year. Enjoy {{3}} this week.',
   array['Business name','Birthday treat'], 1),
  ('loyalty_update', 'en', 'utility', 'Loyalty card update',
   'Hi {{1}}, your {{2}} card has {{3}} stamps. Next reward: {{4}}.',
   array['Card name','Stamps (e.g. 4 of 10)','Next reward'], 1),
  ('review_request', 'en', 'marketing', 'Review request',
   'Hi {{1}}, thank you for visiting {{2}}! Could you leave us a quick Google review? {{3}}',
   array['Business name','Review link'], 1)
on conflict (name) do nothing;
