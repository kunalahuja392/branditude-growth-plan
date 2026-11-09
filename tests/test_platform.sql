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
  assert (q->>'subtotal')::numeric = 2499*0.8 + 4999, 'quote: growth -20% + zomato = '||(q->>'subtotal');
  assert (q->>'gst')::numeric = round((2499*0.8+4999)*0.18,2), 'gst 18%';
  raise notice 'lead ok: % total %', q->>'ref', q->>'total';
  -- a salon cannot buy the Zomato product: it is silently excluded from the quote
  q := quote((select id from packages where slug='starter'),'monthly', array[(select id from products where name='Zomato & Swiggy listing optimisation')], null, (select id from categories where slug='salon-spa'));
  assert (q->>'subtotal')::numeric = 999, 'category filter on products';
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
  assert (r->>'total')::numeric = 599*1.18;
  begin r := create_order(b,'product',(select id from products where name='Property lead ads'),null); assert false; exception when others then assert sqlerrm like 'Service not available%'; end;
  r := create_order(b,'product',(select id from products where name='Digital QR menu'),null);
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
update packages set modules = '{attendance,menu}';

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
\echo 'ALL TESTS PASSED'
