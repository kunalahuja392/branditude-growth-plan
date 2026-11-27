\set ON_ERROR_STOP 1
\set QUIET 1
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;
create function pg_temp.shift(sid uuid, m int, h int default 0) returns void language sql security definer as $$
  update public.gc_sessions set start_at = start_at - make_interval(mins => m) where id = sid;
  update public.gc_intervals set start_at = start_at - make_interval(mins => m) where session_id = sid $$;
grant execute on function pg_temp.shift(uuid, int, int) to authenticated;
do $$ declare b uuid; begin select id into b from businesses where slug like 'level-up-gaming%'; perform set_config('t.b', b::text, false);
  update gc_sessions set status = 'closed', end_at = coalesce(end_at, now()) where business_id = b and status in ('running','paused','billing');
  update gc_intervals set end_at = now() - interval '5 hours' where end_at is null or end_at > now() - interval '5 hours';
  update gc_settings set round_to = 1, tax_percent = 0, flat_opts = '[{"key":"frame","label":"Per frame","types":["PS5"],"amount":120,"night_amount":130,"night_from":"00:00","night_to":"06:00"}]' where business_id = b; end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; ps uuid; pc uuid; s uuid; v jsonb; bl jsonb; ok boolean := false; night boolean; begin
  select id into ps from gc_stations where business_id = b and name = 'PS5 #1';
  select id into pc from gc_stations where business_id = b and type <> 'PS5' and active limit 1;
  v := gc_start(b, jsonb_build_object('station_id', ps)); s := (v->>'id')::uuid; perform pg_temp.shift(s, 10);
  assert jsonb_array_length(v->'flat_opts') = 1, 'option offered on PS5';
  v := gc_bill_time(s, 'flat', null, 'frame', 2);
  night := (now() at time zone 'Asia/Kolkata')::time < '06:00';
  assert (v->'calc'->>'amount')::numeric = case when night then 260 else 240 end, 'flat 2 frames: ' || (v->'calc'->>'amount');
  bl := gc_checkout(s, jsonb_build_object('payments', jsonb_build_array(jsonb_build_object('mode','cash','amount', case when night then 260 else 240 end))));
  assert (bl->>'total')::numeric = case when night then 260 else 240 end, 'bill ' || (bl->>'total');
  assert (bl->'lines'->0->>'desc') like '%Per frame × 2%', 'line: ' || (bl->'lines'->0->>'desc');
  v := gc_start(b, jsonb_build_object('station_id', pc)); s := (v->>'id')::uuid;
  assert jsonb_array_length(v->'flat_opts') = 0, 'not on other stations';
  begin perform gc_bill_time(s, 'flat', null, 'frame', 1); exception when others then ok := true; end;
  assert ok, 'flat refused on other station';
  update gc_settings set flat_opts = '[]' where business_id = b;
  assert (select flat_opts from gc_settings where business_id = b) <> '[]', 'club cannot change its own flat options';
end $$;
reset role;
\echo FLAT PRICE TESTS PASSED
