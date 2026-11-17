\set ON_ERROR_STOP 1
\set QUIET 1
-- Gaming round 2: time-of-day station prices, round up to ₹5, bill-time choice, memberships, per-station report, coupons.
-- Run right after tests/test_gaming.sql on the same database (uses its club "Level Up Gaming").
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;
create function pg_temp.backdate(s uuid, m int) returns void language plpgsql as $$ begin
  update gc_sessions set start_at = start_at - make_interval(mins => m) + interval '2 seconds' where id = s;
  update gc_intervals set start_at = start_at - make_interval(mins => m) + interval '2 seconds' where session_id = s; end $$;
do $$ declare b uuid; begin
  select id into b from businesses where slug like 'level-up-gaming%'; perform set_config('t.b', b::text, false);
  delete from gc_rules where business_id = b;                       -- start from plain station prices
  update gc_settings set tax_percent = 18, tax_inclusive = false, min_minutes = 0, round_minutes = 1, charge_booked = true where business_id = b;
end $$;

\echo '--- 1. time-of-day price on a station, with a % rule on top'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; st gc_stations; r record; begin
  update gc_stations set time_rates = '[{"name":"All day","from":"00:00","to":"24:00","rate":30,"days":[0,1,2,3,4,5,6]}]' where business_id = b and name = 'PC #1';
  select * into st from gc_stations where business_id = b and name = 'PC #1';
  r := gc_rate_at(st, null, 1, now()); assert r.rate = 30 and r.rule = 'All day', 'band price: ' || r.rate || ' ' || coalesce(r.rule, '-');
  update gc_stations set time_rates = '[{"from":"05:00","to":"12:00","rate":80},{"from":"18:00","to":"02:00","rate":150}]' where id = st.id;
  select * into st from gc_stations where id = st.id;
  r := gc_rate_at(st, null, 1, ('2026-11-17 09:00'::timestamp at time zone 'Asia/Kolkata')); assert r.rate = 80, 'morning band ' || r.rate;
  r := gc_rate_at(st, null, 1, ('2026-11-17 14:00'::timestamp at time zone 'Asia/Kolkata')); assert r.rate = 60 and r.rule is null, 'outside bands = normal price ' || r.rate;
  r := gc_rate_at(st, null, 1, ('2026-11-17 23:30'::timestamp at time zone 'Asia/Kolkata')); assert r.rate = 150, 'evening band ' || r.rate;
  r := gc_rate_at(st, null, 1, ('2026-11-18 01:30'::timestamp at time zone 'Asia/Kolkata')); assert r.rate = 150, 'evening band runs past midnight ' || r.rate;
  r := gc_rate_at(st, null, 1, ('2026-11-18 02:30'::timestamp at time zone 'Asia/Kolkata')); assert r.rate = 60, 'after the band ' || r.rate;
  -- weekday-only band (Mon-Fri); 22 Nov 2026 is a Sunday
  update gc_stations set time_rates = '[{"from":"00:00","to":"24:00","rate":40,"days":[1,2,3,4,5]}]' where id = st.id; select * into st from gc_stations where id = st.id;
  r := gc_rate_at(st, null, 1, ('2026-11-22 10:00'::timestamp at time zone 'Asia/Kolkata')); assert r.rate = 60, 'Sunday not in a Mon-Fri band ' || r.rate;
  r := gc_rate_at(st, null, 1, ('2026-11-23 10:00'::timestamp at time zone 'Asia/Kolkata')); assert r.rate = 40, 'Monday in the band ' || r.rate;
  update gc_stations set time_rates = '[{"name":"All day","from":"00:00","to":"24:00","rate":30}]' where id = st.id;
  insert into gc_rules (business_id, name, station_type, mode, value, priority) values (b, 'Half off', '#' || st.id, 'percent', 50, 1);
end $$;
reset role;

