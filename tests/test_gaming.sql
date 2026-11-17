\set ON_ERROR_STOP 1
\set QUIET 1
-- Gaming clubs module tests. Run after the migrations on a fresh database:
--   psql -d bgp -f tests/test_gaming.sql      (ends with "GAMING TESTS PASSED")
insert into auth.users (id,email,phone,raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000009d1','club@example.test',null,'{"full_name":"Rohan Club"}'),
 ('00000000-0000-0000-0000-0000000009d2','desk@example.test',null,'{"full_name":"Desk Staff"}'),
 ('00000000-0000-0000-0000-0000000009e1','other@example.test',null,'{"full_name":"Salon Owner"}');
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;

\echo '--- 1. store: gaming plans only for gaming clubs'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009e1');
do $$ begin
  begin
    perform register_business(jsonb_build_object('name','Glow Salon 2','phone','9811111111','category_id',(select id from categories where slug='salon-spa'),'package_id',(select id from packages where slug='game-club')));
    assert false, 'salon must not get a gaming plan';
  exception when others then assert sqlerrm like 'This plan is only for Gaming Club%', sqlerrm; end;
  perform register_business(jsonb_build_object('name','Glow Salon 2','phone','9811111111','category_id',(select id from categories where slug='salon-spa'),'package_id',(select id from packages where slug='starter')));
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare r jsonb; begin
  r := register_business(jsonb_build_object('name','Level Up Gaming','contact_name','Rohan','phone','9822222222','city','Jaipur',
        'category_id',(select id from categories where slug='gaming-club'),'package_id',(select id from packages where slug='game-club')));
end $$;
reset role;
-- plan paid: active Game Club plan (no WhatsApp add-on yet); trial expiry handled by existing tests
update businesses set status='active', subscription_ends=current_date+30, wa_enabled=true where slug like 'level-up-gaming%';
update businesses set status='active', subscription_ends=current_date+30 where name='Glow Salon 2';
insert into business_members (business_id,user_id,role,perms) select id,'00000000-0000-0000-0000-0000000009d2','staff','{gaming}' from businesses where slug like 'level-up-gaming%';

\echo '--- 2. owner sets up stations, pricing rules, snacks; staff cannot'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid; begin
  select id into b from businesses where slug like 'level-up-gaming%';
  insert into gc_stations (business_id,name,type,rate,included_players,extra_player_rate,sort) values
    (b,'PS5 #1','PS5',120,2,30,1),(b,'PS5 #2','PS5',120,2,30,2),(b,'PC #1','PC',60,1,0,3);
  insert into gc_products (business_id,name,price,stock) values (b,'Coke',40,10),(b,'Maggi',60,2);
  perform gc_board(b);
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid; n int; begin
  select id into b from businesses where slug like 'level-up-gaming%';
  begin insert into gc_stations (business_id,name,rate) values (b,'Hack',1); assert false, 'staff cannot add stations';
  exception when insufficient_privilege then null; end;
  select count(*) into n from gc_stations; assert n=3, 'staff sees stations';
  select count(*) into n from customers; assert n=0, 'gaming-only staff does not see the customer list';
end $$;
reset role;

\echo '--- 3. LP match: split after 23 min on Player 1, last game at billing, per-player bill'
do $$ declare b uuid; s uuid; begin
  select id into b from businesses where slug like 'level-up-gaming%';
  perform set_config('t.b', b::text, false);
end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; begin
  begin v := gc_start(b, jsonb_build_object('station_id',(select id from gc_stations where name='PS5 #1'),'is_lp',true,'lp_players',jsonb_build_array('Amit'))); assert false;
  exception when others then assert sqlerrm='An LP match needs at least 2 player names', sqlerrm; end;
  v := gc_start(b, jsonb_build_object('station_id',(select id from gc_stations where name='PS5 #1'),'is_lp',true,'lp_players',jsonb_build_array('Amit','Rahul'),
                                      'customer_phone','9876500001','booked_minutes',60));
  assert v->>'status'='running' and (v->>'is_lp')::boolean and v->>'customer_name'='Amit vs Rahul', 'LP started: '||v::text;
  begin perform gc_start(b, jsonb_build_object('station_id',(select id from gc_stations where name='PS5 #1'))); assert false;
  exception when others then assert sqlerrm='PS5 #1 is already in use', sqlerrm; end;
  perform set_config('t.s', v->>'id', false);
end $$;
reset role;
-- pretend it started 23 minutes ago
update gc_sessions set start_at = now() - interval '23 minutes' where id = current_setting('t.s')::uuid;
update gc_intervals set start_at = now() - interval '23 minutes' where session_id = current_setting('t.s')::uuid;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare s uuid := current_setting('t.s')::uuid; v jsonb; begin
  v := gc_lp_split(s, 'Rahul', null);   -- 2 players: winner Rahul → Amit pays
  assert jsonb_array_length(v->'calc'->'segments') = 1, 'one game: '||(v->'calc')::text;
  assert (v->'calc'->'per_player'->>'Amit')::numeric between 46 and 48, 'Amit pays ~23 started minutes at 120/hr: '||(v->'calc'->'per_player')::text;
  assert (v->'calc'->'per_player'->>'Rahul')::numeric = 0, 'Rahul pays nothing yet';
  v := gc_item_add(s, jsonb_build_object('product_id',(select id from gc_products where name='Coke'),'qty',2,'assigned_to','Amit'));
  assert (select stock from gc_products where name='Coke') = 8, 'stock reduced';
end $$;
reset role;
-- second game: another 30 minutes, then bill
update gc_sessions set start_at = start_at - interval '30 minutes' where id = current_setting('t.s')::uuid;
update gc_intervals set start_at = start_at - interval '30 minutes' where session_id = current_setting('t.s')::uuid;
update gc_lp_segments set from_at = from_at - interval '30 minutes', to_at = to_at - interval '30 minutes' where session_id = current_setting('t.s')::uuid;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; s uuid := current_setting('t.s')::uuid; v jsonb; p jsonb; sumpay numeric; begin
  begin v := gc_checkout(s, '{}'); assert false, 'last LP game must be assigned';
  exception when others then assert sqlerrm='Choose who pays for the last LP game before billing', sqlerrm; end;
  v := gc_checkout(s, jsonb_build_object('lp_final', jsonb_build_object('winner','Amit'), 'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',100,'by','Rahul'))));
  -- 53 min played, 60 booked → 60 min at 120 = 120 game + 80 coke = 200; GST 18% = 36 → 236
  assert (v->>'subtotal')::numeric = 200 and (v->>'tax')::numeric = 36 and (v->>'total')::numeric = 236, 'bill totals: '||v::text;
  assert (v->>'paid')::numeric = 100 and (v->>'due')::numeric = 136 and v->>'status'='partial', 'partial payment';
  select sum((x->>'payable')::numeric) into sumpay from jsonb_array_elements(v->'lp'->'players') x;
  assert sumpay = 236, 'players pay the whole bill: '||(v->'lp')::text;
  select x into p from jsonb_array_elements(v->'lp'->'players') x where x->>'player'='Rahul';
  assert (p->>'wins')::int = 1 and (p->>'game')::numeric > 50, 'Rahul won game 1, paid game 2: '||p::text;
  assert (select status from gc_sessions where id=s)='closed', 'session closed';
  perform set_config('t.bill', v->>'id', false);
