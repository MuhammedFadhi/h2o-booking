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

## Moving to production (later, after simulation works end to end)

1. Back up and move the simulation certificates aside:
   `mv /root/zatca-relay/secrets /root/zatca-relay/secrets-simulation`
2. In `.env` set `ZATCA_ENV=core`, then `pm2 restart zatca-relay --update-env`.
3. Production needs its own OTP from the Fatoora portal's **production** environment;
   onboard again from the dashboard. Automatic submission and the Phase 2 date start
   fresh (OFF / empty) for production — set them again.

## Troubleshooting

| What you see | Check |
|---|---|
| ZATCA page: **Not connected** | Worker secrets missing or misspelled (step 5) |
| ZATCA page: **Unreachable** | `pm2 status`, `pm2 logs zatca-relay`, `curl https://zatca.sadawater.com/health` |
| `/health` works on the server but not from outside | DNS (step 1), nginx (`nginx -t`), certificate (`certbot certificates`) |
| Relay exits at start: "RELAY_API_KEY is missing" | `.env` lost its key — set a 64-character value and update the Worker secret to match |
| Onboarding: "ZATCA refused the OTP" | OTP wrong, used, or older than 1 hour — generate a new one |
| Onboarding: "Already onboarded" | It is done; to redo it move `secrets/` aside first (see production steps) |