\echo '--- 2. bills round up to the next ₹5'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
update gc_settings set round_to = 5 where business_id = current_setting('t.b')::uuid;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; begin
  v := gc_start(b, jsonb_build_object('station_id', (select id from gc_stations where business_id = b and name = 'PC #1'), 'customer_name', 'Walk in'));
  perform set_config('t.s', v->>'id', false);
end $$;
reset role;
select pg_temp.backdate(current_setting('t.s')::uuid, 60);
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare v jsonb; bl jsonb; begin
  v := gc_action(current_setting('t.s')::uuid, 'stop'); v := gc_bill_time(current_setting('t.s')::uuid, 'custom', 60);
  assert (v->'calc'->>'amount')::numeric = 15, 'band ₹30 with 50% off for 60 min = ₹15: ' || (v->'calc'->>'amount');
  bl := gc_checkout(current_setting('t.s')::uuid, jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',20))));
  -- 15 + 18% GST = 17.70, rounded up to 20
  assert (bl->>'total')::numeric = 20 and (bl->>'round_off')::numeric = 2.30 and bl->>'status' = 'paid', 'round up to ₹5: ' || (bl->>'total') || ' ' || (bl->>'round_off');
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ begin
  begin update gc_settings set round_to = 3 where business_id = current_setting('t.b')::uuid; assert false, 'round_to 3 not allowed';
  exception when check_violation then null; end;
  update gc_settings set round_to = 1, tax_percent = 0 where business_id = current_setting('t.b')::uuid;
  delete from gc_rules where business_id = current_setting('t.b')::uuid;
end $$;
reset role;

\echo '--- 3. biller picks the time to charge: played, full booking or other'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; begin
  v := gc_start(b, jsonb_build_object('station_id', (select id from gc_stations where business_id = b and name = 'PS5 #2'), 'customer_name', 'Booker', 'booked_minutes', 60));
  perform set_config('t.s', v->>'id', false);
end $$;
reset role;
select pg_temp.backdate(current_setting('t.s')::uuid, 23);
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare s uuid := current_setting('t.s')::uuid; v jsonb; begin
  v := gc_action(s, 'stop');
  assert (v->'calc'->>'charged_minutes')::int = 60 and (v->'calc'->>'played_minutes')::int between 23 and 24, 'club setting: full booking ' || (v->'calc'->>'charged_minutes') || ' played ' || (v->'calc'->>'played_minutes');
  v := gc_bill_time(s, 'played');  assert (v->'calc'->>'charged_minutes')::int between 23 and 24 and (v->'calc'->>'amount')::numeric = 2 * (v->'calc'->>'charged_minutes')::int, 'played ~23 min at ₹120/hr: ' || (v->'calc'->>'amount');
  v := gc_bill_time(s, 'booked');  assert (v->'calc'->>'charged_minutes')::int = 60 and (v->'calc'->>'amount')::numeric = 120, 'booked 60 min = 120';
  v := gc_bill_time(s, 'custom', 45); assert (v->'calc'->>'charged_minutes')::int = 45 and (v->'calc'->>'amount')::numeric = 90, 'custom 45 min = 90';
  begin v := gc_bill_time(s, 'custom', null); assert false; exception when others then assert sqlerrm like 'Enter the minutes%', sqlerrm; end;
  v := gc_checkout(s, jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('mode','upi','amount',90))));
  assert (v->>'game_amount')::numeric = 90 and v->>'lines' like '%45 min%', 'bill uses the chosen 45 min';
  begin v := gc_bill_time(s, 'played'); assert false; exception when others then assert sqlerrm like '%already closed%', sqlerrm; end;
end $$;
reset role;

