-- Hourly Google review sync (auto-replies). Needs pg_cron + pg_net (available on Supabase; skipped in local tests).
create extension if not exists pg_cron;
create extension if not exists pg_net schema extensions;   -- kept out of the public schema (security advisor)
select cron.unschedule(jobid) from cron.job where jobname = 'gbp-sync-hourly';
select cron.schedule('gbp-sync-hourly', '17 * * * *', $job$
  select net.http_post(
    url := 'https://dumninwceiqvevndpupc.supabase.co/functions/v1/gbp-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select value from public.internal_secrets where key = 'cron_secret')),
    body := '{"action":"cron"}'::jsonb,
    timeout_milliseconds := 60000)
$job$);
