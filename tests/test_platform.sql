\set ON_ERROR_STOP 1
\set QUIET 1
-- users
insert into auth.users (id,email,phone,raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a','owner@branditude.test',null,'{"full_name":"Agency Owner"}'),
 ('00000000-0000-0000-0000-00000000000b','team@branditude.test',null,'{"full_name":"Team Member"}'),
 ('00000000-0000-0000-0000-0000000000a1','cafe@example.test',null,'{"full_name":"Cafe Owner"}'),
 ('00000000-0000-0000-0000-0000000000b1','salon@example.test',null,'{"full_name":"Salon Owner"}'),
 ('00000000-0000-0000-0000-0000000000c1',null,'919876543210','{}'),
 ('00000000-0000-0000-0000-0000000000c2',null,'919000000001','{}');
update profiles set role='super_admin' where email='owner@branditude.test';
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;

\echo '--- 1. anon reads store catalogue, submits a lead with a promo'
insert into promo_codes(code,type,value) values ('LAUNCH20','percent',20);
set role anon; select pg_temp.as_user(null);
do $$ declare n int; q jsonb; begin
  select count(*) into n from packages; assert n=3, 'anon sees 3 packages';
  select count(*) into n from categories; assert n=10, 'anon sees 10 categories';
  select count(*) into n from promo_codes; assert n=0, 'anon cannot see promo codes';
  select count(*) into n from leads; assert n=0, 'anon cannot read leads';
  q := submit_lead(jsonb_build_object('business_name','Chai Point','phone','98765 11111','package_id',(select id from packages where slug='growth'),'billing','monthly','promo_code','launch20',
        'category_id',(select id from categories where slug='cafe-restaurant'),'product_ids',jsonb_build_array((select id from products where name='Zomato & Swiggy listing optimisation'))));
  assert (q->>'subtotal')::numeric = 599*0.8 + 4999, 'quote: growth -20% + zomato = '||(q->>'subtotal');
  assert (q->>'gst')::numeric = round((599*0.8+4999)*0.18,2), 'gst 18%';
  raise notice 'lead ok: % total %', q->>'ref', q->>'total';
  -- a salon cannot buy the Zomato product: it is silently excluded from the quote
  q := quote((select id from packages where slug='starter'),'monthly', array[(select id from products where name='Zomato & Swiggy listing optimisation')], null, (select id from categories where slug='salon-spa'));
  assert (q->>'subtotal')::numeric = 299, 'category filter on products';
end $$;
reset role;

\echo '--- 2. business owner registers'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r jsonb; begin
  r := register_business(jsonb_build_object('name','Spice Route Cafe','contact_name','Asha','phone','9800000001','city','Pune',
        'category_id',(select id from categories where slug='cafe-restaurant'),'package_id',(select id from packages where slug='growth'),'billing','monthly'));
  assert my_role()='business', 'role becomes business';
  assert (r->>'trial')::boolean and (select status from businesses where id=(r->>'business_id')::uuid)='trial', 'new business starts on trial';
  assert (select subscription_ends from businesses where id=(r->>'business_id')::uuid) = current_date + 3, 'trial is 3 days';
  perform submit_utr((r->>'payment_id')::uuid, '431298765012');
  raise notice 'registered %', r->>'slug';
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare r jsonb; begin
  r := register_business(jsonb_build_object('name','Glow Salon','phone','9800000002','category_id',(select id from categories where slug='salon-spa'),'package_id',(select id from packages where slug='starter')));
end $$;
reset role;

\echo '--- 3. owner cannot activate themself or see others; visits + loyalty + coupons'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare b uuid; r jsonb; n int; begin
  select id into b from businesses; -- only own business visible
  select count(*) into n from businesses; assert n=1, 'owner sees only own business';
  begin update businesses set status='active' where id=b; assert false, 'should fail'; exception when insufficient_privilege then null; end;
  update businesses set google_review_link='https://g.page/r/test/review' where id=b;
  begin perform admin_stats(); assert false; exception when others then assert sqlerrm='Not allowed'; end;
  -- loyalty: 4 stamps, visit 1 = 10%, visit 2 = flat 100, visit 4 = free up to 500
  perform save_loyalty(b, '{"enabled":true,"name":"Spice Rewards","stamps":4,"theme":"ink","rewards":[{"visit_no":1,"type":"percent","value":10},{"visit_no":2,"type":"flat","value":100},{"visit_no":4,"type":"free","value":500,"note":"Free meal"},{"visit_no":9,"type":"flat","value":1}]}');
  select count(*) into n from loyalty_rewards where business_id=b; assert n=3, 'reward beyond card ignored';
  insert into coupons(business_id,code,type,value,min_bill) values (b,'BIG300','flat',300,1000);
  r := log_visit(b,'9876543210','Priya',1000,null);   -- visit 1: 10% = 100
  assert (r->>'discount')::numeric=100 and r->>'use'='loyalty', 'visit1 loyalty 10%: '||r::text;
  r := log_visit(b,'9876543210','',1000,'big300');     -- visit 2: flat 100 vs coupon 300 → coupon
  assert r->>'use'='coupon' and (r->>'discount')::numeric=300, 'coupon beats loyalty';
  r := log_visit(b,'9876543210','',500,null);          -- visit 3: nothing
  assert r->>'use'='none' and (r->'next_reward'->>'visit')::int=4, 'visit3 none, next=4';
  r := log_visit(b,'9876543210','',800,null);          -- visit 4: free up to 500, completes card
  assert (r->>'discount')::numeric=500 and (r->>'completed')::boolean, 'final reward + completed';
  select stamps, cards_completed, visits into r from (select stamps, cards_completed, visits from customers where business_id=b) x;
  begin r := log_visit(b,'9876543210','',100,'NOPE'); assert false; exception when others then assert sqlerrm='No coupon with this code', sqlerrm; end;
  r := log_visit(b,'9000000001','Ravi',400,null);
  select count(*) into n from customers where business_id=b; assert n=2;
  select used into n from coupons where code='BIG300'; assert n=1, 'coupon used counted';
  perform counter_feedback(b,null,2,array['Waiting time'],'slow','9111111111',false,null);
end $$;
select c.name, c.stamps, c.cards_completed, c.visits, c.spend from customers c order by name;
reset role;

\echo '--- 4. other business cannot see cafe data'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare n int; b uuid; begin
  select count(*) into n from customers; assert n=0, 'salon sees no cafe customers';
  select count(*) into n from visits; assert n=0;
  select count(*) into n from feedback; assert n=0;
  select id into b from businesses where slug like 'spice%'; assert b is null, 'cannot see cafe business';
  begin perform log_visit((select business_id from business_members where user_id <> auth.uid() limit 1),'9999999999','x',1,null); assert false;
  exception when others then null; end;
end $$;
reset role;

\echo '--- 5. customer (phone OTP) sees own loyalty/visits only'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ declare n int; begin
  select count(*) into n from customers; assert n=1, 'customer sees own row only: '||n;
  select count(*) into n from visits; assert n=4, 'customer sees own 4 visits';
  select count(*) into n from loyalty_rewards; assert n=3, 'customer sees reward ladder';
  select count(*) into n from my_businesses(); assert n=1;
  select count(*) into n from feedback; assert n=0, 'customer cannot read feedback inbox';
  select count(*) into n from leads; assert n=0;
  begin update customers set stamps=99; get diagnostics n = row_count; assert n=0, 'customer cannot edit stamps'; exception when others then null; end;
  perform submit_feedback((select slug from my_businesses() limit 1), 5, null, 'Great', null, null, true);
end $$;
reset role;

\echo '--- 6. anon public feedback link'
set role anon; select pg_temp.as_user(null);
do $$ declare r jsonb; begin
  r := submit_feedback((select slug from businesses limit 1), 1, array['Quality'], 'cold food', 'Anon', '9222222222', false);
  assert false, 'anon cannot see businesses table so slug is null';
exception when others then null; end $$;
reset role;
select set_config('bgp.slug', (select slug from businesses where name='Spice Route Cafe'), false);
set role anon;
do $$ declare r jsonb; begin
  r := public_business(current_setting('bgp.slug')); assert r->>'name'='Spice Route Cafe';
  r := submit_feedback(current_setting('bgp.slug'), 1, array['Quality'], 'cold food', 'Anon', '9222222222', false);
  assert r->>'google_review_link' like 'https://g.page%', 'google link still offered to unhappy customer';
end $$;
reset role;

\echo '--- 7. team: stats, confirm payment, WhatsApp credits; cannot change roles'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin begin perform admin_stats(); assert false; exception when others then assert sqlerrm='Not allowed'; end; end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin perform set_user_role('team@branditude.test','team'); end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ declare s jsonb; p uuid; n int; begin
  s := admin_stats(); assert (s->>'payments_pending')::int=1, 'one sign-up with a UPI ref to confirm'; assert (s->>'businesses_trial')::int=2, 'two on trial';
  select count(*) into n from leads; assert n=3, 'team sees all leads: '||n;
  select id into p from payments where description='Plan sign-up' and utr is not null;
  perform admin_confirm_payment(p, true);
  assert (select status from businesses where name='Spice Route Cafe')='active';
  assert (select status from leads where business_id=(select id from businesses where name='Spice Route Cafe'))='won';
  begin perform set_user_role('cafe@example.test','super_admin'); assert false; exception when others then assert sqlerrm like 'Only a super admin%'; end;
end $$;
reset role;
-- cafe buys a WhatsApp pack
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r jsonb; b uuid; begin
  select id into b from businesses;
  r := create_order(b,'wa_credits',(select id from wa_credit_packs where credits=500),null);
  assert (r->>'total')::numeric = 699*1.18;
  begin r := create_order(b,'product',(select id from products where name='Property lead ads'),null); assert false; exception when others then assert sqlerrm like 'Service not available%'; end;
  r := create_order(b,'product',(select id from products where name='Review QR standee'),null);
  perform set_config('bgp.wa_payment', (select id::text from payments where kind='wa_credits'), false);
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin perform admin_confirm_payment((select id from payments where kind='wa_credits'), true); end $$;
reset role;
set role service_role;
do $$ declare b uuid; ok boolean; begin
  select id into b from businesses where name='Spice Route Cafe';
  ok := wa_reserve(b, 450, 'test'); assert ok, 'reserve 450 of 500';
  ok := wa_reserve(b, 100, 'test'); assert not ok, 'cannot overdraw';
  perform wa_refund(b, 10, 'test');
  assert (select balance from wa_wallets where business_id=b)=60;
  -- utility credits are separate: none bought yet, so a utility send can't take promotional credits
  ok := wa_reserve(b, 1, 'test', 'utility'); assert not ok, 'no utility credits yet';
  assert (select balance from wa_wallets where business_id=b)=60, 'promotional untouched';
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin begin perform wa_reserve((select id from businesses), 1, 'x'); assert false; exception when insufficient_privilege then null; end; end $$;
do $$ declare r jsonb; begin r := business_report((select id from businesses)); raise notice 'report: customers % revenue30 % complaints % wa %', r->>'customers', r->>'revenue_30d', r->>'complaints_open', r->>'wa_balance'; end $$;
reset role;

\echo '--- 8. paused business becomes read-only'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin perform admin_update_business((select id from businesses where name='Spice Route Cafe'), '{"status":"paused"}'); end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare n int; begin
  select count(*) into n from customers; assert n=2, 'can still read';
  begin perform log_visit((select id from businesses),'9876543210','',100,null); assert false; exception when others then assert sqlerrm like 'Your account is paused%'; end;
  begin insert into reminders(business_id,text) values ((select id from businesses),'x'); assert false; exception when insufficient_privilege then null; end;
end $$;
reset role;
\echo '--- 9. free trial rules'
reset role;
-- salon (no UTR) trial expires -> read-only with a clear reason
update businesses set subscription_ends = current_date - 1 where name='Glow Salon';
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid; p uuid; begin
  select id into b from businesses;
  begin perform log_visit(b,'9876500000','A',100,null); assert false; exception when others then assert sqlerrm like 'Your free trial has ended%', sqlerrm; end;
  -- paying (UTR entered) re-opens the account while the team checks the payment
  select id into p from payments where business_id=b and kind='subscription';
  perform submit_utr(p,'431200000001');
  perform log_visit(b,'9876500000','A',100,null);
end $$;
reset role;
-- same phone can't get a second trial
insert into auth.users (id,email) values ('00000000-0000-0000-0000-0000000000d1','again@example.test');
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000d1');
do $$ declare r jsonb; begin
  r := register_business(jsonb_build_object('name','Glow Salon 2','phone','9800000002','package_id',(select id from packages where slug='starter')));
  assert not (r->>'trial')::boolean, 'no second trial for the same phone';
  begin perform log_visit((r->>'business_id')::uuid,'9876500000','A',100,null); assert false; exception when others then assert sqlerrm like 'Your plan isn''t active yet%', sqlerrm; end;
end $$;
reset role;
-- confirming the salon's payment after an expired trial starts the month today
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ begin
  perform admin_confirm_payment((select p.id from payments p join businesses b on b.id=p.business_id where b.name='Glow Salon' and p.kind='subscription'), true);
  assert (select status from businesses where name='Glow Salon')='active';
  assert (select subscription_ends from businesses where name='Glow Salon') = (current_date + interval '1 month')::date, 'month starts today';
end $$;
reset role;
\echo '--- 10. keyword studio permissions'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare b uuid; n int; begin
  select id into b from businesses where name='Spice Route Cafe';
  -- cafe was paused in test 8: reopen as staff below, first check reads work
  select count(*) into n from category_keywords; assert n > 0, 'business can read agency suggestions';
  begin insert into category_keywords(category_id, keyword) values ((select id from categories limit 1), 'hack'); assert false; exception when insufficient_privilege then null; end;
end $$;
reset role;
update businesses set status='active' where name='Spice Route Cafe';
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare b uuid; n int; begin
  select id into b from businesses where name='Spice Route Cafe';
  insert into business_keywords(business_id, keyword, source) values (b, 'best cafe in Pune', 'suggested');
  begin insert into business_keywords(business_id, keyword) values (b, 'BEST CAFE IN PUNE'); assert false; exception when unique_violation then null; end;
  insert into business_content(business_id, kind, body) values (b, 'description', 'Spice Route Cafe is a cafe in Pune.');
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare n int; begin
  select count(*) into n from business_keywords; assert n=0, 'other business cannot see keywords';
  select count(*) into n from business_content; assert n=0, 'other business cannot see drafts';
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ declare n int; begin select count(*) into n from business_keywords; assert n=0, 'customer cannot see keywords'; end $$;
reset role;

\echo '--- 11. Google auto-reply tables: tokens hidden, reviews per business, reply mode'
reset role;
insert into gbp_connections(business_id, refresh_token, location_name, location_title)
  select id, 'secret-refresh-token', 'accounts/1/locations/2', 'Spice Route Cafe' from businesses where name='Spice Route Cafe';
insert into gbp_reviews(business_id, review_name, reviewer, stars, comment, status, draft)
  select id, 'accounts/1/locations/2/reviews/r1', 'Asha K', 5, 'Lovely chai', 'draft', 'Thank you Asha!' from businesses where name='Spice Route Cafe';
do $$ begin assert (select count(*) from internal_secrets where key='cron_secret' and length(value)=64)=1, 'cron secret generated'; end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare b uuid; j jsonb; n int; begin
  select id into b from businesses where name='Spice Route Cafe';
  begin perform 1 from gbp_connections; assert false; exception when insufficient_privilege then null; end;
  begin perform 1 from internal_secrets; assert false; exception when insufficient_privilege then null; end;
  begin perform 1 from oauth_states; assert false; exception when insufficient_privilege then null; end;
  j := gbp_status(b); assert (j->>'connected')::bool and j->>'location_title'='Spice Route Cafe' and not (j ? 'refresh_token'), 'status without token';
  select count(*) into n from gbp_reviews; assert n=1, 'owner sees own Google reviews';
  begin update gbp_reviews set status='posted'; get diagnostics n = row_count; assert n=0, 'owner cannot write reviews directly'; exception when insufficient_privilege then null; end;
  update businesses set gbp_reply_mode='all' where id=b;
  begin update businesses set gbp_reply_mode='spam' where id=b; assert false; exception when check_violation then null; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare n int; begin
  select count(*) into n from gbp_reviews; assert n=0, 'other business cannot see Google reviews';
  assert gbp_status((select id from businesses where name='Spice Route Cafe')) is null, 'other business gets no status';
end $$;
reset role;
set role anon; select pg_temp.as_user(null);
do $$ declare n int; begin
  select count(*) into n from gbp_reviews; assert n=0, 'anon sees no reviews';
  begin perform 1 from review_polish_usage; assert n=0; exception when insufficient_privilege then null; end;
  begin perform gbp_status((select id from businesses limit 1)); assert false; exception when insufficient_privilege then null; end;
end $$;
reset role;

update packages set modules = array(select distinct unnest(modules || '{attendance,menu}')) where slug='growth';
\echo '--- 12. Attendance: staff PINs hidden, self check-in/out, lockout, location fence, modules'
reset role;
update businesses set status='active', subscription_ends=current_date+30 where name='Spice Route Cafe';
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare b uuid; sid uuid; n int; begin
  select id into b from businesses where name='Spice Route Cafe';
  insert into staff (business_id, name, phone, pay_rate, shift_start, shift_end) values (b, 'Ravi', '919811100001', 15000, '10:00', '19:00') returning id into sid;
  perform set_staff_pin(sid, '4321');
  begin perform set_staff_pin(sid, '12'); assert false, 'short pin'; exception when raise_exception then null; end;
  begin perform pin_hash from staff; assert false, 'pin hash readable'; exception when insufficient_privilege then null; end;
  begin update staff set failed_pins = 0; assert false, 'lockout writable'; exception when insufficient_privilege then null; end;
  assert (select has_pin from staff_pin_status(b) where staff_id = sid), 'pin status';
  insert into att_settings (business_id) values (b);
end $$;
reset role;
select set_config('test.cafe', (select id::text from businesses where name='Spice Route Cafe'), false);
select set_config('test.slug', (select slug from businesses where name='Spice Route Cafe'), false);
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  assert (select count(*) from staff) = 0, 'other business cannot see staff';
  begin insert into staff (business_id, name) values (current_setting('test.cafe')::uuid, 'X'); assert false, 'cross insert'; exception when insufficient_privilege or check_violation then null; end;
end $$;
reset role;
set role anon; select pg_temp.as_user(null);
do $$ declare s text; j jsonb; i int; begin
  s := current_setting('test.slug');
  assert staff_punch(s, '9811100001', '0000')->>'error' like 'Phone number or PIN%', 'wrong pin';
  j := staff_punch(s, '98111 00001', '4321'); assert j->>'action' = 'in', j::text;
  begin perform staff_punch(s, '9811100001', '4321'); assert false, 'double punch'; exception when raise_exception then assert sqlerrm like 'You already checked in%', sqlerrm; end;
end $$;
reset role;
update attendance set check_in = now() - interval '9 hours';
set role anon; select pg_temp.as_user(null);
do $$ declare s text; j jsonb; begin
  s := current_setting('test.slug');
  j := staff_punch(s, '9811100001', '4321'); assert j->>'action' = 'out', j::text;
  begin perform staff_punch(s, '9811100001', '4321'); assert false; exception when raise_exception then assert sqlerrm like 'You already checked out%', sqlerrm; end;
  for i in 1..5 loop perform staff_punch(s, '9811100001', '9999'); end loop;
  assert staff_punch(s, '9811100001', '4321')->>'error' like 'Too many wrong PINs%', 'should be locked even with the right PIN';
end $$;
reset role;
update staff set locked_until = null, failed_pins = 0; delete from attendance;
update att_settings set geo_on = true, geo_lat = 18.5204, geo_lng = 73.8567, geo_radius = 150;
set role anon; select pg_temp.as_user(null);
do $$ declare s text; begin
  s := current_setting('test.slug');
  begin perform staff_punch(s, '9811100001', '4321'); assert false, 'needs location'; exception when raise_exception then assert sqlerrm like 'Turn on location%', sqlerrm; end;
  begin perform staff_punch(s, '9811100001', '4321', 18.60, 73.90); assert false, 'too far'; exception when raise_exception then assert sqlerrm like 'You seem to be%', sqlerrm; end;
  assert (staff_punch(s, '9811100001', '4321', 18.5206, 73.8568))->>'action' = 'in', 'near shop ok';
end $$;
reset role;
update packages set modules = '{menu}' where id = (select package_id from businesses where name='Spice Route Cafe');
set role anon; select pg_temp.as_user(null);
do $$ declare s text; begin
  s := current_setting('test.slug');
  begin perform staff_punch(s, '9811100001', '4321', 18.5206, 73.8568); assert false, 'module off'; exception when raise_exception then assert sqlerrm like 'Attendance is not available%', sqlerrm; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin insert into holidays (business_id, day) select id, current_date from businesses where name='Spice Route Cafe'; assert false, 'module off blocks writes'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update packages set modules = '{reviews,customers,loyalty,campaigns,seo,google_replies,attendance,menu}' where slug in ('growth','pro');

\echo '--- 13. QR menu: public menu, server-side prices, sold out, order tokens, privacy'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare b uuid; c uuid; begin
  select id into b from businesses where name='Spice Route Cafe';
  insert into menu_categories (business_id, name) values (b, 'Chai') returning id into c;
  insert into menu_items (business_id, category_id, name, price) values (b, c, 'Masala chai', 30), (b, c, 'Bun maska', 40);
  insert into menu_items (business_id, category_id, name, price, available) values (b, c, 'Kesar chai', 60, false);
  insert into dining_tables (business_id, label) values (b, 'T1');
end $$;
reset role;
select set_config('test.t', (select id::text from dining_tables limit 1), false), set_config('test.chai', (select id::text from menu_items where name='Masala chai'), false),
       set_config('test.bun', (select id::text from menu_items where name='Bun maska'), false), set_config('test.kesar', (select id::text from menu_items where name='Kesar chai'), false);
set role anon; select pg_temp.as_user(null);
do $$ declare s text; m jsonb; t uuid; o jsonb; chai uuid; bun uuid; kesar uuid; st jsonb; begin
  s := current_setting('test.slug'); t := current_setting('test.t'); chai := current_setting('test.chai'); bun := current_setting('test.bun'); kesar := current_setting('test.kesar');
  m := public_menu(s, t);
  assert m->'table'->>'label' = 'T1' and jsonb_array_length(m->'items') = 3, m::text;
  o := place_order(s, t, jsonb_build_array(jsonb_build_object('id', chai, 'qty', 2, 'price', 1), jsonb_build_object('id', bun, 'qty', 1)), 'Neha', '98765 43210', 'less sugar');
  assert (o->>'total')::numeric = 100, 'total from server prices: ' || o::text;
  st := order_status((o->>'id')::uuid, o->>'token'); assert st->>'status' = 'new' and jsonb_array_length(st->'items') = 2, st::text;
  assert order_status((o->>'id')::uuid, 'wrong') is null, 'token needed';
  begin perform place_order(s, t, jsonb_build_array(jsonb_build_object('id', kesar, 'qty', 1))); assert false, 'sold out'; exception when raise_exception then assert sqlerrm like '%sold out%', sqlerrm; end;
  begin perform place_order(s, t, '[]'::jsonb); assert false, 'empty'; exception when raise_exception then null; end;
  begin insert into orders (business_id, order_no, token) select id, 1, 'x' from businesses limit 1; assert false, 'direct insert'; exception when insufficient_privilege then null; end;
  assert (select count(*) from orders) = 0 and (select count(*) from order_items) = 0, 'anon reads orders';
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin assert (select count(*) from orders) = 0, 'other business sees orders'; assert (select count(*) from menu_items) = 0, 'other business sees menu'; end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare n int; begin
  update orders set status = 'preparing'; get diagnostics n = row_count; assert n = 1, 'owner moves status';
  begin update orders set total = 0; assert false, 'total locked'; exception when insufficient_privilege then null; end;
  insert into menu_settings (business_id, ordering_on) select id, false from businesses where name='Spice Route Cafe';
end $$;
reset role;
set role anon; select pg_temp.as_user(null);
do $$ declare s text; chai uuid; begin
  s := current_setting('test.slug'); chai := current_setting('test.chai');
  begin perform place_order(s, null, jsonb_build_array(jsonb_build_object('id', chai, 'qty', 1))); assert false, 'ordering off'; exception when raise_exception then assert sqlerrm like 'Ordering from the table is switched off%', sqlerrm; end;
end $$;
reset role;
\echo '--- 14. Plans & modules: gating, add-on purchase, renewal with add-ons, trial unlocks all'
update packages set modules = '{reviews,customers,loyalty,campaigns,seo}' where slug='growth';
update packages set modules = '{reviews,customers}' where slug='starter';
update businesses set status='active', subscription_ends=current_date+20, package_id=(select id from packages where slug='starter'), billing='monthly', addon_modules='{}'
 where id = (select business_id from business_members where user_id='00000000-0000-0000-0000-0000000000b1' limit 1);
select set_config('test.glow', (select business_id::text from business_members where user_id='00000000-0000-0000-0000-0000000000b1' limit 1), false);
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); r jsonb; begin
  assert has_module(b,'reviews') and has_module(b,'customers'), 'core modules always on';
  assert not has_module(b,'loyalty') and not has_module(b,'attendance'), 'starter has no loyalty/attendance';
  begin insert into coupons (business_id, code, type, value) values (b, 'X10', 'percent', 10); assert false, 'coupon without loyalty'; exception when insufficient_privilege then null; end;
  begin perform save_loyalty(b, '{"stamps":8}'); assert false, 'loyalty save blocked'; exception when raise_exception then assert sqlerrm like 'Loyalty card isn%', sqlerrm; end;
  assert not (preview_visit(b, '9811122233', 500, null)->>'loyalty_enabled')::boolean, 'no stamps without module';
  r := create_order(b, 'module', (select id from modules where key='attendance'), null);
  assert (r->>'amount')::numeric = 199 and r->>'description' like 'Add-on: Staff attendance%', r::text;
  begin perform create_order(b, 'module', (select id from modules where key='attendance'), null); assert false, 'duplicate pending'; exception when raise_exception then null; end;
  begin perform create_order(b, 'module', (select id from modules where key='reviews'), null); assert false, 'core not sold'; exception when raise_exception then null; end;
  begin update businesses set addon_modules = '{menu}' where id = b; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin assert (select addon_modules from businesses where id = current_setting('test.glow')::uuid) = '{}', 'owner cannot grant add-ons'; end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ declare b uuid := current_setting('test.glow'); begin
  perform admin_confirm_payment((select id from payments where business_id = b and kind='module' and status='pending'), true);
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); r jsonb; begin
  assert has_module(b,'attendance'), 'add-on switched on after payment';
  r := create_order(b, 'subscription', (select id from packages where slug='starter'), 'monthly');
  assert (r->>'amount')::numeric = 299 + 199 and r->>'description' like '%add-ons: Staff attendance%', 'renewal includes add-on: ' || r::text;
  r := create_order(b, 'subscription', (select id from packages where slug='pro'), 'yearly');
  assert (r->>'amount')::numeric = 8990, 'pro already has attendance: ' || r::text;
  perform set_config('test.propay', r->>'payment_id', false);
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
do $$ begin perform admin_confirm_payment(current_setting('test.propay')::uuid, true); end $$;
reset role;
do $$ declare b uuid := current_setting('test.glow'); begin
  assert (select addon_modules from businesses where id = b) = '{}', 'pro covers the add-on';
  assert has_module(b,'menu') and has_module(b,'google_replies'), 'pro has everything';
  update businesses set status='trial', package_id=(select id from packages where slug='starter') where id = b;
  assert has_module(b,'google_replies') and has_module(b,'loyalty'), 'trial unlocks every module';