\echo '--- 4. memberships: plans (owner only), sell, use at checkout, limits, void gives hours back'
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; begin
  begin insert into gc_membership_plans (business_id, name, price, buckets) values (b, 'Hack', 1, '[{"name":"x","minutes":60}]'); assert false, 'staff cannot make plans';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; p1 uuid; p2 uuid; pc uuid; pid uuid; bk jsonb; begin
  select id into p1 from gc_stations where business_id = b and name = 'PS5 #1'; select id into p2 from gc_stations where business_id = b and name = 'PS5 #2';
  select id into pc from gc_stations where business_id = b and name = 'PC #1';
  begin insert into gc_membership_plans (business_id, name, price, buckets) values (b, 'Empty', 100, '[]'); assert false; exception when others then assert sqlerrm like 'Add at least one%', sqlerrm; end;
  insert into gc_membership_plans (business_id, name, price, validity_days, buckets) values (b, 'Gold', 1000, 30,
    jsonb_build_array(jsonb_build_object('name','PS5 hours','minutes',120,'station_ids',jsonb_build_array(p1, p2, gen_random_uuid())),
                      jsonb_build_object('name','PC hours','minutes',60,'station_ids',jsonb_build_array(pc)),
                      jsonb_build_object('name','skip','minutes',0))) returning id, buckets into pid, bk;
  assert jsonb_array_length(bk) = 2 and jsonb_array_length(bk->0->'station_ids') = 2, 'buckets cleaned (zero hours and unknown stations dropped): ' || bk::text;
  perform set_config('t.plan', pid::text, false);
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; r jsonb; m jsonb; begin
  begin r := gc_membership_sell(b, jsonb_build_object('plan_id', current_setting('t.plan'), 'customer_name', 'Neha')); assert false;
  exception when others then assert sqlerrm like '%mobile number%', sqlerrm; end;
  r := gc_membership_sell(b, jsonb_build_object('plan_id', current_setting('t.plan'), 'customer_name', 'Neha', 'customer_phone', '9876500001',
        'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',1000))));
  m := r->'membership';
  assert (m->>'expires_on')::date = (now() at time zone 'Asia/Kolkata')::date + 29, 'valid 30 days incl. today: ' || (m->>'expires_on');
  assert (m->>'minutes_left')::int = 180 and (m->>'active')::boolean, 'starts with 180 min';
  assert (r->'bill'->>'total')::numeric = 1000 and r->'bill'->>'status' = 'paid' and r->'bill'->>'lines' like '%Membership: Gold%', 'sale bill';
  perform set_config('t.m', m->>'id', false);
  -- first session: 90 min on PS5 #1, fully covered
  r := gc_start(b, jsonb_build_object('station_id', (select id from gc_stations where business_id = b and name = 'PS5 #1'), 'customer_name', 'Neha', 'customer_phone', '9876500001'));
  perform set_config('t.s', r->>'id', false);
end $$;
reset role;
select pg_temp.backdate(current_setting('t.s')::uuid, 90);
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; s uuid := current_setting('t.s')::uuid; o jsonb; bl jsonb; begin
  perform gc_action(s, 'stop');
  o := gc_member_options(s); assert jsonb_array_length(o) = 1, 'Neha has a membership for PS5 #1';
  bl := gc_checkout(s, jsonb_build_object('membership', jsonb_build_object('id', current_setting('t.m'), 'bucket', 0), 'payments', '[]'::jsonb));
  assert (bl->>'total')::numeric = 0 and (bl->>'game_amount')::numeric = 0 and bl->>'status' = 'paid', '90 min fully covered: ' || (bl->>'total');
  assert ((select buckets->0->>'used' from gc_memberships where id = current_setting('t.m')::uuid))::int = 90, '90 min used';
  -- second session: 60 min on PS5 #2, only 30 min left in PS5 hours
  bl := gc_start(b, jsonb_build_object('station_id', (select id from gc_stations where business_id = b and name = 'PS5 #2'), 'customer_phone', '9876500001'));
  perform set_config('t.s', bl->>'id', false);