end $$;
reset role;
do $$ declare c record; begin
  select * into c from customers where phone='919876500001';
  assert c.visits = 1 and c.spend = 236 and c.name = 'Amit', 'bill counted as a visit in the customer list: '||row_to_json(c)::text;
  assert (select count(*) from visits where customer_id = c.id) = 1, 'visit row';
end $$;

\echo '--- 4. happy hour across the boundary, pause excluded, players extra'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; t0 timestamptz; begin
  -- rule: every day, from 1 hour ago (IST) until 23:59 → flat 60/hr on PS5
  insert into gc_rules (business_id,name,station_type,start_time,end_time,mode,value,priority)
  values (b,'Happy hour','PS5', ((now() - interval '60 minutes') at time zone 'Asia/Kolkata')::time, '23:59', 'fixed', 60, 5);
  v := gc_start(b, jsonb_build_object('station_id',(select id from gc_stations where name='PS5 #2'),'players',3));
  perform set_config('t.s2', v->>'id', false);
end $$;
reset role;
-- 90 min ago start: first 30 min standard (120 + 1 extra player 30 = 150/hr), last 60 min happy (60 + 30 = 90/hr); 10 min pause inside
do $$ declare s uuid := current_setting('t.s2')::uuid; begin
  update gc_sessions set start_at = now() - interval '100 minutes' where id = s;
  delete from gc_intervals where session_id = s;
  insert into gc_intervals (session_id,start_at,end_at) values (s, now() - interval '100 minutes', now() - interval '70 minutes');
  insert into gc_intervals (session_id,start_at,end_at) values (s, now() - interval '60 minutes', null);   -- paused 10 min
