# Branditude Growth Plan

A growth platform that Branditude sells to local businesses (cafés, salons, clinics, gyms, shops…).
Three kinds of login, one database:

| Login | Who | How they sign in | What they can do |
|---|---|---|---|
| **Super admin** | Branditude owners | Email + password | Everything below, plus manage the team and agency settings |
| **Team** | Branditude staff | Email + password | Leads, businesses, reports, payments, packages, package discounts, categories, category services, WhatsApp packs & templates |
| **Business** | Your clients | Email + password (created when they buy a plan on the store) | Log visits, customers, Google reviews, feedback inbox, coupons, loyalty card, WhatsApp (optional, paid per message), plan & billing |
| **Customer** *(optional)* | The business's own customers | Phone number + OTP | See their loyalty cards, offers, visit history; rate a visit. Read-only: loyalty is managed by the business |

The public **store** (`index.html`) shows packages, discounts and category-specific services live from the database. Businesses register and pay there.

---

## What's in the repo

```
supabase/
  migrations/20261108000001_platform.sql   tables, roles, row-level security, all business logic (RPCs)
  migrations/20261108000002_seed_catalogue.sql   10 categories, 3 packages, 16 category services, WhatsApp packs & templates
  functions/whatsapp-send/index.ts         Edge Function: sends WhatsApp template messages, charges credits, refunds failures
web/                                       static site, no build step. Host anywhere
  index.html      public store + registration + UPI checkout
  login.html      sign-in for business, customer (OTP) and Branditude team
  app.html        portal; opens the admin, business or customer app by role
  f.html          public feedback page per business: f.html?b=<business-slug>
  assets/js/      config.js (your keys), sb.js, ui.js, admin.js, business.js, customer.js
  assets/css/app.css
tests/
  test_platform.sql          database tests for every role (run against local Postgres)
  supabase_stub.sql          minimal Supabase auth stub for local testing
  fake-supabase/             local stand-in used to click through the UI end to end
```

## Business rules built in