end $$;
reset role;
select pg_temp.backdate(current_setting('t.s')::uuid, 60);
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare s uuid := current_setting('t.s')::uuid; bl jsonb; begin
  perform gc_action(s, 'stop');
  begin bl := gc_checkout(s, jsonb_build_object('membership', jsonb_build_object('id', current_setting('t.m'), 'bucket', 1))); assert false, 'PC hours on a PS5';
  exception when others then assert sqlerrm like '%can''t be used on PS5 #2%', sqlerrm; end;
  bl := gc_checkout(s, jsonb_build_object('membership', jsonb_build_object('id', current_setting('t.m'), 'bucket', 0), 'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',60))));
  assert (bl->>'total')::numeric = 60 and (bl->>'game_amount')::numeric = 60 and bl->>'lines' like '%30 min used%', '30 of 60 min covered, ₹60 to pay: ' || (bl->>'total');
  assert ((select buckets->0->>'used' from gc_memberships where id = current_setting('t.m')::uuid))::int = 120, 'PS5 hours used up';
  perform set_config('t.bill', bl->>'id', false);
  begin bl := gc_bill_void((current_setting('t.bill'))::uuid, 'mistake'); assert false; exception when others then assert sqlerrm like 'Only the owner%', sqlerrm; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; r jsonb; begin
  perform gc_bill_void(current_setting('t.bill')::uuid, 'wrong customer');
  assert ((select buckets->0->>'used' from gc_memberships where id = current_setting('t.m')::uuid))::int = 90, 'void gives the 30 min back';
  assert (select count(*) from gc_membership_uses where membership_id = current_setting('t.m')::uuid) = 1, 'use row removed';
  -- per-station report
  r := gc_report(b, (now() at time zone 'Asia/Kolkata')::date - 1, (now() at time zone 'Asia/Kolkata')::date);
  assert (select (x->>'member_minutes')::int from jsonb_array_elements(r->'by_station') x where x->>'name' = 'PS5 #1') = 90, 'report: membership minutes per station';
  assert (select (x->>'total')::numeric = (x->>'gaming')::numeric + (x->>'items')::numeric from jsonb_array_elements(r->'by_station') x where x->>'name' = 'PS5 #2'), 'report: total = gaming + snacks';
  assert (select sum((x->>'gaming')::numeric) from jsonb_array_elements(r->'by_station') x)
       = (select coalesce(sum(game_amount), 0) from gc_bills where business_id = b and status <> 'void' and session_id is not null and created_at >= ((now() at time zone 'Asia/Kolkata')::date - 1)::timestamp at time zone 'Asia/Kolkata'), 'report: station gaming adds up to bills';
  assert (r->'memberships'->>'sold')::int = 1 and (r->'memberships'->>'amount')::numeric = 1000, 'report: memberships sold';
  -- owner tools
  r := gc_membership_update(current_setting('t.m')::uuid, 'extend', '{"days":10}');
  assert (r->>'expires_on')::date = (now() at time zone 'Asia/Kolkata')::date + 39, 'extend 10 days';
  r := gc_membership_update(current_setting('t.m')::uuid, 'adjust', jsonb_build_object('buckets', jsonb_build_array(jsonb_build_object('name','PS5 hours','minutes',120,'used',60,'station_ids',(select buckets->0->'station_ids' from gc_memberships where id = current_setting('t.m')::uuid)),
        jsonb_build_object('name','PC hours','minutes',60,'used',0,'station_ids',(select buckets->1->'station_ids' from gc_memberships where id = current_setting('t.m')::uuid)))));
  assert (r->>'minutes_left')::int = 120, 'adjusted to 60 + 60 left: ' || (r->>'minutes_left');
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ begin
  begin perform gc_membership_update(current_setting('t.m')::uuid, 'extend', '{"days":100}'); assert false; exception when others then assert sqlerrm like 'Only the owner%', sqlerrm; end;
end $$;
reset role;

