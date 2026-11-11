-- Product offering, 11 Nov: AI assistant and refer & earn in every plan; tips with attendance; bulk WhatsApp sold as an add-on;
-- Google review auto-replies paused (Google hasn't approved API access yet); add-on prices reviewed.
insert into public.modules (key, name, blurb, icon, core, addon_price, sort) values
  ('ai_assistant', 'AI assistant', 'Ask about your sales, customers and staff in the app or on WhatsApp; AI review suggestions, complaint replies, offer ideas', '✨', true, null, 26)
on conflict (key) do update set name = excluded.name, blurb = excluded.blurb, icon = excluded.icon, core = true, addon_price = null, sort = excluded.sort, active = true;

update public.modules set addon_price = 149, blurb = 'Digital stamp card with rewards, festival and birthday coupon codes, AI offer ideas' where key = 'loyalty';
update public.modules set addon_price = 99 where key = 'campaigns';
update public.modules set addon_price = 149, blurb = 'Keywords made by AI from your profile, Google profile description, posts and FAQs written for you' where key = 'seo';
update public.modules set addon_price = 199, blurb = 'PIN check-in, late marks, leave, tips split your way, advances and salary slips worked out for you' where key = 'attendance';
update public.modules set addon_price = 249 where key = 'accounting';
update public.modules set addon_price = 199 where key = 'menu';
update public.modules set addon_price = 299, blurb = 'Send one message to a customer group (VIP, not seen in 60 days…) in one click, your own approved templates, delivery report' where key = 'bulk_whatsapp';
update public.modules set active = false where key = 'google_replies';

update public.packages set modules = array_remove(modules, 'google_replies') where 'google_replies' = any(modules);
update public.packages set features = array[
  'Review QR, counter screen and feedback link',
  'AI review suggestions for happy customers, private inbox for unhappy ones',
  'Digital loyalty card, scan to stamp',
  'Customer list with groups, visits, birthdays and spend',
  'AI assistant: ask about your sales and customers in the app',
  'Automatic WhatsApp reminders and visit updates (credits extra)',
  'Login with a WhatsApp code, team logins with permissions',
  'Refer a business and earn 10%'] where slug = 'starter';
update public.packages set features = array[
  'Everything in Starter',
  'Staff attendance, salary, advances and tips',
  'Daily alerts: birthdays, lost regulars, offers ending',
  'Keywords & SEO studio with AI-made keywords',
  'Chat with the AI assistant on WhatsApp',
  'Growth report'] where slug = 'growth';
update public.packages set features = array[
  'Everything in Growth',
  'WhatsApp broadcasts to customer groups with delivery report (credits extra)',
  'Your own WhatsApp message templates, written with AI',
  'QR menu and table orders',
  'Accounts: P&L, balance sheet, GST reports, Tally export',
  'Priority support'] where slug = 'pro';
