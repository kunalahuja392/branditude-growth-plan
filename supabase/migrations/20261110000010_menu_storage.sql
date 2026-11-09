-- Public bucket for menu photos (Supabase Storage; skipped in local tests).
-- Files live at menu/<business_id>/<file>.jpg and only that business's team can upload or delete them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu', 'menu', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg','image/png','image/webp'];

create policy menu_img_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'menu' and exists (select 1 from public.businesses b where b.id::text = (storage.foldername(name))[1] and public.can_use(b.id, 'menu')));
create policy menu_img_update on storage.objects for update to authenticated
  using (bucket_id = 'menu' and exists (select 1 from public.businesses b where b.id::text = (storage.foldername(name))[1] and public.can_use(b.id, 'menu')));
create policy menu_img_delete on storage.objects for delete to authenticated
  using (bucket_id = 'menu' and exists (select 1 from public.businesses b where b.id::text = (storage.foldername(name))[1] and public.can_use(b.id, 'menu')));