end $$;
set role anon; select pg_temp.as_user(null);
do $$ begin assert (select count(*) from modules) >= 8, 'store can read modules';
  begin perform has_module(gen_random_uuid(),'menu'); assert false, 'anon cannot call has_module'; exception when insufficient_privilege then null; end; end $$;
reset role;
\echo '--- 15. Razorpay: only the service role can mark paid; order and amount must match'
update packages set modules = '{reviews,customers}' where slug='starter';
update businesses set status='active', package_id=(select id from packages where slug='starter'), addon_modules='{}' where id = current_setting('test.glow')::uuid;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); r jsonb; begin
  r := create_order(b, 'module', (select id from modules where key='menu'), null);
  perform set_config('test.rzp', r->>'payment_id', false);
  begin perform razorpay_paid((r->>'payment_id')::uuid, 'order_x', 'pay_x', 19900); assert false, 'browser cannot mark paid'; exception when insufficient_privilege then null; end;
  begin perform apply_payment((r->>'payment_id')::uuid, true, null); assert false, 'browser cannot apply'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update payments set meta = meta || '{"rzp_order":"order_ok"}' where id = current_setting('test.rzp')::uuid;
set role service_role;
do $$ declare p uuid := current_setting('test.rzp'); r jsonb; begin
  begin perform razorpay_paid(p, 'order_other', 'pay_1', 19900); assert false, 'wrong order'; exception when raise_exception then null; end;
  begin perform razorpay_paid(p, 'order_ok', 'pay_1', 100); assert false, 'wrong amount'; exception when raise_exception then null; end;
  r := razorpay_paid(p, 'order_ok', 'pay_1', round((select total from payments where id = p) * 100)::bigint);
  assert (r->>'ok')::boolean, r::text;
  r := razorpay_paid(p, 'order_ok', 'pay_1', 0); assert (r->>'already')::boolean, 'webhook + verify both arrive';
