# SA'DA H2O — Booking & Warranty System

**How it all works.** A reference for maintaining, extending, or handing off the system.
Last verified against production: 26 July 2026.

---

## 1. What this system is

A browser-only web app that runs the full lifecycle of a SA'DA H2O water-purifier
sale: a customer books an installation online → an installer completes the job and
scans each unit's QR → each unit becomes a warranty → the warranty drives filter/service
reminders. Admins manage all of it from one dashboard.

There is **no build step and no server code** beyond a small SMS relay. Everything is
static HTML + the Supabase JavaScript client loaded from a CDN. Edits are made in the
GitHub web editor and deploy automatically via Vercel.

---

## 2. Infrastructure

| Piece | Value |
|---|---|
| Repo | `ETH3R-YSR/sada-water-booking`, working folder `sada-water/` |
| Hosting | Vercel (auto-deploy on push to GitHub). **Not** Netlify — STC blocks it via DNS. |
| Live app | `sada-water-booking.vercel.app` |
| Marketing site | `h2o.sadawater.com` |
| Database | Supabase project `ykgtrloptgazeqjgxney` (Bahrain region) |
| SMS relay | DigitalOcean droplet `206.189.42.165:443`, Taqnyat sender `SADA.co` |
| Admin login | via Supabase Auth (email/password) |

The Supabase **anon key** is hard-coded in `shared/supabase.js` by design — the public
booking page needs it. What the anon role may and may not do is controlled by Row-Level
Security (RLS), not by hiding the key. The **service key** is only ever used server-side
(in the SMS relay / serverless functions), never in the browser.

---

## 3. The data model

The whole system is five tables and the links between them.

```
  leads (pipeline: interest → won)          [conceptual/optional]
    │  matched by phone
    ▼
  bookings ──< booking_items                one booking, many product lines
    │              (2× RO + 1× dispenser)
    │  slot_id
    ▼
  availability_slots                         the schedule; is_booked guards double-booking
    │
    │  on install completion, one warranty per serialized (RO) unit
    ▼
  warranties ──< warranty_service_history    filter/service events over time
    │
    ▼
  customers                                  keyed by phone (+9665XXXXXXXX)
```

**The phone number is the customer identity key.** Everything ties back to a customer by
their normalized `+9665XXXXXXXX` phone. `formatSaudiPhone()` / `isValidSaudiPhone()` in
`shared/supabase.js` do the normalization.

### Key tables

- **`customers`** — one row per phone. `name` can be null (QR-registered customers who
  never gave a name); the system backfills it from bookings when it can.
- **`bookings`** — one installation appointment. Holds a *summary* product
  (`product_model` / `product_qty`) plus the full basket in `booking_items`. Links to a
  slot (`slot_id`), an installer (`installer_id`), and a representative warranty
  (`warranty_id`). `booking_reference` (e.g. `SW-20260726-5AEB61`) is set by a trigger.
- **`booking_items`** — the product basket: one row per product line
  (`product_model`, `qty`, `unit_price`, `is_serialized`). ROs are serialized (need a QR),
  dispensers are not.
- **`availability_slots`** — the schedule. `is_booked` is the flag that prevents
  double-booking. Each slot belongs to a `service_region_id`.
- **`warranties`** — one row **per physical unit** (`quantity` = 1 each). `qr_code` is the
  unit's serial. Links to its `customer_id` and originating `booking_id`. `status` is
  active/paused/deactivated; `service_opted_out` suppresses reminders while keeping
  coverage valid. Dispensers get **no** warranty.
- **`warranty_service_history`** — filter changes and services. `source` records whether
  it was a SA'DA job or customer self-reported.
- **`product_models`** — the catalogue. `is_catalogue` = shown in the booking picker;
  `is_serialized` = needs a QR; `price_sar` = price. Legacy model names (A100, A1UV…)
  remain here for old warranties' history but aren't sold going forward.

### The current catalogue (5 products)

| Model | Price (SAR) | Serialized (QR + warranty)? |
|---|---|---|
| RO Water Dispenser (Hot/Cold) | 499 | **No** |
| 7-Stage RO Purifier | 699 | Yes |
| 7-Stage RO Purifier + UV | 999 | Yes |
| 6-Stage Smart RO | 1,199 | Yes |
| 7-Stage Smart RO | 1,299 | Yes |

---

## 4. The three interfaces

### Customer booking — `customer/book.html`
Public, no login. Steps: identify by phone (OTP) → name/area/address → **choose products
(basket) + a time slot** → confirm. Booking is created by the atomic `create_booking` RPC
(see §5), then the basket is written to `booking_items`.

