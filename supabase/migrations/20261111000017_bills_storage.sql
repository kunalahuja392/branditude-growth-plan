-- Private bucket for expense bills (Supabase Storage; skipped in local tests).
-- Files live at bills/<business_id>/<file>; only people with access to that business's accounts can upload, view or delete them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bills', 'bills', false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf'];

drop policy if exists bills_read on storage.objects;
create policy bills_read on storage.objects for select to authenticated
  using (bucket_id = 'bills' and exists (select 1 from public.businesses b where b.id::text = (storage.foldername(name))[1] and public.has_perm(b.id, 'accounts')));
drop policy if exists bills_insert on storage.objects;
create policy bills_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bills' and exists (select 1 from public.businesses b where b.id::text = (storage.foldername(name))[1] and public.can_use(b.id, 'accounting')));
drop policy if exists bills_delete on storage.objects;
create policy bills_delete on storage.objects for delete to authenticated
  using (bucket_id = 'bills' and exists (select 1 from public.businesses b where b.id::text = (storage.foldername(name))[1] and public.can_use(b.id, 'accounting')));
