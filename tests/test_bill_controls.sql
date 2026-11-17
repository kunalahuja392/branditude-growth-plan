\set ON_ERROR_STOP 1
\set QUIET 1
-- Run after test_gaming.sql. Staff: played / booked only. Owner: other minutes and price change. Paused time on the board.
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;
do $$ declare b uuid; begin select id into b from businesses where slug like 'level-up-gaming%'; perform set_config('t.b', b::text, false);
  delete from gc_rules where business_id = b; update gc_sessions set status = 'closed' where business_id = b and status in ('running','paused','billing');
  update gc_settings set tax_percent = 0, round_to = 1, min_minutes = 0, round_minutes = 1 where business_id = b; end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; begin
  v := gc_start(b, jsonb_build_object('station_id', (select id from gc_stations where business_id = b and name = 'PS5 #1'), 'booked_minutes', 60));
  perform set_config('t.s', v->>'id', false);
end $$;
reset role;
update gc_sessions set start_at = now() - interval '30 minutes' + interval '2 seconds' where id = current_setting('t.s')::uuid;
update gc_intervals set start_at = now() - interval '30 minutes' + interval '2 seconds' where session_id = current_setting('t.s')::uuid;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare s uuid := current_setting('t.s')::uuid; v jsonb; begin
  v := gc_action(s, 'pause');
  assert v->>'paused_at' is not null, 'paused_at on the board';
  v := gc_action(s, 'stop');
  v := gc_bill_time(s, 'played'); assert (v->'calc'->>'amount')::numeric = 60, 'staff: played 30 min = 60';
  v := gc_bill_time(s, 'booked'); assert (v->'calc'->>'amount')::numeric = 120, 'staff: booked 60 min = 120';
  begin v := gc_bill_time(s, 'custom', 45); assert false; exception when others then assert sqlerrm like 'Only the owner%', sqlerrm; end;
  begin v := gc_bill_price(s, 150); assert false; exception when others then assert sqlerrm like 'Only the owner%', sqlerrm; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare s uuid := current_setting('t.s')::uuid; v jsonb; begin
  v := gc_bill_time(s, 'custom', 45); assert (v->'calc'->>'amount')::numeric = 90, 'owner: other minutes';
  v := gc_bill_price(s, 150); assert (v->'calc'->>'amount')::numeric = 150 and (v->'calc'->>'auto_amount')::numeric = 90, 'owner: price 90 -> 150';
  v := gc_bill_price(s, null); assert (v->'calc'->>'amount')::numeric = 90, 'owner: back to calculated';
  v := gc_bill_price(s, 150);
  v := gc_action(s, 'resume'); assert (v->'calc'->>'bill_amount') is null, 'resuming clears the set price';
  v := gc_action(s, 'stop'); v := gc_bill_price(s, 175);
  v := gc_bill_time(s, 'custom', 45); assert (v->'calc'->>'amount')::numeric = 175, 'same option keeps the set price';
  v := gc_bill_time(s, 'booked'); assert (v->'calc'->>'amount')::numeric = 120, 'changing the option clears the set price';
  v := gc_bill_price(s, 175);
  v := gc_checkout(s, jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',175))));
  assert (v->>'total')::numeric = 175 and (v->>'game_amount')::numeric = 175, 'bill uses the owner price: ' || (v->>'total');
end $$;
reset role;
\echo 'BILL CONTROL TESTS PASSED'
