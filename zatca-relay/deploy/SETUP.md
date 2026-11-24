# ZATCA signing relay — server setup (simulation first)

This puts the signing relay on the **same relay server as the SMS relay**
(`185.214.134.177`, PM2), behind HTTPS at **`zatca.sadawater.com`**, and connects it
to the dashboard. After step 7 the dashboard's ZATCA page works like Al Amanah's:
paste an OTP, click Onboard, and the certificates are issued.

Time needed: about 30–45 minutes.

## What you need before starting

- [ ] SSH access to the server as `root`
- [ ] Access to the `sadawater.com` DNS (to add `zatca.sadawater.com`)
- [ ] Access to the Cloudflare dashboard (Workers)
- [ ] **Saadat Alarab Company For Trading's 10-digit TIN** (from the accountant or the
      ZATCA portal — needed because SA'DA invoices inside a VAT group)
- [ ] A login to the **Fatoora portal** (for the OTP, step 7)
- [ ] Decision: **B2C only** (simplified invoices — current setting) or **also B2B**?
      It is fixed into the certificate at onboarding.

---

## 1. DNS

Add an **A record**: `zatca` → `185.214.134.177`
If the DNS is on Cloudflare, set it to **DNS only (grey cloud)** so step 4's
certificate request can reach the server.

Check (from any computer): `nslookup zatca.sadawater.com` shows `185.214.134.177`.

## 2. Copy the relay to the server

From the project folder on your computer (PowerShell or Git Bash):

```bash
scp -r zatca-relay root@185.214.134.177:/root/zatca-relay-src
```

Only the code is copied — there is no `.env` or `secrets/` on your computer.

## 3. Install

```bash
ssh root@185.214.134.177
cd /root/zatca-relay-src
bash deploy/install.sh
```

It checks Node and openssl, installs the relay into `/root/zatca-relay`, creates
`.env` with a new random **relay key**, runs the self-test and starts it under PM2
as `zatca-relay`. **Copy the relay key it prints** — you need it in step 5.

Then add the member TIN:

```bash
nano /root/zatca-relay/.env          # set EGS_ORG_UNIT_NAME=<10-digit TIN>
pm2 restart zatca-relay --update-env
pm2 logs zatca-relay --lines 20      # should say: ZATCA relay [simulation] on 127.0.0.1:8791
```

(B2B too? Also set `EGS_INVOICE_TYPE=1100` now, before onboarding.)

## 4. HTTPS with nginx

The relay listens on `127.0.0.1` only; nginx gives it a public HTTPS address.
First check what serves the SMS relay: `nginx -v` (if nginx is installed, continue;
if the SMS relay uses something else, set up the same thing for this hostname —
forward to `127.0.0.1:8791`, allow 4-minute timeouts).

```bash
cp /root/zatca-relay/deploy/nginx-zatca.sadawater.com.conf /etc/nginx/sites-available/zatca.sadawater.com
ln -s /etc/nginx/sites-available/zatca.sadawater.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d zatca.sadawater.com      # free certificate, renews automatically
```

(No certbot? `apt install certbot python3-certbot-nginx`.)

Check:

```bash
curl https://zatca.sadawater.com/health     # {"ok":true,"env":"simulation"}
curl https://zatca.sadawater.com/status     # {"error":"Unauthorized"}  <- correct, it needs the key
```

Do **not** open port 8791 in the firewall — only 80/443 (already open for the SMS relay).

## 5. Connect the dashboard (Cloudflare)

Cloudflare dashboard → **Workers & Pages** → the Worker that serves
**dev-booking.sadawater.com** → **Settings → Variables and Secrets** → add two
**Secrets**:

| Name | Value |
|---|---|
| `ZATCA_RELAY_URL` | `https://zatca.sadawater.com` |
| `ZATCA_RELAY_KEY` | the relay key from step 3 (also in `/root/zatca-relay/.env`) |

Save / deploy. If the same Worker also serves the live site, that is fine: the live
site does not have the ZATCA pages yet.

## 6. Check the ZATCA page

Dashboard → **ZATCA E-Invoicing** → **Refresh**. You should see:

- Signing service: **Connected**
- Environment: **SIMULATION**
- Seller: ✓ complete
- The **Onboard** button is now active

