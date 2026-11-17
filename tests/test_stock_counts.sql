\set ON_ERROR_STOP 1
\set QUIET 1
-- Run after test_gaming.sql. Opening/closing counts: blind for staff, differences for the owner to acknowledge.
create function pg_temp.as_user(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', coalesce(u,''), false); end $$;
grant execute on function pg_temp.as_user(text) to anon, authenticated;
do $$ declare b uuid; begin select id into b from businesses where slug like 'level-up-gaming%'; perform set_config('t.b', b::text, false);
  delete from gc_products where business_id = b and name like 'SC %';
  insert into gc_products (business_id, name, price, stock, daily_count) values (b, 'SC Coke', 40, 20, true), (b, 'SC Chips', 20, 10, true), (b, 'SC Headset', 50, 2, false); end $$;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; r jsonb; st jsonb; n int; begin
  st := gc_stock_status(b); assert (st->>'products')::int = 2 and st->>'opening_at' is null and st->'to_check' = 'null'::jsonb, 'status before: ' || st::text;
  -- opening: Coke 20 ok, Chips 9 (1 missing overnight); Headset is not counted daily -> ignored
  r := gc_stock_count(b, 'opening', jsonb_build_array(
        jsonb_build_object('product_id', (select id from gc_products where name = 'SC Coke'), 'counted', 20),
        jsonb_build_object('product_id', (select id from gc_products where name = 'SC Chips'), 'counted', 9),
        jsonb_build_object('product_id', (select id from gc_products where name = 'SC Headset'), 'counted', 1)));
  assert (r->>'counted')::int = 2 and (r->>'mismatched')::int = 1 and jsonb_array_length(r->'rows') = 0, 'staff sees only how many, not the numbers: ' || r::text;
  select count(*) into n from gc_stock_counts; assert n = 0, 'staff cannot read the counts';
  assert (select stock from gc_products where name = 'SC Chips') = 9 and (select stock from gc_products where name = 'SC Headset') = 2, 'stock set to the count; headset untouched';
  -- sell 3 Coke, then close: 16 counted (1 missing), chips 9 ok
  r := gc_quick_sale(b, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('product_id', (select id from gc_products where name = 'SC Coke'), 'qty', 3)),
        'payments', jsonb_build_array(jsonb_build_object('mode','cash','amount',1000))));
  r := gc_stock_count(b, 'closing', jsonb_build_array(
        jsonb_build_object('product_id', (select id from gc_products where name = 'SC Coke'), 'counted', 16),
        jsonb_build_object('product_id', (select id from gc_products where name = 'SC Chips'), 'counted', 9)));
  assert (r->>'mismatched')::int = 1, 'closing: coke 1 short';
  -- recount the same closing: now 17 found -> 0 difference against the original expectation (17)
  r := gc_stock_count(b, 'closing', jsonb_build_array(jsonb_build_object('product_id', (select id from gc_products where name = 'SC Coke'), 'counted', 17)));
  assert (r->>'mismatched')::int = 0, 'recount compares with the first expectation: ' || r::text;
  begin r := gc_stock_ack(b, array[1::bigint]); assert false; exception when others then assert sqlerrm like 'Only the owner%', sqlerrm; end;
  begin r := gc_stock_count(b, 'opening', '[]'); assert false; exception when others then assert sqlerrm like 'Enter at least%', sqlerrm; end;
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d1');
do $$ declare b uuid := current_setting('t.b')::uuid; st jsonb; ids bigint[]; c record; begin
  st := gc_stock_status(b); assert (st->>'to_check')::int = 1 and (st->>'opening_n')::int = 2 and (st->>'closing_n')::int = 2, 'owner status: ' || st::text;
  select * into c from gc_stock_counts where kind = 'closing' and product_name = 'SC Coke';
  assert c.expected = 17 and c.counted = 17 and c.diff = 0 and c.opening = 20 and c.sold = 3, 'closing row: opening 20, sold 3, expected 17: ' || row_to_json(c)::text;
  select * into c from gc_stock_counts where kind = 'opening' and product_name = 'SC Chips';
  assert c.expected = 10 and c.counted = 9 and c.diff = -1, 'opening chips 1 short';
  ids := array(select id from gc_stock_counts where diff <> 0 and ack_at is null);
  assert gc_stock_ack(b, ids, 'Eaten by staff, cut from salary') = 1, 'acknowledged';
  st := gc_stock_status(b); assert (st->>'to_check')::int = 0, 'nothing left to check';
end $$;
reset role;
set role authenticated; select pg_temp.as_user('00000000-0000-0000-0000-0000000009d2');
do $$ declare b uuid := current_setting('t.b')::uuid; r jsonb; begin
  begin r := gc_stock_count(b, 'opening', jsonb_build_array(jsonb_build_object('product_id', (select id from gc_products where name = 'SC Chips'), 'counted', 5))); assert false;
  exception when others then assert sqlerrm like '%already counted and checked%', sqlerrm; end;
end $$;
reset role;
\echo 'STOCK COUNT TESTS PASSED'
