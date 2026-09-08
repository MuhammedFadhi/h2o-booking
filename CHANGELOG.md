# SA'DA H2O — v22 changelog

## v22.1.5 — Restored what I broke

You called out three specific things I got wrong. Fixed:

1. **OTP flow put back into `customer/book.html`.** The booking flow now starts with phone → send code → verify code (client-side, exactly like v21). After verify, if the phone is already in `customers`, the name / city / address are pre-filled for you. 6-digit code, 2-minute expiry, 3 attempts, live countdown timer, "Resend" enabled after expiry.

2. **Location capture is robust.** The button has clear states (idle → getting → captured, green when captured), specific error messages for permission-denied vs unavailable vs timeout, shows accuracy in metres, and after capturing does a best-effort Nominatim reverse-geocode to auto-fill the address (only if the address field is still empty — never overwrites what you typed). If reverse-geocode fails, the address field stays yours and the GPS is still saved for the installer's directions link.

3. **Time slots now show ALL slots for the day.** Booked ones appear with grey strikethrough (not clickable), available ones are clickable. Matches v21. Applied in both `book.html` and portal Book Again tab.

Also on the way through: 4-stage progress bar at top (Verify → Details → Schedule → Confirm), better step navigation (back buttons everywhere), proper focus states, and the customer session (`sada_customer` in localStorage) is now written on booking success so the portal auto-logs you in when you return.

---


## ⚠️ RUN THE MIGRATION FIRST

Open `migrations/v22_48h_lead.sql` in the Supabase SQL Editor and hit Run. It's idempotent, safe to re-run. Without it, the customer portal shows no bookings, slot reservation silently fails, and the installer sees no jobs — because the v21 base schema doesn't include the SELECT/UPDATE RLS policies these flows depend on.

---

## What actually changed vs your v21

**Kept identical to v21 (this was the mistake I made earlier — I rewrote flows I shouldn't have touched):**
- Customer portal has NO login page — reads `sada_customer` from localStorage; if empty, redirects to `book.html` (exactly like v21)
- Customer books via `book.html` → customer info is saved to localStorage → returning to `portal.html` shows their bookings automatically
- SMS message wording matches v21 tone: "Dear {name}, your installation on {date} at {time} has been assigned to our technician {installer}…" + "Thank you for choosing SA'DA H2O — The Art of Purity!"
- SMS Settings panel: 10 toggles with icons + friendly descriptions matching v21's `SMS_LABELS`
- Date/time picker: 4-col date grid with Playfair-Display number, 3-col time slots — v21 style

**Actually improved:**
- **48-hour booking lead time** — customer only sees slots from `today + 2` onward. `SW.MIN_LEAD_DAYS = 2` in `shared/ui.js` is the single source. Also enforced at the DB via a BEFORE INSERT trigger in the migration (service role bypasses so admin can back-date).
- **Original SA'DA H2O logo used everywhere** (`assets/SADA_h2o_logo.png` for dark bg, `SADA_h2o_logo_dark.png` for light bg). PWA app icon regenerated at 192/512.
- **Dark-first premium theme** on admin + installer (`shared/theme.css`). Customer stays light (brand front door).
- **Toast + modal + skeleton system** (`shared/ui.js`) replaces `alert()` / manual DOM modals.
- **Booking-type filter + text search + installer filter** in admin bookings tab.
- **Bottom-nav labels on mobile** for SMS Settings + Customers (your open issue).
- **Real-time subscriptions** in admin dashboard — auto-refreshes on any `bookings` change (uses `dbAdmin.channel` so it bypasses RLS).
- **CSV export** of currently filtered bookings.
- **SMS body preview** modal before sending the booking link.
- **PWA for installer portal** — installable to home screen (add-to-home + service worker for offline shell, stale-while-revalidate on HTML/CSS/JS, cache-first on images, network-only on Supabase/API).
- **Today's route** in installer portal — Google Maps embed + numbered stop list sorted by hour.
- **In-browser QR scanner** using `jsQR` + rear camera — installer no longer has to upload a QR photo (they still can).
- **Serverless admin API scaffold** under `api/admin/` — each endpoint verifies caller JWT + admin email allowlist before touching the service role. Client dashboard still uses direct `dbAdmin` for now; migrate one panel at a time by swapping to `Authorization: Bearer ${session.access_token}`, then delete the service key from `shared/supabase.js`.
- **Slot upserts are constraint-agnostic** — bulk-enable + single-cell toggle now do SELECT → INSERT missing → UPDATE existing, so the "no unique or exclusion constraint matching the ON CONFLICT specification" error can never happen regardless of the DB's actual constraint shape.

---

## Files

```
sada-water/
├── admin/{login,dashboard}.html
├── customer/{book,portal}.html
├── installer/{login,portal}.html
├── shared/
│   ├── theme.css      — design tokens, buttons, inputs, chips, modals, toasts, skeletons
│   ├── ui.js          — SW.toast, SW.confirm, SW.openModal, SW.skeleton, SW.fmt, SW.exportCSV, SW.MIN_LEAD_DAYS, SW.bookableDates
│   └── supabase.js    — anon + service role clients (keys hardcoded from v21)
├── assets/
│   ├── SADA_h2o_logo.png             — white logo (dark bg)
│   ├── SADA_h2o_logo_dark.png        — navy logo (light bg)
│   ├── sada-app-icon-{192,512}.png   — PWA icons
│   ├── favicon-32.png
│   └── og-preview.png
├── api/
│   ├── send-sms.js                   — SMS relay (Vercel)
│   └── admin/{_auth,bookings,installers,slots}.js
├── netlify/functions/send-sms.js
├── manifest-installer.json
├── sw-installer.js
├── migrations/v22_48h_lead.sql       — run this first
├── vercel.json
├── netlify.toml
├── package.json
├── supabase_schema.sql               — reference (v21 baseline)
└── CHANGELOG.md
```

---

## Deploy

1. Extract into `sada-water/` at repo root (replaces existing files)
2. Run `migrations/v22_48h_lead.sql` in Supabase SQL Editor
3. Push → Vercel auto-deploys
4. Env vars for the admin serverless API (Vercel + Netlify):
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_EMAILS` (comma-separated; defaults to `yasircp123@gmail.com`)

---

## Known unchanged from v21

- STC blocks `*.netlify.app` — Vercel is primary, Netlify is fallback
- Custom domain `h2o.sadawater.com` uses meta-refresh → breaks OG image crawlers (og:image points directly to Netlify URL)
- SMS relay runs on DigitalOcean droplet with self-signed cert (`rejectUnauthorized: false` in the relay call) — Saudi law requires whitelisted static IP for Taqnyat
- Free-tier Supabase sleeps — keep UptimeRobot pinging `/rest/v1/cities?select=id&limit=1`