end $$;
reset role;
do $$ begin assert has_module(current_setting('test.glow')::uuid, 'menu'), 'razorpay payment switched add-on on';
  assert (select status from payments where id = current_setting('test.rzp')::uuid) = 'confirmed'; end $$;
\echo '--- 16. Automatic reminders: due lists respect days/times/gap; template submissions are Pro-only and private'
do $$ declare b uuid := current_setting('test.glow'); c1 uuid; c2 uuid; begin
  delete from customers where business_id = b;
  insert into customers (business_id, name, phone, birthday, last_visit, stamps) values
    (b, 'Asha Rao', '919811000001', (now() at time zone 'Asia/Kolkata')::date + 3 - interval '30 years', now() - interval '40 days', 4) returning id into c1;
  insert into customers (business_id, name, phone, last_visit, stamps) values (b, 'Ravi K', '919811000002', now() - interval '2 days', 1) returning id into c2;
  insert into auto_msgs (business_id, kind, enabled, days, times, gap_days, offer) values
    (b, 'birthday', true, 3, 1, 3, '20% off'), (b, 'win_back', true, 30, 2, 7, 'a free coffee'), (b, 'loyalty', true, 7, 1, 3, ''), (b, 'offer_expiry', false, 3, 2, 2, '');
  insert into coupons (business_id, code, type, value, expiry, show_to_customers) values (b, 'BYE10', 'percent', 10, (now() at time zone 'Asia/Kolkata')::date + 2, true);