\echo '--- 5. customer sees hours left and expiry; expired / cancelled cannot be used'
insert into auth.users (id, phone) values ('00000000-0000-0000-0000-0000000009f1', '919876500001');
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009f1');
do $$ declare r jsonb; begin
  r := my_gc_memberships();
  assert jsonb_array_length(r) = 1 and r->0->>'business_name' = 'Level Up Gaming' and (r->0->>'minutes_left')::int = 120, 'customer portal: ' || r::text;
  assert r->0->'buckets'->0->'stations' = '["PS5 #1", "PS5 #2"]'::jsonb and jsonb_array_length(r->0->'uses') = 1, 'station names and use history';
  assert (select count(*) from gc_memberships) = 0, 'customers cannot read the table directly';
end $$;
reset role;
update gc_memberships set expires_on = current_date - 1 where id = current_setting('t.m')::uuid;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; begin
  v := gc_start(b, jsonb_build_object('station_id', (select id from gc_stations where business_id = b and name = 'PC #1'), 'customer_phone', '9876500001'));
  assert jsonb_array_length(gc_member_options((v->>'id')::uuid)) = 0, 'expired membership not offered';
  perform gc_action((v->>'id')::uuid, 'stop');
  begin v := gc_checkout((v->>'id')::uuid, jsonb_build_object('membership', jsonb_build_object('id', current_setting('t.m'), 'bucket', 1))); assert false;
  exception when others then assert sqlerrm like '%expired%', sqlerrm; end;
end $$;
reset role;

\echo '--- 6. new prices and coupons'
do $$ begin
  assert (select monthly_price from packages where slug = 'game-club') = 2000 and (select monthly_price from packages where slug = 'game-club-pro') = 3600, 'gaming prices';
  assert (select monthly_price from packages where slug = 'starter') = 1600 and (select yearly_price from packages where slug = 'pro') = 36000, 'scale prices x4';
  assert (quote((select id from packages where slug = 'game-club'), 'monthly', '{}', 'thegamingloft')->>'subtotal')::numeric = 500, 'THEGAMINGLOFT 75% on Game Club';
  assert (quote((select id from packages where slug = 'starter'), 'monthly', '{}', 'THEGAMINGLOFT')->>'promo_ok')::boolean = false, 'THEGAMINGLOFT not for scale plans';
  assert (quote((select id from packages where slug = 'growth'), 'monthly', '{}', 'NEW75')->>'subtotal')::numeric = 600, 'NEW75 on every plan';
end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; o jsonb; p jsonb; begin
  o := create_order(b, 'subscription', (select id from packages where slug = 'game-club-pro'), 'monthly');
  begin p := apply_promo((o->>'payment_id')::uuid, 'BOGUS'); assert false; exception when others then assert sqlerrm like '%isn''t valid%', sqlerrm; end;
  p := apply_promo((o->>'payment_id')::uuid, 'thegamingloft');
  assert (p->>'amount')::numeric = 900 and p->'meta'->>'promo_code' = 'THEGAMINGLOFT', 'in-app coupon: 3600 -> 900: ' || (p->>'amount');
  begin p := apply_promo((o->>'payment_id')::uuid, 'NEW75'); assert false; exception when others then assert sqlerrm like '%already applied%', sqlerrm; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009e1');
do $$ declare b uuid; o jsonb; p jsonb; begin
  select id into b from businesses where name = 'Glow Salon 2';
  o := create_order(b, 'subscription', (select id from packages where slug = 'starter'), 'monthly');
  begin p := apply_promo((o->>'payment_id')::uuid, 'THEGAMINGLOFT'); assert false; exception when others then assert sqlerrm like '%doesn''t apply%', sqlerrm; end;
  p := apply_promo((o->>'payment_id')::uuid, 'NEW75'); assert (p->>'amount')::numeric = 400, 'salon starter 1600 -> 400';
  begin p := apply_promo((select id from payments where business_id = current_setting('t.b')::uuid limit 1), 'NEW75'); assert false;
  exception when others then assert sqlerrm like 'Not allowed%' or sqlerrm like 'Payment not found%', sqlerrm; end;
end $$;
reset role;

\echo 'GAMING ROUND 2 TESTS PASSED'
