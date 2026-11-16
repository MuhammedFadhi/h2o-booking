# SA'DA H2O — ZATCA Phase-2 Signing Relay

This service makes SA'DA's invoices **ZATCA Phase-2 (Integration)** compliant. It
holds the EGS private key + CSID certificate, and for each invoice it:

1. builds the **UBL 2.1** XML,
2. computes the **invoice hash**,
3. **signs** it with ECDSA **secp256k1** (XAdES UBL signature),
4. stamps the **9-tag Phase-2 QR**,
5. **reports** simplified/B2C invoices to ZATCA (or **clears** standard/B2B ones).

It runs on a host you control (exactly like the SMS relay, `smsrelay.sadawater.com`).
The Cloudflare Worker route `/api/admin/zatca-report` and the admin dashboard call
it over HTTPS. **The private key never leaves this box and never reaches the browser.**

> Why a separate service: the Cloudflare Workers runtime cannot do secp256k1
> signing and must not hold the production certificate. This mirrors the existing
> SMS relay pattern.

## Architecture

```
Admin dashboard ──► /api/admin/zatca-report (Worker, injects relay URL+key)
                         └──► THIS relay /sign-report ──► ZATCA Fatoora API
                                   (UBL + sign + QR)        (report / clear)
```

## Layout

| File | Role |
|---|---|
| `src/config.js` | env + ZATCA endpoint URLs (sandbox / simulation / production) |
| `src/csr.js` | generate secp256k1 key + ZATCA CSR (via openssl) |
| `src/zatca.js` | ZATCA API client (compliance CSID, production CSID, reporting, clearance) |
| `src/onboard.js` | onboarding CLI (`npm run onboard`) |
| `src/ubl.js` | UBL 2.1 invoice builder |
| `src/hash.js` | invoice hash (canonicalize + SHA-256) |
| `src/sign.js` | ECDSA signing, cert parsing, XAdES signature block |
| `src/qr.js` | Phase-2 TLV QR |
| `src/server.js` | HTTP endpoint `/sign-report` the Worker calls |
| `test/selftest.js` | offline crypto self-test (no creds, no deps) |

## Prerequisites

- Node ≥ 18 and **OpenSSL** on the host (secp256k1 support — check with
  `openssl ecparam -list_curves | grep secp256k1`).
- SA'DA's **15-digit VAT number** and a ZATCA Fatoora **portal account**.

## Setup

```bash
cd zatca-relay
npm install
cp .env.example .env     # then fill it in (VAT number, EGS fields, RELAY_API_KEY)
npm run selftest         # proves the crypto core works, no credentials needed
```

## Onboarding (requires SA'DA's ZATCA account — only you can do this)

ZATCA issues the certificate; it cannot be done without SA'DA logging into the
portal. Do it first in **sandbox** (`ZATCA_ENV=developer-portal`), then repeat in
**simulation**, then **production** (`core`).

1. Log in to the **Fatoora portal** → *Onboarding* → generate a **new OTP** for a
   new EGS unit. It is valid ~1 hour.
2. In the dashboard → **ZATCA E-Invoicing**, paste the OTP and click **Onboard**
   (the relay must be running and connected — see *Run*). Or, on the relay host,
   put it in `.env` as `ZATCA_OTP=...` and run `npm run onboard`. Both do the same:
   generate the key + CSR, request the **compliance CSID**, run ZATCA's
   **compliance checks** (a simplified invoice, credit note and debit note — one
   set per invoice type in `EGS_INVOICE_TYPE`), then request the **production
   CSID**. Credentials are written to `./secrets/` (keep it private and backed up).
3. If a compliance check fails, click Onboard again (no new OTP needed — it resumes
   after the compliance certificate) once the cause is fixed. **This is the expected
   iteration loop** — ZATCA validates the exact XML/signature.
4. Once onboarded, onboarding refuses to run again so a working certificate is never
   replaced by accident. To re-onboard (certificate expiry, moving to another
   environment), move the files in `secrets/` aside first.

**VAT group:** SA'DA invoices as a member of a VAT group, so set
`EGS_ORG_UNIT_NAME` to the member company's 10-digit TIN before onboarding (see
`.env.example`). The dashboard supplies the VAT number, legal name and city from
*Tax / Company info* for any `EGS_*` field left blank.

## Server setup

Step-by-step for the DigitalOcean server (install script, PM2, nginx + HTTPS,
Cloudflare secrets, onboarding, backups): **[deploy/SETUP.md](deploy/SETUP.md)**.

## Run

```bash
npm start            # listens on PORT (default 8791) — put TLS / a reverse proxy in front
```

Point the Worker at it with two secrets:

```
ZATCA_RELAY_URL = https://<your-relay-host>
ZATCA_RELAY_KEY = <the same string as RELAY_API_KEY in .env>
```

The relay must be served over HTTPS with a real certificate (Cloudflare Workers
cannot call a self-signed host). Optionally set the Worker var `ZATCA_ENV` to the
relay's environment so the dashboard can prepare settings before it is connected.

Then in the dashboard → **ZATCA E-Invoicing** (same model as Al Amanah):

- **Phase 2 start date** — your wave's integration date. Nothing is sent until it
  is set, and nothing dated before it is ever sent.
- **Automatic submission** ON/OFF — when ON, every saved invoice is reported at
  once; anything rejected waits under **ZATCA Pending**. Stored per environment,
  so moving to production starts OFF.
- **ZATCA Pending** — every invoice ZATCA has not accepted, with the reason in
  plain words; submit one, or the oldest 10/25/50/100 in order.

Relay endpoints (all need `x-relay-key`): `GET /status`, `POST /onboard`,
`POST /sign-report`. `GET /health` is open.

For automated tests, `ZATCA_TEST_BASE_URL` points a non-production relay at a mock
of the Fatoora API; it is ignored when `ZATCA_ENV=core`.

## What is verified vs. what needs the sandbox

- **Verified offline** (`npm run selftest`): secp256k1 sign/verify, public-key and
  certificate-signature extraction, the 9-tag QR, SHA-256 — all pass.
- **Needs the ZATCA sandbox to confirm**: the exact UBL field set, canonicalization,
  and XAdES signature must pass ZATCA's `/compliance/invoices` check. Treat the
  first sandbox run as a validation + fix loop before going live. Do **not** switch
  `ZATCA_ENV=core` until simulation passes end-to-end.

## Security

- `secrets/` and `.env` are git-ignored — never commit them.
- The relay only accepts requests carrying the `x-relay-key` shared secret.
- Keep the private key on this host only; back it up encrypted. Losing it means
  re-onboarding; leaking it means someone can issue invoices as SA'DA.