### Admin dashboard — `admin/dashboard.html`
Login required. Overview (today's schedule, attention lists, orphaned-slot cleanup),
Bookings (assign installer, reschedule, complete, cancel, edit product), Warranties
(activate, edit product/qty, mark serviced, opt-out, pause/deactivate), Customers,
Follow-ups, Activity log, Installers, SMS settings.

### Installer portal — `installer/portal.html`
Passcode login. Installer sees assigned jobs, files the inspection report, then completes
the job: uploads an install photo and **scans a QR per RO unit** (a per-unit checklist —
"Unit 1 of 2…"). Dispensers are skipped. Each scanned RO activates its own warranty.

---

## 5. How the important flows actually work

### Booking is atomic (prevents the "slot just booked" bug)
Booking a slot is **one** server-side transaction, the `create_booking` RPC. It locks the
slot row, checks it's free and in the right region, reserves it, and inserts the booking —
all or nothing. This eliminated a real bug where a slot could be marked booked but no
booking created (network drop / phone backgrounding mid-flow), stranding the slot as
permanently unbookable. Never revert booking to a two-step reserve-then-insert.

### Orphaned slots self-heal
A slot can still leak from an abandoned admin **reschedule** (rare). The Overview shows a
banner with a one-click "Free them" whenever any slot is marked booked with no active
booking behind it. `freeOrphanedSlots()` does the cleanup safely.

### One warranty per unit
A booking can install several units. `warranties.booking_id` is the authoritative
"many" side — many warranties can point to one booking. `bookings.warranty_id` holds just
one representative (a column can only hold one value); to see *all* units of a booking,
query warranties by `booking_id`. There is **no** one-warranty-per-booking constraint (it
was removed — it was wrong for multi-unit installs).

### Dispensers have no QR and no warranty
Detected by `is_serialized = false` on the product (name contains "dispenser"). The
installer's scan checklist skips them; no warranty is created; they generate no reminders.

### Names fill in automatically
If a customer registered by phone with no name but has a booking that carries one, the
name is copied to their customer record — at activation time and via the v33 backfill.
Two customers legitimately have no name anywhere; that's expected, not a bug.

### Reminders
Filter (90-day) and service (365-day) due dates live on each warranty. The 🔔 action sends
due reminders via the existing SMS relay — manual trigger, no cron by design. Opted-out
and non-serialized (dispenser) units are excluded.

---

## 6. Deploying a change

1. **If the change needs a schema change**, write a new numbered migration
   (`migrations/vNN_*.sql`) and **run it in the Supabase SQL editor first** — the code
   depends on the schema existing.
   - Migrations are **not** auto-applied. Run them manually, in order.
   - The SQL editor runs a file as one transaction: if any statement fails, the whole
     file rolls back (nothing partially applies — safe to fix and re-run).
   - All migrations here are written to be idempotent (`IF NOT EXISTS`, `ON CONFLICT`),
     so re-running a migration is safe.
2. **Then push the code** to GitHub → Vercel auto-deploys.
3. **A migration and its code are a pair.** Skipping the migration but pushing the code
   (or vice-versa) is the most common failure — the app errors on a missing column. If
   something breaks right after a deploy, first check the matching migration actually ran.

Migrations to date: v22–v35. The most recent significant ones:
- **v31** — atomic `create_booking` RPC
- **v32** — booking↔warranty links, service opt-out, self-reported service
- **v33** — backfill customer names from bookings
- **v34** — product catalogue + prices + product on bookings
- **v35** — `booking_items` (multi-product baskets) + serialized flags

---

## 7. Known constraints & gotchas

- **STC blocks Netlify** via DNS in Saudi Arabia — always deploy on Vercel.
- **No local terminal / no build step** — all edits via the GitHub web editor.
- **Anon can insert bookings/warranties and update slots** (needed for public booking and
  installer auto-activation) but **cannot delete bookings** — deletes are admin-only. This
  is why a test booking can't be removed from a public session; delete it from admin.
- **The SMS relay path is off-limits** to casual edits — `api/send-sms.js` and the droplet
  are wired to Taqnyat; changing them risks breaking all SMS.
- **Two vocabularies for products** — old warranties use legacy names (A100, A1UV, …);
  new sales use the 5-product catalogue. Both are valid; they coexist deliberately.

### The one open risk — authentication
Customer login is an OTP verified **client-side**, with the session stored in
`localStorage`. In practice this means anyone who knows a phone number could access that
customer's account. This is a known, deliberately-deferred decision — noted here for
completeness, not as an active bug. Revisit it if customer-account privacy becomes a
requirement.

---

## 8. Current scale (26 Jul 2026)

98 customers · 78 bookings · 82 warranties · 79 booking items · 5 installers ·
379 slots · 5 catalogue products.

---

## 9. Where things live

```
customer/book.html        public booking (basket + slot + atomic RPC)
admin/dashboard.html       the admin app (bookings, warranties, everything)
installer/portal.html      installer field app (per-unit QR scan, auto-activation)
shared/supabase.js         anon client, phone helpers, formatHour, shared globals
js/warranty.js             warranty helpers (dates, milestones, model-image join)
js/inspection-report.js    inspection report logic
api/send-sms.js            SMS relay bridge (DO NOT casually edit)
api/notify-installers.js   broadcasts a new booking to installers
api/notify-report.js       report notifications
migrations/vNN_*.sql       run in Supabase SQL editor, in order, before pushing code
```
