-- Wording accepted by Meta (17 Nov 2026): a template can't end on a variable, and needs enough fixed text per variable.
update public.wa_templates set body_preview = 'Hi {{1}}, thank you for playing at {{2}}. Your bill {{3}} for {{4}} is here: {{5}} How was your time with us? Tap to rate: {{6}} See you again soon!'
 where name = 'gc_bill' and business_id is null and body_preview not like '%See you again soon!';
update public.wa_templates set body_preview = 'Hi {{1}}, this is an update for {{2}} that needs your attention: {{3}}. Please open your Branditude app to see the details and take action. Thank you.'
 where name = 'gc_owner_alert' and business_id is null;
update public.wa_templates set body_preview = 'Hi {{1}}, here is your sales summary for {{2}} on {{3}}.

Total sales: {{4}}
Number of bills: {{5}}
Payment collected: {{6}}
Still pending: {{7}}
Busiest station: {{8}}

You can see the full report in your Branditude app. Thank you for using Branditude.'
 where name = 'gc_daily_report' and business_id is null;
