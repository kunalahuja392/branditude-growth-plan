\set ON_ERROR_STOP 1
\set QUIET 1
-- Run after test_gaming.sql. Rounding to nearest 5; front-desk permissions; team login helpers.
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;
do $$ declare b uuid; begin select id into b from businesses where slug like 'level-up-gaming%'; perform set_config('t.b', b::text, false);
  update gc_settings set tax_percent = 18, tax_inclusive = false, round_to = 5, round_mode = 'nearest' where business_id = b;
  update business_members set perms = '{gaming}' where user_id = '00000000-0000-0000-0000-0000000009d2'; end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; begin
  -- 27 + 18% = 31.86 -> nearest 5 = 30 ; 30 + 18% = 35.40 -> 35 ; 28 + 18% = 33.04 -> 35
  v := gc_quick_sale(b, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('name','A','price',27)), 'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',30))));
  assert (v->>'total')::numeric = 30, 'nearest 5 down: ' || (v->>'total');
  v := gc_quick_sale(b, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('name','B','price',28)), 'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',35))));
  assert (v->>'total')::numeric = 35, 'nearest 5 up: ' || (v->>'total');
  -- no discount permission
  begin v := gc_quick_sale(b, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('name','C','price',100)), 'discount', 10, 'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',200)))); assert false;
  exception when others then assert sqlerrm like 'Your login can''t give discounts%', sqlerrm; end;
  -- no sales permission: board hides today's totals
  v := gc_board(b); assert v->'today' = 'null'::jsonb, 'sales hidden: ' || coalesce(v->>'today', 'null');
  -- no stock permission
  begin insert into gc_products (business_id, name, price) values (b, 'Hack', 1); assert false; exception when insufficient_privilege then null; end;
  begin perform gc_category(b, 'add', 'Hack'); assert false; exception when others then assert sqlerrm = 'Not allowed', sqlerrm; end;
end $$;
reset role;
update business_members set perms = '{gaming,g_sales,g_stock,g_discount,g_reports}' where user_id = '00000000-0000-0000-0000-0000000009d2';
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; v jsonb; begin
  v := gc_board(b); assert (v->'today'->>'bills')::int >= 2, 'sales visible';
  insert into gc_products (business_id, name, price, stock) values (b, 'Red Bull', 125, 12);
  perform gc_category(b, 'add', 'Energy');
  v := gc_report(b, current_date, current_date); assert v ? 'by_station', 'reports allowed';
  v := gc_quick_sale(b, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('name','D','price',100)), 'discount', 10, 'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',200))));
  assert (v->>'total')::numeric = 105, 'discount allowed: 90 + 18% = 106.2 -> 105: ' || (v->>'total');
  begin perform gc_stock_ack(b, '{}'); assert false; exception when others then assert sqlerrm like 'Only the owner%', sqlerrm; end;
end $$;
reset role;
-- team login helpers (service role)
do $$ declare b uuid := current_setting('t.b')::uuid; u uuid := gen_random_uuid(); begin
  begin perform team_manage_check(b, '00000000-0000-0000-0000-0000000009d2', null, 'staff'); assert false; exception when others then assert sqlerrm like 'Only the owner or an admin%', sqlerrm; end;
  begin perform team_manage_check(b, '00000000-0000-0000-0000-0000000009d1', '00000000-0000-0000-0000-0000000009d1', 'staff'); assert false; exception when others then assert sqlerrm like '%owner''s login%', sqlerrm; end;
  insert into auth.users (id, email) values (u, 'ravi@levelup.staff');
  perform team_attach(b, '00000000-0000-0000-0000-0000000009d1', u, 'staff', '{gaming,g_stock,bogus}', 'Ravi');
  assert (select perms from business_members where user_id = u) = '{g_stock,gaming}' or (select perms from business_members where user_id = u) @> '{gaming,g_stock}', 'attached with valid perms only';
  assert (select role from profiles where id = u) = 'business', 'profile is a business login';
  assert team_login_resettable(b, u), 'staff-only login can get a password';
  assert not team_login_resettable(b, '00000000-0000-0000-0000-0000000009d1'), 'owner login cannot be reset by the team';
  assert not team_login_resettable(b, '00000000-0000-0000-0000-0000000009e1'), 'another business owner cannot be reset';
end $$;
\echo 'STAFF PERMISSION TESTS PASSED'