- **Packages** have monthly + yearly prices and an optional sale discount (%). **Package discounts** (promo codes) can be % or ₹, limited to some packages, with an end date and max uses. Prices are always calculated on the server (`quote()`), so a buyer can't change the amount.
- **Categories** are chosen at registration. Admins can add more. **Category services** (e.g. Zomato & Swiggy optimisation for cafés and bakeries) are offered only to the categories you tick. Services with no category ticked are offered to everyone.
- **Payments** are UPI with a transaction ID (UTR). A team member confirms it in *Payments*. Confirming a plan activates the business and sets the renewal date. Confirming WhatsApp credits adds them to the business's balance.
- **WhatsApp is optional and charged per message.** Businesses buy prepaid credit packs (prices set by admin). Each message uses the template's credits, which are reserved before sending (no overdraw), and failed messages are refunded automatically. Without credits, WhatsApp is off.
- **Loyalty card**: the business sets the number of visits (2–20), rewards on any visit (% off, ₹ off, or a free item worth up to ₹X), and the final reward. The card resets after the final reward. If a coupon and a loyalty reward apply on the same visit, the bigger one is used. They don't stack.
- **Feedback**: 4–5★ go to the Google review page. 1–3★ are invited to tell the owner privately and land in the Feedback inbox and Alerts. **Everyone can still reach Google**: Google's review policy and India's IS 19000:2022 don't allow hiding the review option from unhappy customers.
- **Free trial**: new businesses get a free trial (default 3 days, set in Admin → Settings; 0 turns it off) with everything unlocked except WhatsApp sending. One trial per business phone number. After the trial the account is read-only until the plan payment is confirmed, but entering a UPI transaction ID keeps it open while the team checks. A plan paid after a trial starts that day.
- **Star routing**: 4–5★ customers write a few words in **their own words**; the `review-polish` function (or a local tidy without the AI key) fixes spelling and grammar only and offers a short version, a tidied version and their original. They pick one, it's copied, and Google's review form opens. Nothing is added: no keywords, no claims. 1–3★ get a private "Send privately to the owner" form first; a small, clearly labelled "post a public review on Google" link always stays visible (Google and IS 19000 require that). The counter screen keeps showing the Google QR to 4–5★ customers (owner's choice).
- **Google auto-reply** (business portal → Google replies): the owner connects their Google Business Profile once. Every hour, `gbp-sync` pulls new reviews and replies with AI (or templates). Modes: auto-reply 4–5★ and draft 1–3★ for approval (default), auto-reply all, drafts only, or off. Up to 10 replies per business per sync, 80 AI replies per day.
- **Keywords & SEO**: the agency keeps suggested search phrases per category (Admin → Keyword suggestions, `{city}` is filled in). Each business picks up to 15 and adds its own, then drafts its Google profile description, Google posts, FAQ and replies to reviews with them. Keywords are **never** put into customer reviews (Google forbids directing review content). AI drafts use Claude through the `ai-content` Edge Function (secret `ANTHROPIC_API_KEY`, 40 drafts per business per day); without the key the app writes from templates.
- **Paused / cancelled businesses** can still see their data but can't change anything.
- Database time zone is Asia/Kolkata, so "today", trial ends and renewals follow Indian dates.
- **Customers** only ever see rows that match their own verified phone number.

---

## Live project

- **Website:** https://kunalahuja392.github.io/branditude-growth-plan/ (store) · `/login.html` (sign in) · `/app.html` (portals). Every push to `main` that touches `web/` redeploys automatically (`.github/workflows/pages.yml`).
- Supabase Auth Site URL and redirect allow-list point at this address.

- Supabase project: **branditude-growth-plan** (`dumninwceiqvevndpupc`, Mumbai). Schema, catalogue and the `whatsapp-send` function are deployed. `web/assets/js/config.js` already points at it.
- Super admin: kunalahuja392@gmail.com. Change the password after the first sign-in.

## Setup from scratch (about 30 minutes)

### 1. Supabase project
1. Create a project at supabase.com (region: Mumbai `ap-south-1`).
2. **SQL Editor →** run the three files in `supabase/migrations/` in order.
   *(Or with the CLI: `supabase link --project-ref <ref>` then `supabase db push`.)*
3. **Authentication → Providers**
   - Email: on. Turning off "Confirm email" makes sign-up instant. If you leave it on, the app finishes registration after the first sign-in.
   - Phone: on, with an SMS provider (MSG91, Twilio, Vonage or TextLocal) for customer OTP. For India you also need DLT registration for the OTP SMS template.
4. **Authentication → URL configuration:** Site URL = your website (e.g. `https://branditudeglobal.com`). Add `https://branditudeglobal.com/app.html` to Redirect URLs.

### 2. Website
1. Put your project URL and **anon** key in `web/assets/js/config.js` (Project Settings → API). The anon key is meant to be public, and row-level security protects the data.
2. Host the `web/` folder on any static host:
   - **GitHub Pages:** push the repo, then Settings → Pages → deploy from branch, folder `/web` (or move `web/*` to `/docs`).
   - **Netlify / Vercel / Cloudflare Pages:** publish directory `web`, no build command.
3. Point `branditudeglobal.com` at the host.

### 3. Your first super admin
Sign up once (store checkout or Supabase → Authentication → Add user), then in SQL Editor:
```sql
update public.profiles set role = 'super_admin' where email = 'you@branditudeglobal.com';
```
Then sign in on `login.html` → **Branditude team** tab. Add teammates from **Team**. They need to create an account first.

### 4. Agency settings (in the admin portal)
**Settings:** brand and legal name, WhatsApp number, phone, email, address, **UPI ID** (shown at checkout), GSTIN, GST rate.

### 5. AI writing (optional)
Create an API key at console.anthropic.com, then: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` (or Supabase → Edge Functions → Secrets). Optional `AI_MODEL` (default `claude-haiku-5-5`).

### 5b. Google auto-reply (needs Google's approval, once for the agency)
1. In Google Cloud Console (signed in as Branditude), create a project. Enable **My Business Account Management API** and **My Business Business Information API**.
2. **OAuth consent screen**: External, app name "Branditude Growth Plan", add scope `https://www.googleapis.com/auth/business.manage`, then publish it.
3. **Credentials → OAuth client ID** (Web application). Authorised redirect URI: `https://dumninwceiqvevndpupc.supabase.co/functions/v1/gbp-callback`.
4. Submit Google's **Business Profile API access request** form with the project number. Until Google approves it, the API quota is 0 and connecting fails with a "quota 0" message. Google says it reviews requests within about 14 days, and approval isn't guaranteed. After approval, also enable the **Google My Business API** (it only appears then).
5. Supabase → Edge Functions → Secrets: add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Optional `SITE_URL` if the site moves to a custom domain.
The hourly job (`pg_cron`, migration `…08_gbp_cron.sql`) authenticates with a secret generated inside the database; nothing to set.

### 6. WhatsApp add-on (optional)
1. In Meta Business Manager: create a WhatsApp Business Account, add and verify a phone number, and create a **permanent system-user token** with `whatsapp_business_messaging`.
2. Create message templates in WhatsApp Manager **with the same names** as in Admin → WhatsApp (`festival_offer`, `we_miss_you`, `birthday_wish`, `loyalty_update`, `review_request`). `{{1}}` is always the customer's first name.
3. Deploy the function:
   ```bash
   supabase secrets set WA_TOKEN=xxxx WA_DEFAULT_PHONE_NUMBER_ID=1234567890
   supabase functions deploy whatsapp-send
   ```
4. Price your credit packs above Meta's per-message charge for India (check Meta's current rate card), plus your margin.
   A business can also get its own sender number. Put its phone-number id on the business in Admin → Businesses.

---

## Testing locally

Database tests (needs Postgres 15+):
```bash
createdb bgp
psql -d bgp -f tests/supabase_stub.sql -f supabase/migrations/20261108000001_platform.sql -f supabase/migrations/20261108000002_seed_catalogue.sql
psql -d bgp -f tests/test_platform.sql      # ends with "ALL TESTS PASSED"
```
They cover: anonymous store access, registration, a business can't activate itself or see another business, the visit → coupon → loyalty logic, the customer seeing only their own data, the public feedback link, team vs super-admin permissions, payment confirmation, WhatsApp credit reserve/overdraw/refund, and paused accounts going read-only.

Click-through UI test against the same database: `node tests/fake-supabase/server.mjs 8787 web` (edit the psql connection at the top of the file), then open `http://localhost:8787`.

## Next steps worth building
1. Razorpay / Cashfree payment links with webhooks, for automatic payment confirmation and GST invoices (PDF).
2. WhatsApp delivery/read webhooks and a low-credit alert.
3. Business staff logins (the `business_members` table already supports `staff`).
4. Multi-location for the Pro package (`max_locations` is stored, but locations aren't modelled yet).
5. Google Business Profile API: pull reviews and reply from the app.
6. PWA install and push notifications for business owners.
