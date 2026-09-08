# SA'DA H2O — Installation Booking + Warranty (v27)

Booking app for SA'DA H2O RO water purifier installations across Saudi Arabia's
Eastern Province. Vanilla HTML + Supabase JS from CDN. No build step.

## What's new in v26

**Customer flow**
- 2-day lead time now enforced on the **Reschedule** flow in the customer portal.
  Booking (`customer/book.html`) and Book-Again (`customer/portal.html`) already
  had it. Reschedule now matches: min date = today + 2, plus a JS re-check
  before the DB writes.
- **Returning customer detection is bulletproof.** `sendOTP()` in `book.html`
  now falls back to the `bookings` table when there's no `customers` row (e.g.
  legacy customers who booked before the customers table existed). Any hit →
  skip the 4-step wizard, straight to `customer/portal.html`.
- Phone normalization: `admin/dashboard.html`'s add-customer flow now stores
  `+9665XXXXXXXX` format instead of raw input. The v26 migration back-fills
  existing rows.

**Security (RLS lockdown — v26 migration)**
- `sms_settings`: UPDATE/INSERT/DELETE are admin-only (was: anon could disable
  OTP with one query).
- `customers`: DELETE is admin-only. UPDATE narrowed so anon cannot change
  another row's phone (was: anon could delete/rename anyone).
- `bookings`: DELETE is admin-only. UPDATE narrowed to `status ∈ {upcoming,
  cancelled}` + slot-changes; installer_id / booking_type / completion /
  proof fields are immutable via anon. Trigger enforces the OLD→NEW delta.
- `installers`: anon can still read `id`, `name`, `is_active` (needed by the
  customer portal's booking join). `email`, `phone`, `created_at` are now
  hidden from anon (was: full PII exposed).
- Server functions and the DigitalOcean SMS relay are **unchanged**. They use
  the service role and bypass RLS as before.

**Cleanup**
- Netlify support removed. No more `netlify/` folder, no `netlify.toml`, no
  runtime `isNetlify` branching in `customer/book.html` or `admin/dashboard.html`.
  STC blocks Netlify in KSA anyway.
- README now matches the shipping code.

## v27 — Warranty CRM merged in

The standalone PHP/MySQL warranty CRM that lived at `h2o.sadawater.com/regis/`
is now part of this app. Same rules, same field names, same 90/365/730-day
terms — ported, not redesigned.

**New tables** (see `migrations/v27_warranty_schema.sql`):
`warranties`, `product_models`, `warranty_service_history`, `customer_followups`,
plus a nullable `bookings.warranty_id` link (no UI yet — wire it when a customer
with two units books a service).

**New pages**
- `warranty/claim.html` — the QR sticker landing page. Honours the same
  `?pid=` contract printed on every unit in the field.
- `customer/portal.html` → **My Units** tab: coverage gauges + service history.
- `admin/dashboard.html` → **Warranties** and **Follow-ups** panels, plus a
  per-customer units view from the Customers panel.

**Auth**: passwords are gone. The CRM used phone + bcrypt; this app uses phone +
SMS OTP. OTP wins. The 13 imported customers had deliberately unusable random
passwords and could never log in — OTP gives them access for the first time.

**Follow-ups are internal.** They contain notes like "Said 'we will manage
ourselves'". RLS is admin-only and `anon` is `REVOKE`d — never surface them
in the customer portal.

### Cutover (V1 — no DNS change)

The landing page and DNS stay on LiteSpeed. Only `/regis/` changes.

1. Freeze `/regis/` (stop new registrations).
2. Fresh MySQL export → regenerate `v27_warranty_data.sql` from it.
3. Run `v27_warranty_schema.sql` then `v27_warranty_data.sql` in Supabase.
4. Replace `/regis/` with the 4-line `regis_index.php` shim; delete the other
   15 PHP files. **Keep that shim forever** — every sticker in the field
   depends on it.
5. Drop the `sadawater_h2o_warranty` MySQL database once you're happy.

`vercel.json` also rewrites `/regis` and `/booking` on the Vercel domain, so
both work there too if you ever point DNS at Vercel.

### Known / deliberate

- **Timezone**: the legacy MySQL `DATETIME`s carry no zone and the source
  server's zone could not be determined. The import assumes `Asia/Riyadh` —
  one line at the top of `v27_warranty_data.sql`. Worst case if wrong: expiries
  land 3h early on a 90-day timer. `registration_date` is a real DATE and
  imports exactly either way. Settle it with `SELECT NOW();` in phpMyAdmin.
- **22 orphaned history rows dropped**: `service_history` had no FK in the
  source, so deleting a warranty orphaned its history. Those rows are already
  unreachable in the PHP app. 84 of 106 import.
- **`anon` can still SELECT warranties** with the public key, same as
  `bookings`/`customers` today. Closing that needs customer session tokens —
  a separate piece of work, not done here.
- `quantity` is kept as-is. Warranty #57 has `quantity=2` on one sticker (an
  import artifact); the portal shows "×2 units on this record" rather than
  pretending it's one.

