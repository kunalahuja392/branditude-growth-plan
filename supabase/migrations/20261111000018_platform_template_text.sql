-- Platform WhatsApp templates: wording Meta accepts (no variable at the end, enough text per variable) and real sample values.
update public.wa_templates set body_preview = 'Hi {{1}}, thank you for visiting {{2}}! Could you leave us a quick Google review? {{3}} It takes less than a minute and helps us a lot.',
  sample = '{"Spice Route Cafe","https://g.page/r/spiceroute/review"}' where business_id is null and name = 'review_request';
update public.wa_templates set body_preview = 'Hi {{1}}! 🎉 {{2}} has a festive treat for you: {{3}}. Show this message at the counter. Valid till {{4}}. See you soon!',
  sample = '{"Spice Route Cafe","20% off with code DIWALI20","15 Nov"}' where business_id is null and name = 'festival_offer';
update public.wa_templates set body_preview = 'Hi {{1}}, thank you for your visit! Your {{2}} loyalty card now has {{3}} stamps. Your next reward: {{4}}. Show your card at the counter on your next visit to collect more stamps.',
  sample = '{"Spice Rewards","4 of 10","10% off on your 5th visit"}' where business_id is null and name = 'loyalty_update';
update public.wa_templates set sample = '{"Spice Route Cafe","a free dessert"}' where business_id is null and name = 'birthday_wish';
update public.wa_templates set sample = '{"Spice Route Cafe","a free coffee"}' where business_id is null and name = 'we_miss_you';