end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare v jsonb; begin
  v := gc_session(current_setting('t.s2')::uuid);
  assert round((v->'calc'->>'active_minutes')::numeric) = 90, 'pause excluded: '||(v->'calc')::text;
  -- 30 min standard 150/hr = 75 ; 60 min happy 90/hr = 90 → 165 (± a minute's worth at the boundary)
  assert abs((v->'calc'->>'amount')::numeric - 165) <= 2.5, 'happy hour split: '||(v->'calc'->>'amount')||' '||(v->'calc'->'by_rule')::text;
  assert v->'calc'->>'rule_now' = 'Happy hour', 'rule now';
  v := gc_action((v->>'id')::uuid, 'pause');
  assert v->>'status'='paused';
  v := gc_action((v->>'id')::uuid, 'cancel', '{"reason":"test"}');
  assert v->>'status'='cancelled', 'owner can cancel an old session';
end $$;
reset role;

\echo '--- 5. counter sale, pay due, void restores stock; reports'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; begin
  begin perform gc_quick_sale(b, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id',(select id from gc_products where name='Maggi'),'qty',3)))); assert false;
  exception when others then assert sqlerrm='Only 2 Maggi left', sqlerrm; end;
  begin perform gc_quick_sale(b, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id',(select id from gc_products where name='Maggi'),'qty',1))));
    assert false, 'pay later needs a phone';
  exception when others then assert sqlerrm like 'Add the customer%', sqlerrm; end;
  v := gc_quick_sale(b, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id',(select id from gc_products where name='Maggi'),'qty',2)),
                                           'payments', jsonb_build_array(jsonb_build_object('mode','upi','amount',500))));
  assert (v->>'total')::numeric = 142 and (v->>'paid')::numeric = 142 and v->>'status'='paid', 'counter sale, change returned: '||v::text;
  assert (select stock from gc_products where name='Maggi') = 0;
  perform set_config('t.qs', v->>'id', false);
  v := gc_bill_pay(current_setting('t.bill')::uuid, 'upi', 36);
  assert (v->>'due')::numeric = 100 and jsonb_array_length(v->'payments') = 2, 'due collected';
  begin perform gc_bill_void(current_setting('t.qs')::uuid, 'wrong'); assert false;
  exception when others then assert sqlerrm='Only the owner can cancel a bill', sqlerrm; end;
  begin perform gc_report(b, current_date, current_date); assert false;
  exception when others then assert sqlerrm like 'Your login can''t see reports%', sqlerrm; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; r jsonb; begin
  perform gc_bill_void(current_setting('t.qs')::uuid, 'wrong item');
  assert (select stock from gc_products where name='Maggi') = 2, 'void restores stock';
  r := gc_report(b, gc_bday(b, now()) - 1, gc_bday(b, now()));
  assert (r->'summary'->>'bills')::int = 1 and (r->'summary'->>'sales')::numeric = 236 and (r->'summary'->>'collected')::numeric = 136
     and (r->'summary'->>'lp_matches')::int = 1, 'report: '||(r->'summary')::text;
end $$;
reset role;

\echo '--- 6. other businesses and non-gaming plans are locked out'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009e1');
do $$ declare n int; mine uuid; begin
  select count(*) into n from gc_bills; assert n=0, 'salon sees no gaming bills';
  begin perform gc_board(current_setting('t.b')::uuid); assert false; exception when others then assert sqlerrm='Not allowed', sqlerrm; end;
  select id into mine from businesses where name='Glow Salon 2';
  begin perform gc_board(mine); assert false; exception when others then assert sqlerrm like 'Gaming billing isn''t in your plan%', sqlerrm; end;
end $$;
reset role;

insert into gc_bookings (business_id, customer_name, customer_phone, start_at, status) values (current_setting('t.b')::uuid, 'Kiran', '919811122233', now() + interval '1 day', 'pending');
\echo '--- 7. WhatsApp add-on: messages only with the add-on; follow-up jobs; public pages'
do $$ declare b uuid := current_setting('t.b')::uuid; m jsonb; n int; begin
  m := gc_wa_payload(b, 'bill', current_setting('t.bill'));
  assert m->>'template'='gc_bill' and m->>'phone'='919876500001' and jsonb_array_length(m->'params')=5, 'bill payload: '||m::text;
  assert (m->'params'->>3) like 'https://scale.branditudeglobal.com/g.html?t=%', 'bill link';
  select count(*) into n from gc_wa_jobs() j where j.business_id = b; assert n=0, 'no add-on → no automatic messages';
  update businesses set addon_modules = '{wa_billing}' where id = b;
  update gc_bills set created_at = now() - interval '3 days' where id = current_setting('t.bill')::uuid;
  select count(*) into n from gc_wa_jobs() j where j.business_id = b and j.kind='due' and extract(hour from now() at time zone 'Asia/Kolkata') between 10 and 19;
  assert n = case when extract(hour from now() at time zone 'Asia/Kolkata') between 10 and 19 then 1 else 0 end, 'payment follow-up due';
  perform gc_wa_done(b, 'due', current_setting('t.bill'), '919876500001', 'sent', null, 1, 'wamid.x');
  assert (select followups from gc_bills where id = current_setting('t.bill')::uuid) = 1, 'follow-up counted';
  m := gc_wa_payload(b, 'due', current_setting('t.bill'));
  assert m->>'template'='gc_payment_due' and m->'params'->>1 = '₹100', 'due payload: '||m::text;
  -- owner reports the club picked
  m := gc_wa_payload(b, 'weekly', (current_date - 6)::text);
  assert m->>'template'='gc_daily_report' and m->'params'->>1 like 'the week %' and m->>'phone'='919822222222', 'weekly report: '||m::text;
  m := gc_wa_payload(b, 'monthly', to_char(current_date, 'YYYY-MM'));
  assert m->'params'->>1 = to_char(current_date, 'FMMonth YYYY'), 'monthly report: '||m::text;
  m := gc_wa_payload(b, 'low_stock', current_date::text);
  assert m->>'template'='gc_owner_alert' and m->'params'->>1 like 'low stock on Maggi (2 left)%', 'low stock: '||m::text;
  m := gc_wa_payload(b, 'dues', current_date::text);
  assert m->'params'->>1 like '₹100 is pending from 1 customer;%', 'dues: '||m::text;
  -- switches decide what the scheduler sends
  update gc_settings set report_low_stock = true, report_dues = true, wa_followup = false, report_hour = extract(hour from now() at time zone 'Asia/Kolkata') where business_id = b;
  select count(*) into n from gc_wa_jobs() j where j.business_id = b and j.kind in ('low_stock','dues'); assert n = 2, 'picked reports scheduled';
  select count(*) into n from gc_wa_jobs() j where j.business_id = b and j.kind = 'due'; assert n = 0, 'follow-ups switched off';
  perform gc_wa_done(b, 'dues', (now() at time zone 'Asia/Kolkata')::date::text, '919822222222', 'sent', null, 1, 'w2');
  select count(*) into n from gc_wa_jobs() j where j.business_id = b and j.kind = 'dues'; assert n = 0, 'a report goes once a day';
  m := gc_wa_payload(b, 'booking', (select id::text from gc_bookings where business_id = b limit 1));
  assert m->>'skip' = 'Booking is not confirmed', 'pending booking not confirmed yet: '||m::text;
end $$;
select set_config('t.slug', (select slug from businesses where id = current_setting('t.b')::uuid), false);
set role anon; select pg_temp.as_user(null);
do $$ declare r jsonb; t text; begin
  begin perform gc_board(current_setting('t.b')::uuid); assert false; exception when insufficient_privilege then null; end;
  r := gc_public_club(current_setting('t.slug'));
  assert jsonb_array_length(r->'stations') = 2 and jsonb_array_length(r->'offers') = 1, 'public club page: '||r::text;
  perform gc_public_booking(r->>'slug', jsonb_build_object('customer_name','Zed','customer_phone','9000000123','date',(current_date+1)::text,'time','18:00'));
end $$;
reset role;
do $$ declare t text; r jsonb; begin
  select token into t from gc_bills where id = current_setting('t.bill')::uuid;
  set local role anon;
  r := gc_public_bill(t);
  assert r->>'number' like 'GC-%' and r->'business'->>'name'='Level Up Gaming' and not r ? 'created_by', 'public bill';
  assert gc_public_bill('short') is null, 'short tokens refused';
end $$;
reset role;
do $$ begin assert (select count(*) from gc_bookings where source='online' and status='pending') = 1, 'online booking waits for approval'; end $$;

\echo 'GAMING TESTS PASSED'
