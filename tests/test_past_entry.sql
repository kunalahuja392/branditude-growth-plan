\set ON_ERROR_STOP 1
\set QUIET 1
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;
do $$ declare b uuid; begin select id into b from businesses where slug like 'level-up-gaming%'; perform set_config('t.b', b::text, false);
  delete from gc_rules where business_id = b; update gc_sessions set status = 'closed' where business_id = b and status in ('running','paused','billing');
  update gc_settings set tax_percent = 0, round_to = 1, min_minutes = 0, round_minutes = 1 where business_id = b; end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; begin
  begin perform gc_past_entry(b, '{}'); assert false; exception when others then assert sqlerrm like 'Only the owner%', sqlerrm; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; ps uuid; a timestamptz := date_trunc('hour', now()) - interval '26 hours'; q jsonb; v jsonb; n int; begin
  select id into ps from gc_stations where business_id = b and name = 'PS5 #1';
  -- PS5 #1 is ₹120/hr (2 players included): 10:00-11:00 yesterday-ish
  q := gc_past_quote(b, ps, a, a + interval '60 minutes', 2);
  assert (q->>'amount')::numeric = 120 and (q->>'minutes')::int = 60 and q->'overlap' = 'null'::jsonb, 'quote: ' || q::text;
  q := gc_past_quote(b, ps, a, a + interval '45 minutes', 2); assert (q->>'amount')::numeric = 90, '45 min = 90: ' || (q->>'amount');
  v := gc_past_entry(b, jsonb_build_object('station_id', ps, 'start_at', a, 'end_at', a + interval '60 minutes', 'players', 2, 'customer_name', 'Late Larry', 'customer_phone', '9876511111',
        'items', jsonb_build_array(jsonb_build_object('name', 'Tea', 'price', 20, 'qty', 2)), 'payments', jsonb_build_array(jsonb_build_object('mode', 'cash', 'amount', 160))));
  assert (v->>'total')::numeric = 160 and (v->>'game_amount')::numeric = 120 and v->>'status' = 'paid', 'bill: ' || (v->>'total');
  assert (v->>'created_at')::timestamptz = a + interval '60 minutes', 'bill dated when played';
  assert (select created_at from gc_payments where bill_id = (v->>'id')::uuid) = a + interval '60 minutes', 'payment dated when played';
  assert (select v2.created_at from visits v2 join customers c on c.id = v2.customer_id where c.name = 'Late Larry' order by v2.id desc limit 1) = a + interval '60 minutes', 'visit dated when played';
  assert v->>'notes' like 'Added later by the owner%' and v->>'lines' like '%60 min%', 'marked as added later';
  -- overlap
  begin v := gc_past_entry(b, jsonb_build_object('station_id', ps, 'start_at', a + interval '30 minutes', 'end_at', a + interval '90 minutes')); assert false;
  exception when others then assert sqlerrm like '%already in use%', sqlerrm; end;
  -- owner amount and add anyway
  v := gc_past_entry(b, jsonb_build_object('station_id', ps, 'start_at', a + interval '30 minutes', 'end_at', a + interval '90 minutes', 'amount', 200, 'allow_overlap', true,
        'payments', jsonb_build_array(jsonb_build_object('mode', 'upi', 'amount', 200))));
  assert (v->>'total')::numeric = 200, 'owner amount';
  begin v := gc_past_entry(b, jsonb_build_object('station_id', ps, 'start_at', now() - interval '10 minutes', 'end_at', now() + interval '30 minutes')); assert false;
  exception when others then assert sqlerrm like '%future%', sqlerrm; end;
  begin v := gc_past_entry(b, jsonb_build_object('station_id', ps, 'start_at', a, 'end_at', a)); assert false;
  exception when others then assert sqlerrm like '%after the start%', sqlerrm; end;
  -- a live session on the same station doesn't block a past entry
  perform gc_start(b, jsonb_build_object('station_id', ps));
  v := gc_past_entry(b, jsonb_build_object('station_id', ps, 'start_at', a - interval '5 hours', 'end_at', a - interval '4 hours', 'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',120))));
  assert (v->>'total')::numeric = 120, 'works while station is busy now';
  select count(*) into n from gc_sessions where station_id = ps and status in ('running','paused','billing'); assert n = 1, 'live session untouched';
end $$;
reset role;
\echo 'PAST ENTRY TESTS PASSED'
