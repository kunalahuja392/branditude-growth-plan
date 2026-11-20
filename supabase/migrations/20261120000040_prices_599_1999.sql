-- Plan prices from ₹599 to ₹1,999 a month (yearly = 10 months); add-on prices for gaming and WhatsApp bills.
update public.packages p set monthly_price = v.m, yearly_price = v.m * 10
  from (values ('starter',599),('growth',999),('pro',1999),('game-club',999),('game-club-pro',1999)) v(slug,m) where p.slug = v.slug;
update public.modules set addon_price = 499 where key = 'gaming';
update public.modules set addon_price = 199 where key = 'wa_billing';
