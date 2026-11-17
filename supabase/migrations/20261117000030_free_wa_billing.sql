-- WhatsApp bills add-on for gaming clubs: no monthly fee, clubs pay only 1 utility credit per message.
-- Any add-on priced at 0 now switches on straight away instead of creating a 0 rupee payment.
update public.modules set addon_price = 0,
  blurb = 'Bill and feedback link on WhatsApp after every session, time-up reminders, pending-payment follow-ups and owner reports. No monthly fee: each message uses 1 utility credit.'
 where key = 'wa_billing';

create or replace function public.create_order(p_business uuid, p_kind text, p_ref uuid, p_billing text default 'monthly') returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_amount numeric; v_desc text; v_meta jsonb; v_gst numeric; v_id uuid; r record; v_cat uuid; v_bill text; v_pkgmods text[]; v_add jsonb;
begin
  if not public.is_member(p_business) then raise exception 'Not allowed'; end if;
  select category_id, billing, (select modules from public.packages where id = x.package_id) into v_cat, v_bill, v_pkgmods
    from public.businesses x where id = p_business;
  if p_kind = 'wa_credits' then
    select * into r from public.wa_credit_packs where id = p_ref and active; if not found then raise exception 'Pack not available'; end if;
    v_amount := r.price; v_desc := 'WhatsApp credits: ' || r.name || ' (' || r.credits || ' messages)'; v_meta := jsonb_build_object('pack_id', r.id, 'credits', r.credits);
  elsif p_kind = 'product' then
    select * into r from public.products p where id = p_ref and active
      and (not exists (select 1 from public.product_categories x where x.product_id = p.id) or exists (select 1 from public.product_categories x where x.product_id = p.id and x.category_id = v_cat));
    if not found then raise exception 'Service not available for your category'; end if;
    v_amount := r.price; v_desc := r.name; v_meta := jsonb_build_object('product_id', r.id);
  elsif p_kind = 'module' then
    select * into r from public.modules where id = p_ref and active and not core and addon_price is not null;
    if not found then raise exception 'This add-on is not available'; end if;
    if r.key = any(coalesce(v_pkgmods, '{}')) then raise exception 'Your plan already includes %', r.name; end if;
    if exists (select 1 from public.payments where business_id = p_business and kind = 'module' and status = 'pending' and meta->>'module' = r.key) then
      raise exception 'You already have a payment waiting for %', r.name; end if;
    v_bill := coalesce(v_bill, 'monthly');
    v_amount := r.addon_price * case when v_bill = 'yearly' then 10 else 1 end;
    v_desc := 'Add-on: ' || r.name || ' (' || case when v_bill = 'yearly' then '1 year' else '1 month' end || ')';
    v_meta := jsonb_build_object('module', r.key, 'billing', v_bill);
    if v_amount = 0 then   -- free add-on: switch it on now, nothing to pay
      update public.businesses set addon_modules = array(select distinct unnest(coalesce(addon_modules, '{}') || array[r.key])) where id = p_business;
      return jsonb_build_object('free', true, 'module', r.key, 'description', v_desc, 'amount', 0, 'gst', 0, 'total', 0);
    end if;
  elsif p_kind = 'subscription' then
    v_amount := public.package_price(p_ref, coalesce(p_billing,'monthly')); if v_amount is null then raise exception 'Plan not available'; end if;
    v_add := public.addon_bill(p_business, p_ref, coalesce(p_billing,'monthly'));
    select 'Plan: ' || name || ' (' || coalesce(p_billing,'monthly') || ')' into v_desc from public.packages where id = p_ref;
    if (v_add->>'amount')::numeric > 0 then
      v_amount := v_amount + (v_add->>'amount')::numeric; v_desc := v_desc || ' + add-ons: ' || (v_add->>'names');
    end if;
    v_meta := jsonb_build_object('package_id', p_ref, 'billing', coalesce(p_billing,'monthly'), 'modules', v_add->'keys');
  else raise exception 'Unknown order type'; end if;
  v_gst := round(v_amount * public.gst_rate(), 2);
  insert into public.payments (business_id, kind, description, amount, gst, total, meta)
  values (p_business, p_kind, v_desc, v_amount, v_gst, v_amount + v_gst, v_meta) returning id into v_id;
  return jsonb_build_object('payment_id', v_id, 'description', v_desc, 'amount', v_amount, 'gst', v_gst, 'total', v_amount + v_gst);
end $$;