Set the **Phase 2 start date** (your wave's integration date from ZATCA) and Save.

## 7. Onboard (simulation)

1. Fatoora portal → switch to the **Simulation** environment → onboard a new
   solution / device → generate **1 OTP** (valid 1 hour).
2. Dashboard → ZATCA E-Invoicing → paste the OTP → **Onboard**.
3. It takes up to a minute: key + CSR → compliance certificate → compliance checks
   (invoice, credit note, debit note) → production certificate. The page then shows
   **Onboarded** with the certificate expiry date.

**If it fails:** the page shows ZATCA's reason and which steps finished. Send that
message over. Once the cause is fixed, click Onboard again — **no new OTP needed**,
it continues after the compliance certificate. (This first run against the real
ZATCA is where any XML detail gets corrected — expect it may take a round or two.)

## 8. First test invoice

1. **Invoice → + New Invoice** — a small walk-in sale, dated on/after the Phase 2 date.
2. Click **⚡** on it → it should turn **Reported**.
3. Then turn **Automatic submission ON** on the ZATCA page.

## 9. Back up the certificate (important)

`/root/zatca-relay/secrets/` holds the private key and ZATCA certificates. Losing it
means onboarding again; leaking it lets someone sign invoices as SA'DA.

```bash
tar czf /root/zatca-secrets-$(date +%F).tgz -C /root/zatca-relay secrets
# copy that file somewhere safe and private, then delete it from /root
```

Never put `secrets/` or `.env` in git, email or chat.

---

## Updating the relay later

Copy the new code (step 2) and run `bash deploy/install.sh` again. It replaces the
code and restarts, but **keeps `.env` and `secrets/`**.

## Going live — a separate production (core) relay

Production gets **its own copy** of the relay, beside the simulation one, so the dev
site keeps testing against simulation while booking.sadawater.com reports to the real
ZATCA. Each copy has its own folder, port, key, certificate and PM2 name:

| | Simulation (dev site) | Production (live site) |
|---|---|---|
| Folder | `/root/zatca-relay` | `/root/zatca-relay-prod` |
| Port | 8791 | 8792 |
| Hostname | zatca.sadawater.com | zatca-prod.sadawater.com |
| PM2 name | `zatca-relay` | `zatca-relay-prod` |
| Worker | dev-booking (`h2o-booking-dev`) | booking.sadawater.com |

1. **DNS:** A record `zatca-prod` → `185.214.134.177`, **DNS only (grey cloud)**.
2. **Install** (on the server, from the copied code — same `zatca-relay-src` folder):
   ```bash
   cd /root/zatca-relay-src
   APP_DIR=/root/zatca-relay-prod ZATCA_ENV=core PORT=8792 bash deploy/install.sh
   ```
   Copy the relay key it prints (a different key from simulation).
3. **HTTPS:**
   ```bash
   cp /root/zatca-relay-prod/deploy/nginx-zatca-prod.sadawater.com.conf /etc/nginx/sites-available/zatca-prod.sadawater.com
   ln -s /etc/nginx/sites-available/zatca-prod.sadawater.com /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d zatca-prod.sadawater.com
   curl https://zatca-prod.sadawater.com/health     # {"ok":true,"env":"core"}
   ```
4. **Production Worker** (the one serving booking.sadawater.com) → Settings → Variables
   and Secrets → add as **Secret**: `ZATCA_RELAY_URL` = `https://zatca-prod.sadawater.com`,
   `ZATCA_RELAY_KEY` = the key from step 2, `ZATCA_ENV` = `core`. Deploy.
5. **Production dashboard → ZATCA E-Invoicing → Refresh:** Connected, environment **PRODUCTION**.
   Set the **Phase 2 start date** to your wave's integration date from ZATCA (not today's
   date unless it really is your wave date) and Save.
6. **Onboard:** Fatoora portal → **production** (not simulation) → onboard a new
   solution/device → 1 OTP → paste it on the production ZATCA page → Onboard.
7. **One real invoice first:** issue one small invoice dated on/after the Phase 2 date,
   click ⚡ — it must turn Reported. Only then turn Automatic submission ON.
8. **Back up** `/root/zatca-relay-prod/secrets/` (step 9 above, with the `-prod` path).
   This is the live signing key: keep it off email and chat.

Updating later: `bash deploy/install.sh` updates simulation; run it again with
`APP_DIR=/root/zatca-relay-prod` to update production. Neither touches the other's
`.env` or `secrets/`.

## Troubleshooting

| What you see | Check |
|---|---|
| ZATCA page: **Not connected** | Worker secrets missing or misspelled (step 5) |
| ZATCA page: **Unreachable** | `pm2 status`, `pm2 logs zatca-relay`, `curl https://zatca.sadawater.com/health` |
| `/health` works on the server but not from outside | DNS (step 1), nginx (`nginx -t`), certificate (`certbot certificates`) |
| Relay exits at start: "RELAY_API_KEY is missing" | `.env` lost its key — set a 64-character value and update the Worker secret to match |
| Onboarding: "ZATCA refused the OTP" | OTP wrong, used, or older than 1 hour — generate a new one |
| Onboarding: "Already onboarded" | It is done; to redo it move `secrets/` aside first (see production steps) |
