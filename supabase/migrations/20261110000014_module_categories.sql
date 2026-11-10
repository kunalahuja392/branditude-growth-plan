-- Some features only make sense for some businesses (a salon doesn't need table ordering).
-- modules.categories = category slugs the module is shown to; null = every business.
alter table public.modules add column if not exists categories text[];
update public.modules set categories = '{cafe-restaurant,bakery-sweets,hotel-homestay}' where key = 'menu';