end $$;
set role service_role;
do $$ declare b uuid := current_setting('test.glow'); r record; n int; begin
  select count(*) into n from due_auto_msgs(b, 'birthday'); assert n = 1, 'birthday in 3 days: ' || n;
  select * into r from due_auto_msgs(b, 'win_back'); assert r.name = 'Asha Rao' and r.n = 1 and r.params[2] = 'a free coffee', 'win back 30+ days';
  select count(*) into n from due_auto_msgs(b, 'win_back'); assert n = 1, 'recent visitor not in win-back';
  select count(*) into n from due_auto_msgs(b, 'offer_expiry'); assert n = 0, 'disabled rule sends nothing';
  insert into auto_msg_log (business_id, kind, customer_id, ref, n, status) select b, 'win_back', customer_id, ref, 1, 'sent' from due_auto_msgs(b, 'win_back');
  select count(*) into n from due_auto_msgs(b, 'win_back'); assert n = 0, 'gap days respected';
  update auto_msg_log set created_at = now() - interval '8 days' where kind = 'win_back';
  select * into r from due_auto_msgs(b, 'win_back'); assert r.n = 2, 'second reminder after gap';
  insert into auto_msg_log (business_id, kind, customer_id, ref, n, status) values (b, 'win_back', r.customer_id, r.ref, 2, 'sent');
  update auto_msg_log set created_at = now() - interval '30 days' where kind = 'win_back';
  select count(*) into n from due_auto_msgs(b, 'win_back'); assert n = 0, 'stops after times';
  update auto_msgs set enabled = true where business_id = b and kind = 'offer_expiry';
  select count(*) into n from due_auto_msgs(b, 'offer_expiry'); assert n = 2, 'offer ending goes to customers seen in 120 days: ' || n;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); r jsonb; begin
  begin perform due_auto_msgs(b, 'birthday'); assert false, 'browser cannot list due customers'; exception when insufficient_privilege then null; end;
  r := auto_msgs_preview(b); assert (r->>'birthday')::int = 1, r::text;
  begin perform submit_wa_template(b, '{"title":"Diwali","body":"Hi {{1}}, Diwali offer: {{2}}","params":["Offer"]}'); assert false, 'starter cannot submit'; exception when raise_exception then assert sqlerrm like '%Pro plan%', sqlerrm; end;
