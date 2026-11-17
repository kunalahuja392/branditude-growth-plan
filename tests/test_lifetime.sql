\set ON_ERROR_STOP 1
\set QUIET 1
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;
do $$ declare b uuid; begin select id into b from businesses where slug like 'level-up-gaming%'; perform set_config('t.b', b::text, false); end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; begin
  assert not has_module(b, 'seo'), 'no seo before';
  begin update businesses set lifetime = true where id = b; assert false; exception when others then assert sqlerrm like 'Only Branditude%' or sqlerrm like 'permission denied%', sqlerrm; end;
end $$;
reset role;
-- Branditude admin switches it on (direct update as postgres = no auth user)
select pg_temp.as_user(null);
update businesses set lifetime = true, status = 'paused', subscription_ends = current_date - 100 where id = current_setting('t.b')::uuid;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; r record; begin
  select status, subscription_ends into r from businesses where id = b;
  assert r.status = 'active' and r.subscription_ends is null, 'lifetime is active with no end: ' || r.status;
  assert has_module(b, 'seo') and has_module(b, 'gaming') and biz_open(b), 'everything unlocked and open';
  begin perform create_order(b, 'subscription', (select id from packages where slug = 'game-club'), 'monthly'); assert false;
  exception when others then assert sqlerrm like '%lifetime access%', sqlerrm; end;
end $$;
reset role;
do $$ begin assert pause_expired() = 0 or (select status from businesses where id = current_setting('t.b')::uuid) = 'active', 'never paused'; exception when undefined_function then null; end $$;
\echo 'LIFETIME TESTS PASSED'
