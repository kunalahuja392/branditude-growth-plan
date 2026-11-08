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
- **Paused / cancelled businesses** can still see their data but can't change anything.
- **Customers** only ever see rows that match their own verified phone number.

---

## Setup (about 30 minutes)

### 1. Supabase project
1. Create a project at supabase.com (region: Mumbai `ap-south-1`).
2. **SQL Editor →** run `supabase/migrations/20261108000001_platform.sql`, then `…000002_seed_catalogue.sql`.
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

### 5. WhatsApp add-on (optional)
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