end $$;
reset role;
update packages set modules = array(select distinct unnest(modules || '{bulk_whatsapp}')) where slug='pro';
update businesses set package_id = (select id from packages where slug='pro') where id = current_setting('test.glow')::uuid;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); r jsonb; begin
  begin perform submit_wa_template(b, '{"title":"Diwali","body":"Hello there, Diwali offer: {{2}}","params":["Offer"]}'); assert false, 'needs {{1}}'; exception when raise_exception then null; end;
  begin perform submit_wa_template(b, '{"title":"Diwali","body":"Hi {{1}}, Diwali offer: {{2}} till {{3}}","params":["Offer"]}'); assert false, 'labels needed'; exception when raise_exception then null; end;
  r := submit_wa_template(b, '{"title":"Diwali offer","body":"Hi {{1}}, Diwali offer at our salon: {{2}}","params":["Offer"],"sample":["20% off"]}');
  assert (select status from wa_templates where id = (r->>'id')::uuid) = 'pending', 'pending after submit';
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin assert (select count(*) from wa_templates where business_id is not null) = 0, 'other business cannot see private templates'; end $$;
reset role;

\echo '--- 17. Loyalty card link: public card by token only, scan lookup needs access'
set role anon; select pg_temp.as_user(null);
do $$ declare t text; r jsonb; begin
  -- anon can't read customers, but the card works with the token
  assert (select count(*) from customers) = 0, 'anon sees no customers';