## Migrations — run in this order

Fresh Supabase: run these top-to-bottom in the Supabase SQL editor.

```
1. supabase_schema.sql             — base tables
2. sql/002_inspection_reports.sql  — inspection reports feature (v22-era)
3. migrations/v22_polish.sql       — security overhaul + admin_emails + is_admin()
4. migrations/v23_self_serve.sql   — installer self-serve claim + realtime
5. migrations/v25_service_regions.sql   — service regions + reverts auto-assign
6. migrations/v26_rls_lockdown.sql   — RLS lockdown
7. migrations/v27_warranty_schema.sql — warranty tables + RLS
8. migrations/v27_warranty_data.sql   — warranty data import (AT CUTOVER, from a fresh export)
```

`migrations/v24_auto_assign.sql` is retained in the repo for historical
completeness but is **superseded by v25** — do NOT run it on a fresh DB.

Every migration is idempotent — re-running is safe if you're partway through.

## Env vars (Vercel only)

Vercel → Settings → Environment Variables:
```
SUPABASE_URL              = https://ykgtrloptgazeqjgxney.supabase.co
SUPABASE_SERVICE_ROLE_KEY = <from Supabase Dashboard → Settings → API>
```

## Vercel project settings

- Root Directory: `sada-water`
- Framework Preset: Other
- No build command needed. `vercel.json` is empty by design — Vercel infers.
- Node runtime: 24.x (from `package.json`).

## URLs

- Primary: https://sada-water-booking.vercel.app
- Custom domain: h2o.sadawater.com → Vercel

## Files that matter

| Path | Purpose |
|------|---------|
| `admin/login.html` | Admin sign-in |
| `admin/dashboard.html` | Bookings, slots, installers, customers, SMS, reports |
| `installer/login.html` | Installer sign-in |
| `installer/portal.html` | Installer's own bookings + inspection reports + proof upload |
| `customer/book.html` | 4-step booking wizard (public). Skips to portal for returning customers. |
| `customer/portal.html` | Returning customer: view / cancel / reschedule / book again |
| `shared/supabase.js` | Anon client + shared helpers |
| `api/send-sms.js` | Vercel: SMS relay + throttle |
| `api/admin/user-ops.js` | Vercel: installer create/delete/reset-password |
| `api/admin/_auth.js` | Vercel: admin JWT verification |
| `api/notify-installers.js` | Vercel: broadcast SMS on new booking |
| `api/notify-report.js` | Vercel: SMS on inspection report submit |
| `assets/*.png` `assets/manifest-*.json` | PWA icons + manifests |
| `css/inspection-report.css` `js/inspection-report.js` | Inspection report drawer (loaded by admin + installer) |
| `migrations/*.sql` `sql/*.sql` | See migration order above |
| `supabase_schema.sql` | Base tables |

## SMS relay (unchanged)

DigitalOcean droplet `206.189.42.165:443` runs a PM2-managed Node process at
`/root/sms-relay/server.js` that forwards to Taqnyat (Bearer token in that
file, sender `SADA.co`). Whitelisted static IP required by Saudi telecom law.
Vercel functions proxy to it with `rejectUnauthorized: false` (self-signed
cert on the droplet). Never put the Taqnyat Bearer in this repo.

## Adding another admin

```sql
INSERT INTO admin_emails (email) VALUES ('other-admin@example.com');
```
Then Supabase Dashboard → Authentication → Users → Add user (email + password), confirm the email.
