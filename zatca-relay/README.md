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
2. Put it in `.env` as `ZATCA_OTP=...`, set `ZATCA_ENV`, and run:
   ```bash
   npm run onboard
   ```
   This generates the key + CSR, requests the **compliance CSID**, runs ZATCA's
   **compliance invoice checks**, and on success requests the **production CSID**.
   Credentials are written to `./secrets/` (keep it private and backed up).
3. If a compliance check fails, fix the signed-invoice output against the sandbox
   and re-run. **This is the expected iteration loop** — ZATCA validates the exact
   XML/signature, and getting every field byte-correct is where integrations spend
   their time.

## Run

```bash
npm start            # listens on PORT (default 8791) — put TLS / a reverse proxy in front
```

Point the Worker at it with two secrets:

```
ZATCA_RELAY_URL = https://<your-relay-host>
ZATCA_RELAY_KEY = <the same string as RELAY_API_KEY in .env>
```

Then in the dashboard → **Invoices → ⚙ Tax / Company info**, tick **Enable ZATCA
Phase-2 e-invoicing**. Each invoice gets a **⚡ Report to ZATCA** button.

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