end $$;
reset role;
do $$ declare t text; begin select card_token into t from customers where business_id = current_setting('test.glow')::uuid and name = 'Asha Rao'; perform set_config('test.tok', t, false); end $$;
set role anon; select pg_temp.as_user(null);
do $$ declare r jsonb; begin
  r := public_card(current_setting('test.tok'));
  assert r->'customer'->>'name' = 'Asha', 'first name only: ' || (r->'customer')::text;
  assert r->'business'->>'name' = 'Glow Salon', 'business shown';
  assert not (r->'customer' ? 'phone'), 'no phone on public card';
  assert public_card('nope') is null and public_card(left(current_setting('test.tok'), 10)) is null, 'bad token gives nothing';
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin assert card_lookup(current_setting('test.glow')::uuid, current_setting('test.tok')) is null, 'other business cannot look up card'; end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ begin assert card_lookup(current_setting('test.glow')::uuid, current_setting('test.tok'))->>'name' = 'Asha Rao', 'owner looks up card'; end $$;
reset role;

\echo '--- 18. Team: invites, admin/staff roles, per-area access'
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'manager@example.test'), ('00000000-0000-0000-0000-0000000000e2', 'cashier@example.test');
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); r jsonb; begin
  r := team_save(b, 'Manager@Example.test', 'admin', null); assert r->>'status' = 'added', 'existing user added: ' || r::text;
  r := team_save(b, 'cashier@example.test', 'staff', '{customers,bogus}'); assert r->>'status' = 'added';
  assert (select perms from business_members where user_id = '00000000-0000-0000-0000-0000000000e2') = '{customers}', 'unknown areas dropped';
  r := team_save(b, 'newcook@example.test', 'staff', '{menu,attendance}'); assert r->>'status' = 'invited';
  begin perform team_save(b, 'x@example.test', 'staff', '{}'); assert false; exception when raise_exception then assert sqlerrm like 'Choose at least%'; end;
  r := team_list(b); assert jsonb_array_length(r->'members') = 3 and jsonb_array_length(r->'invites') = 1, r::text;
end $$;
reset role;
-- the cashier: customers only
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
do $$ declare b uuid := current_setting('test.glow'); n int; begin
  assert my_role() = 'business', 'invited user becomes business role';
  select count(*) into n from customers where business_id = b; assert n > 0, 'cashier sees customers';
  perform log_visit(b, '9811111111', 'Walk In', 300, null);
  select count(*) into n from staff where business_id = b; assert n = 0, 'cashier cannot see staff/salaries';
  select count(*) into n from payments where business_id = b; assert n = 0, 'cashier cannot see billing';
  begin perform team_list(b); assert false; exception when raise_exception then null; end;
  begin perform acc_post(b, '{}'); assert false; exception when raise_exception then assert sqlerrm like 'Accounts are locked%', sqlerrm; end;
  update businesses set city = 'Hacked' where id = b; assert (select city from businesses where id = b) is distinct from 'Hacked', 'cashier cannot edit profile';
  begin perform team_save(b, 'evil@example.test', 'admin', null); assert false; exception when raise_exception then null; end;
end $$;
reset role;
-- the admin can do everything except add admins
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
do $$ declare b uuid := current_setting('test.glow'); begin
  assert can_area(b, 'accounts') and can_area(b, 'settings'), 'admin has all areas';
  begin perform team_save(b, 'second@example.test', 'admin', null); assert false; exception when raise_exception then assert sqlerrm like 'Only the owner%'; end;
  begin perform team_remove(b, '00000000-0000-0000-0000-0000000000b1'); assert false; exception when raise_exception then assert sqlerrm like '%owner can''t%'; end;
  perform team_save(b, 'cashier@example.test', 'staff', '{customers,attendance}');
end $$;
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e3', 'newcook@example.test');
insert into profiles (id, role, email) values ('00000000-0000-0000-0000-0000000000e3', 'customer', 'newcook@example.test') on conflict (id) do nothing;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000e3');
do $$ declare b uuid := current_setting('test.glow'); begin
  assert claim_invites() = 1, 'invite claimed';
  assert has_perm(b, 'menu') and has_perm(b, 'attendance') and not has_perm(b, 'customers'), 'perms from invite';
  begin perform log_visit(b, '9822222222', 'X', 100, null); assert false, 'cook cannot log visits'; exception when others then null; end;
end $$;
reset role;

update packages set modules = modules || '{accounting}' where slug = 'pro' and not ('accounting' = any(modules));
create function pg_temp.sys(b uuid, k text) returns uuid language sql stable as $$ select id from public.acc_heads where business_id = b and system_key = k $$;
grant execute on function pg_temp.sys(uuid, text) to authenticated;
\echo '--- 19. Staff advances: instalments, skip a month, recovery in accounts'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); s uuid; a uuid; m date := date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date; n numeric; r jsonb; begin
  insert into staff (business_id, name, phone, pay_rate) values (b, 'Ravi', '9833333333', 15000) returning id into s;
  a := advance_give(b, jsonb_build_object('staff_id', s, 'amount', 5000, 'monthly_cut', 2000, 'start_month', (m - interval '1 month')::date, 'paid_from', 'cash'));
  assert advance_sync(b, (m - interval '1 month')::date) = 1, 'last month cut added';
  assert advance_sync(b, (m - interval '1 month')::date) = 0, 'only once per month';
  perform advance_skip(b, a, m, true);
  assert advance_sync(b, m) = 0, 'skipped month has no cut';
  perform advance_skip(b, a, m, false);
  assert advance_sync(b, m) = 1, 'unskipped month gets cut';
  select sum(amount) into n from salary_adjustments where advance_id = a; assert n = 4000, 'two cuts of 2000: ' || n;
  assert advance_sync(b, (m + interval '1 month')::date) = 0, 'no cuts for future months';
  r := advance_list(b); assert (r->0->>'recovered')::numeric = 4000, r::text;
  -- accounts: the advance came out of cash into Staff advances
  r := acc_balances(b, '2000-01-01', current_date + 400);
  assert (select (x->>'c_dr')::numeric from jsonb_array_elements(r) x where x->>'system_key' = 'staff_adv') = 5000, 'advance in accounts';
  assert (select (x->>'c_cr')::numeric from jsonb_array_elements(r) x where x->>'system_key' = 'cash') = 5000, 'paid from cash';
  -- salary paid this month with 2000 recovered: expense = net + recovered
  insert into salary_slips (business_id, staff_id, month, data, net, paid, paid_on) values (b, s, m, '{}', 13000, true, current_date);
  assert acc_import_salary(b, m, current_date, pg_temp.sys(b, 'bank')) = 1;
  r := acc_balances(b, m, current_date);
  assert (select (x->>'p_dr')::numeric from jsonb_array_elements(r) x where x->>'system_key' = 'salary') = 15000, 'salary expense gross';
  assert (select (x->>'c_cr')::numeric from jsonb_array_elements(r) x where x->>'system_key' = 'staff_adv') = 2000, 'advance reduced by recovery';
  begin perform advance_delete(b, a); assert false; exception when raise_exception then assert sqlerrm like 'Part of this advance%'; end;
  assert acc_import_salary(b, m, current_date, pg_temp.sys(b, 'bank')) = 1 and (select count(*) from acc_vouchers where business_id = b and source = 'salary') = 1, 're-import updates';
end $$;
reset role;

\echo '--- 20. Accounts: balanced entries, GST split, P&L and balance sheet tie out'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); v uuid; r jsonb; cap uuid; inc numeric; exp numeric; ast numeric; lia numeric; eq numeric; begin
  perform acc_setup(b); perform acc_setup(b);
  assert (select count(*) from acc_heads where business_id = b and system_key = 'cash') = 1, 'setup is idempotent';
  perform acc_post(b, jsonb_build_object('entry', 'opening', 'head_id', pg_temp.sys(b, 'bank'), 'amount', 100000, 'date', '2026-04-01'));
  perform acc_post(b, jsonb_build_object('entry', 'income', 'head_id', pg_temp.sys(b, 'sales'), 'money_id', pg_temp.sys(b, 'bank'), 'amount', 10000, 'gst_rate', 18, 'party', 'Acme', 'gstin', '27abcde1234f1z5'));
  perform acc_post(b, jsonb_build_object('entry', 'income', 'head_id', pg_temp.sys(b, 'sales'), 'money_id', pg_temp.sys(b, 'debtors'), 'amount', 2000, 'gst_rate', 5, 'igst', true));
  v := acc_post(b, jsonb_build_object('entry', 'expense', 'head_id', (select id from acc_heads where business_id = b and name = 'Rent'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 3000));
  perform acc_post(b, jsonb_build_object('entry', 'expense', 'head_id', pg_temp.sys(b, 'purchases'), 'money_id', pg_temp.sys(b, 'creditors'), 'amount', 4000, 'gst_rate', 5));
  perform acc_post(b, jsonb_build_object('entry', 'asset', 'head_id', (select id from acc_heads where business_id = b and name = 'Equipment & machinery'), 'money_id', pg_temp.sys(b, 'bank'), 'amount', 20000, 'gst_rate', 18));
  perform acc_post(b, jsonb_build_object('entry', 'loan_in', 'head_id', (select id from acc_heads where business_id = b and name = 'Loans'), 'money_id', pg_temp.sys(b, 'bank'), 'amount', 50000));
  perform acc_post(b, jsonb_build_object('entry', 'transfer', 'head_id', pg_temp.sys(b, 'bank'), 'money_id', pg_temp.sys(b, 'debtors'), 'amount', 2100));
  perform acc_post(b, jsonb_build_object('entry', 'drawings', 'head_id', pg_temp.sys(b, 'drawings'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 1000));
  begin perform acc_post(b, jsonb_build_object('entry', 'expense', 'head_id', pg_temp.sys(b, 'sales'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 10)); assert false; exception when raise_exception then assert sqlerrm like 'Choose an expense%'; end;
  begin perform acc_post(b, jsonb_build_object('entry', 'expense', 'head_id', pg_temp.sys(b, 'salary'), 'money_id', pg_temp.sys(b, 'salary'), 'amount', 10)); assert false; exception when raise_exception then null; end;
  -- edit keeps the number
  perform acc_post(b, jsonb_build_object('id', v, 'entry', 'expense', 'head_id', (select id from acc_heads where business_id = b and name = 'Rent'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 3500));
  assert (select total from acc_vouchers where id = v) = 3500, 'edited';
  -- automatic entries can't be edited as manual
  begin perform acc_post(b, jsonb_build_object('id', (select id from acc_vouchers where business_id = b and source = 'salary' limit 1), 'entry', 'expense', 'head_id', pg_temp.sys(b, 'salary'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 1)); assert false;
  exception when raise_exception then assert sqlerrm like '%automatically%'; end;
  assert (select sum(dr) - sum(cr) from acc_lines where business_id = b) = 0, 'books balance';
  assert (select cr from acc_lines l join acc_heads h on h.id = l.head_id where h.system_key = 'gst_out_c' and l.business_id = b) = 900, 'CGST half of 1800';
  assert (select sum(cr) from acc_lines l join acc_heads h on h.id = l.head_id where h.system_key = 'gst_out_i' and l.business_id = b) = 100, 'IGST full';
  -- statement totals from balances
  r := acc_balances(b, '2000-01-01', current_date + 400);
  select sum((x->>'c_cr')::numeric - (x->>'c_dr')::numeric) filter (where x->>'kind' = 'income'), sum((x->>'c_dr')::numeric - (x->>'c_cr')::numeric) filter (where x->>'kind' = 'expense'),
         sum((x->>'c_dr')::numeric - (x->>'c_cr')::numeric) filter (where x->>'kind' = 'asset'), sum((x->>'c_cr')::numeric - (x->>'c_dr')::numeric) filter (where x->>'kind' = 'liability'),
         sum((x->>'c_cr')::numeric - (x->>'c_dr')::numeric) filter (where x->>'kind' = 'equity')
    into inc, exp, ast, lia, eq from jsonb_array_elements(r) x;
  assert ast = lia + eq + (inc - exp), format('balance sheet ties: assets %s = liab %s + equity %s + profit %s', ast, lia, eq, inc - exp);
  -- visits import is idempotent
  perform acc_import_visits(b, current_date - 30, current_date + 1, pg_temp.sys(b, 'cash'), 5, true);
  perform acc_import_visits(b, current_date - 30, current_date + 1, pg_temp.sys(b, 'cash'), 5, true);
  assert (select count(*) from acc_vouchers where business_id = b and source = 'visits') = (select count(distinct (created_at at time zone 'Asia/Kolkata')::date) from visits where business_id = b and created_at > now() - interval '31 days' and net > 0), 'one per day';
end $$;
reset role;
-- the cashier (customers + attendance) can't read the books; the admin can
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
do $$ begin assert (select count(*) from acc_vouchers) = 0 and (select count(*) from acc_heads) = 0, 'cashier cannot read accounts';
  begin perform acc_balances(current_setting('test.glow')::uuid, current_date, current_date); assert false; exception when raise_exception then null; end; end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000e1');
do $$ begin assert (select count(*) from acc_vouchers) > 5, 'admin reads accounts'; end $$;
reset role;

\echo '--- 21. Expense bills and admin-only categories'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
do $$ declare b uuid := current_setting('test.glow'); v uuid; begin
  perform team_save(b, 'cashier@example.test', 'staff', '{customers,accounts}');
  v := acc_post(b, jsonb_build_object('entry', 'expense', 'head_id', (select id from acc_heads where business_id = b and name = 'Rent'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 900, 'bill_path', b::text || '/rent-nov.pdf'));
  assert (select bill_path from acc_vouchers where id = v) = b::text || '/rent-nov.pdf', 'bill saved';
  perform acc_post(b, jsonb_build_object('id', v, 'entry', 'expense', 'head_id', (select id from acc_heads where business_id = b and name = 'Rent'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 950));
  assert (select bill_path from acc_vouchers where id = v) = b::text || '/rent-nov.pdf', 'bill kept on edit';
  perform acc_post(b, jsonb_build_object('id', v, 'entry', 'expense', 'head_id', (select id from acc_heads where business_id = b and name = 'Rent'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 950, 'bill_path', null));
  assert (select bill_path from acc_vouchers where id = v) is null, 'bill removed';
  begin perform acc_post(b, jsonb_build_object('entry', 'expense', 'head_id', (select id from acc_heads where business_id = b and name = 'Rent'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 1, 'bill_path', gen_random_uuid()::text || '/x.pdf')); assert false;
  exception when raise_exception then assert sqlerrm like 'Bill file%'; end;
  perform acc_head_save(b, '{"name":"Gas cylinders","kind":"expense","class":"direct"}');
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000e2');
do $$ declare b uuid := current_setting('test.glow'); begin
  begin perform acc_head_save(b, '{"name":"Snacks","kind":"expense","class":"operating"}'); assert false; exception when raise_exception then assert sqlerrm like 'Only the owner or an admin%', sqlerrm; end;
  begin update acc_heads set name = 'Hacked' where business_id = b and name = 'Rent'; assert false; exception when insufficient_privilege then null; end;
  perform acc_post(b, jsonb_build_object('entry', 'expense', 'head_id', (select id from acc_heads where business_id = b and name = 'Gas cylinders'), 'money_id', pg_temp.sys(b, 'cash'), 'amount', 1100));
end $$;
reset role;

\echo '--- 22. Credit types, margin limits, Meta balance'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
do $$ declare b uuid; r jsonb; begin
  select id into b from businesses where name='Spice Route Cafe';
  perform admin_adjust_credits(b, 200, 'test utility', 'utility');
  assert (select utility_balance from wa_wallets where business_id=b)=200 and (select balance from wa_wallets where business_id=b)=60, 'utility added separately';
  -- margins: below 20% and above 40% are rejected
  begin insert into wa_credit_packs(name,credits,price,kind) values ('Too cheap',1000,1100,'marketing'); assert false; exception when others then assert sqlerrm like '%margin%', sqlerrm; end;
  begin insert into wa_credit_packs(name,credits,price,kind) values ('Too dear',1000,250,'utility'); assert false; exception when others then assert sqlerrm like '%margin%', sqlerrm; end;
  insert into wa_credit_packs(name,credits,price,kind) values ('OK utility',1000,170,'utility');
  for r in select to_jsonb(p) from wa_credit_packs p where active loop
    assert (r->>'price')::numeric/(r->>'credits')::numeric between meta_cost(r->>'kind')*1.2 - 0.0001 and meta_cost(r->>'kind')*1.4 + 0.0001, 'pack '||(r->>'name')||' within margin';
  end loop;
  insert into meta_recharges(amount, paid_on, note) values (1000, current_date, 'test');
  r := wa_admin_summary();
  assert (r->'held'->>'utility')::int >= 200, 'summary shows pending utility credits';
  assert (r->>'recharged')::numeric >= 1000, 'summary sums recharges';
end $$;
reset role;
set role service_role;
do $$ declare b uuid; ok boolean; begin
  select id into b from businesses where name='Spice Route Cafe';
  ok := wa_reserve(b, 5, 'test', 'utility'); assert ok;
  assert (select utility_balance from wa_wallets where business_id=b)=195 and (select balance from wa_wallets where business_id=b)=60, 'utility send uses utility credits only';
  perform wa_refund(b, 5, 'test', 'utility');
  assert (select utility_balance from wa_wallets where business_id=b)=200;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin perform wa_admin_summary(); assert false; exception when others then null; end;
  assert (select count(*) from meta_recharges)=0, 'businesses cannot see Meta recharges';
end $$;
reset role;
\echo 'ALL TESTS PASSED'
