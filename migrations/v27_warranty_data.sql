-- =============================================================================
-- SA'DA H2O — v27  Warranty CRM data import
-- Source: sadawater_h2o_warranty.sql (MariaDB, 2026-07-16 12:07 UTC,
--         exported AFTER the write-freeze — the numbers cannot move).
--
-- Run AFTER v27_warranty_schema.sql. Run with RLS ON (you are postgres;
-- policies do not apply to you).
--
-- NO staging tables, NO temp tables, NO cross-statement state. Every INSERT
-- is self-contained via inline VALUES. Earlier drafts used staging tables and
-- failed in the Supabase SQL editor, which does not preserve them between
-- statements. This version cannot hit that class of error.
--
-- Idempotent: ON CONFLICT DO NOTHING + NOT EXISTS guards. Re-running is safe.
--
-- TIMEZONE — VERIFIED, not assumed:
--   MySQL DATETIME carries no zone; the PHP wrote these with date() against
--   the server clock. That clock is UTC — proven: phpMyAdmin stamped this
--   export 12:07 via PHP date(); the server's HTTP Date header read 12:08 GMT
--   at the same moment; Riyadh was 15:08. PHP date() == UTC.
--   registration_date is a real DATE and imports literally — no shift.
--   Postgres stores timestamptz in UTC and renders per client tz, so the
--   customer portal shows correct Riyadh local times automatically.
-- =============================================================================

BEGIN;

-- ── 1) product_models ─────────────────────────────────────────────────────
--    image_url repointed to this repo's /assets/models/ (re-optimised, 83%
--    smaller). The A100 image existed ONLY on the live server — uploaded via
--    the admin panel after the last git commit, absent from the repo.
INSERT INTO product_models (model_name, image_url, description) VALUES
  ('A1UV', '/assets/models/a1uv.png', 'An advanced multi-stage water purifier that combines RO filtration with UV disinfection for the highest level of purity and safety. It features sediment, carbon, RO, and UV purification stages to effectively remove impurities, dissolved solids, odors, and contaminants, while neutralizing bacteria and viruses for an added layer of protection. Built with durable materials and an efficient design, it delivers clean, safe, and great-tasting drinking water for homes and small businesses that demand the highest purification standards.'),
  ('A100', '/assets/models/a100.png', 'A high-performance multi-stage water purifier designed to deliver clean, safe, and great-tasting drinking water. It features sediment, carbon, and advanced filtration stages to effectively remove impurities, odors, and contaminants. Built with durable materials and an efficient design, it ensures reliable purification for homes and small businesses.'),
  ('AQUA BLUE -7 STAGE RO', '/assets/models/purifier-generic.png', ''),
  ('LEXPURE WITH UV 7 STAGE RO', '/assets/models/purifier-generic.png', ''),
  ('ZEFLOW -7 STAGE RO', '/assets/models/purifier-generic.png', ''),
  ('CLASSIC PURE 7 STAGE', '/assets/models/purifier-generic.png', ''),
  ('AQUA PLUS -7 STAGE RO', '/assets/models/purifier-generic.png', ''),
  ('CLASSIC PURE WITHOUT STAND 7 STAGE', '/assets/models/purifier-generic.png', '')
ON CONFLICT (model_name) DO NOTHING;

-- ── 2) customers ─────────────────────────────────────────────────────────
--    Merged on normalized phone. Expect 30 matched / 42 inserted → 91 total.
--    42 > the 32 warranty-only users because 10 of these people HAVE booked
--    but never got a `customers` row. They get one here — a fix, not a
--    side effect. Existing rows WIN on name: we only ever add, never
--    overwrite curated booking data.
INSERT INTO customers (phone, name, created_at, updated_at)
SELECT v.phone, NULLIF(v.name,''), v.created_at, now() FROM (VALUES
  ('+966532752787', 'ABDUL WAHAB RIYAD', '2026-04-14 18:12:52'::timestamp AT TIME ZONE 'UTC'),
  ('+966537086063', 'ALI BHAI', '2026-04-15 06:55:03'::timestamp AT TIME ZONE 'UTC'),
  ('+966506320304', 'MIRSHAD', '2026-04-19 17:01:24'::timestamp AT TIME ZONE 'UTC'),
  ('+966553826267', 'DR. SADIQ SAIT', '2026-04-20 12:00:24'::timestamp AT TIME ZONE 'UTC'),
  ('+966582323599', 'MOHAMMED AIED', '2026-04-20 18:26:15'::timestamp AT TIME ZONE 'UTC'),
  ('+966550667403', 'YASAR RAHMANI', '2026-04-21 08:09:52'::timestamp AT TIME ZONE 'UTC'),
  ('+966582027818', '', '2026-04-22 12:02:34'::timestamp AT TIME ZONE 'UTC'),
  ('+966576284424', '', '2026-04-22 12:04:24'::timestamp AT TIME ZONE 'UTC'),
  ('+966533328577', 'Abu Ashraf MBT (AR)', '2026-04-22 15:49:51'::timestamp AT TIME ZONE 'UTC'),
  ('+966561779588', 'ASHIK BHAI', '2026-04-25 12:23:07'::timestamp AT TIME ZONE 'UTC'),
  ('+966540575125', 'AKTHAR MUHAMMED', '2026-04-26 14:50:26'::timestamp AT TIME ZONE 'UTC'),
  ('+966505339712', 'CRISPUS ROSWIN', '2026-04-27 13:30:03'::timestamp AT TIME ZONE 'UTC'),
  ('+966538440880', 'Mohazin Sheik', '2026-05-02 15:46:11'::timestamp AT TIME ZONE 'UTC'),
  ('+966554989679', 'Ak Sohel', '2026-05-05 14:04:57'::timestamp AT TIME ZONE 'UTC'),
  ('+966531465262', 'Zaid Adnan Hasan Zaied', '2026-05-05 15:02:18'::timestamp AT TIME ZONE 'UTC'),
  ('+966505811789', 'Ibrahim', '2026-05-07 17:43:21'::timestamp AT TIME ZONE 'UTC'),
  ('+966565201940', 'Khalid ansari', '2026-05-12 14:38:06'::timestamp AT TIME ZONE 'UTC'),
  ('+966546067273', 'Mariyam Fathima', '2026-05-12 18:14:03'::timestamp AT TIME ZONE 'UTC'),
  ('+966562517052', 'Abdelrhman', '2026-05-14 05:37:14'::timestamp AT TIME ZONE 'UTC'),
  ('+966546456754', 'Eiyas nazeer', '2026-05-17 19:42:34'::timestamp AT TIME ZONE 'UTC'),
  ('+966567408999', 'Naeem Aboobacker', '2026-05-18 17:22:16'::timestamp AT TIME ZONE 'UTC'),
  ('+966570130484', 'Shayne Haridas', '2026-05-20 17:01:21'::timestamp AT TIME ZONE 'UTC'),
  ('+966544954584', 'Shinil Rahiman', '2026-05-21 07:40:29'::timestamp AT TIME ZONE 'UTC'),
  ('+966563652844', 'Muhammed Cpk', '2026-05-24 15:28:43'::timestamp AT TIME ZONE 'UTC'),
  ('+966507423951', 'RISHAM RAFI ERANCHERY', '2026-06-07 18:26:04'::timestamp AT TIME ZONE 'UTC'),
  ('+966599715122', 'Ajmal Ameer', '2026-06-08 17:44:00'::timestamp AT TIME ZONE 'UTC'),
  ('+966507327527', 'Haji Ali Dawood', '2026-06-09 13:39:36'::timestamp AT TIME ZONE 'UTC'),
  ('+966541615774', 'SYED AMAAR SYED AHMED', '2026-06-10 13:22:30'::timestamp AT TIME ZONE 'UTC'),
  ('+966532547914', 'MARZOOQ AHMED', '2026-06-11 14:53:21'::timestamp AT TIME ZONE 'UTC'),
  ('+966581995577', 'SALEH TRD CO.(AJMAL SHAN)', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966552498599', 'SALIH POOL BUILDER', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966568077904', 'SOUDARA RAMAN', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966503899453', 'RIZQ TRD CO. (ARSHAD)', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966500405064', 'OSAM', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966598971788', 'TAJMAL', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966544805340', 'Intergrated Technologies', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966508059042', 'United Harbour Contracting Est', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966544404729', 'NISSAR', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966511247658', 'FACTORY ATLAS AL JUBAIL MANUFACTURING', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966508292959', 'GREEN WAVE EST', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966592327624', 'MANAR TRADING', '2026-06-11 14:53:23'::timestamp AT TIME ZONE 'UTC'),
  ('+966542907580', 'Jennifer Crasta', '2026-06-13 15:15:28'::timestamp AT TIME ZONE 'UTC'),
  ('+966537848157', 'Ahmed Adil', '2026-06-15 15:27:35'::timestamp AT TIME ZONE 'UTC'),
  ('+966553960540', 'Nadeem Anwar', '2026-06-17 14:44:33'::timestamp AT TIME ZONE 'UTC'),
  ('+966503729517', 'Muhammed Raoof', '2026-06-18 17:11:26'::timestamp AT TIME ZONE 'UTC'),
  ('+966595150472', 'Ahmed Muhammad Sarwar', '2026-06-18 19:18:02'::timestamp AT TIME ZONE 'UTC'),
  ('+966500109676', 'Khalid Saad Metal Industries Factory', '2026-06-20 12:50:59'::timestamp AT TIME ZONE 'UTC'),
  ('+966508252132', 'Mohammed Shahbaz Ahmed', '2026-06-20 15:05:18'::timestamp AT TIME ZONE 'UTC'),
  ('+966549384453', 'FAWAZ AZAD', '2026-06-20 16:19:03'::timestamp AT TIME ZONE 'UTC'),
  ('+966543086609', 'Mahesh VM', '2026-06-20 18:10:39'::timestamp AT TIME ZONE 'UTC'),
  ('+966565771966', 'Zaheer hussain', '2026-06-21 17:03:58'::timestamp AT TIME ZONE 'UTC'),
  ('+966558263007', 'Fahad Kaithal', '2026-06-22 16:44:57'::timestamp AT TIME ZONE 'UTC'),
  ('+966551721683', 'Tanveer Hussain', '2026-06-22 21:59:40'::timestamp AT TIME ZONE 'UTC'),
  ('+966590225621', 'Nathash Kumar Suvarna', '2026-06-23 09:00:40'::timestamp AT TIME ZONE 'UTC'),
  ('+966508997845', 'Ahmed Arief', '2026-06-23 14:12:37'::timestamp AT TIME ZONE 'UTC'),
  ('+966556596569', 'BABU CHELLADURAI', '2026-06-25 16:06:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966558401957', 'NEERAJ RAMAKRISHNAN', '2026-06-25 18:06:10'::timestamp AT TIME ZONE 'UTC'),
  ('+966540859861', 'Mohammed Jaseem', '2026-06-30 17:53:24'::timestamp AT TIME ZONE 'UTC'),
  ('+966508854732', 'Muhammed firoz', '2026-07-02 15:59:06'::timestamp AT TIME ZONE 'UTC'),
  ('+966509562687', 'Farhaan Mirza', '2026-07-02 18:01:35'::timestamp AT TIME ZONE 'UTC'),
  ('+966504448193', 'ASBAH RIYAS', '2026-07-03 09:49:12'::timestamp AT TIME ZONE 'UTC'),
  ('+966506466310', 'Mohamed wajid basha', '2026-07-05 13:25:20'::timestamp AT TIME ZONE 'UTC'),
  ('+966592845628', 'Mishaal Kunhimon', '2026-07-05 14:44:01'::timestamp AT TIME ZONE 'UTC'),
  ('+966509493833', 'Tahir Mahmood', '2026-07-05 17:02:40'::timestamp AT TIME ZONE 'UTC'),
  ('+966503706138', 'Vignesh', '2026-07-05 17:32:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966593300859', 'Mohamed Mahar Shaifuddin', '2026-07-06 18:22:47'::timestamp AT TIME ZONE 'UTC'),
  ('+966558386300', 'Saleh Almari', '2026-07-06 18:27:01'::timestamp AT TIME ZONE 'UTC'),
  ('+966571687224', 'Asraful Ali', '2026-07-09 17:46:17'::timestamp AT TIME ZONE 'UTC'),
  ('+966581077291', 'Sikandar', '2026-07-11 14:56:14'::timestamp AT TIME ZONE 'UTC'),
  ('+966570994625', 'Fadel Ummer Kutty', '2026-07-12 17:42:22'::timestamp AT TIME ZONE 'UTC'),
  ('+966542902619', 'Reza Apriandy', '2026-07-12 18:25:59'::timestamp AT TIME ZONE 'UTC'),
  ('+966599296959', 'Abdul Rasheed', '2026-07-14 17:46:32'::timestamp AT TIME ZONE 'UTC')
) AS v(phone, name, created_at)
ON CONFLICT (phone) DO NOTHING;

-- ── 3) warranties ────────────────────────────────────────────────────────
--    Joined to customers by phone. legacy_id is retained so the history
--    import below can find its parent without a staging table.
INSERT INTO warranties (customer_id, qr_code, product_type, client_code, quantity,
                        registration_date, filter_expiry, service_expiry,
                        warranty_expiry, legacy_id)
SELECT c.id, v.qr_code, v.product_type, v.client_code, v.quantity, v.registration_date,
       v.filter_expiry, v.service_expiry, v.warranty_expiry, v.legacy_id
FROM (VALUES
  (14, '+966532752787', 'A1UV042687634', 'A1UV', '', 1, '2026-04-14'::date, '2026-07-13 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-14 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-13 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (16, '+966537086063', 'A1UV042610001', 'A1UV', '', 1, '2026-04-15'::date, '2026-07-14 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-15 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-14 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (17, '+966506320304', 'A100042687112', 'A100', '', 1, '2026-04-19'::date, '2026-07-18 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-19 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-18 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (18, '+966553826267', 'A1UV042687636', 'A1UV', '', 1, '2026-04-20'::date, '2026-09-11 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-20 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-19 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (19, '+966582323599', 'A100042687100', 'A100', '', 1, '2026-04-20'::date, '2026-07-19 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-20 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-19 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (20, '+966550667403', 'A1UV0xxx0003', 'A1UV', '', 1, '2026-04-21'::date, '2026-10-12 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-21 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-20 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (21, '+966533328577', 'A100042687101', 'A100', '', 1, '2026-04-22'::date, '2026-07-21 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-07-15 05:49:29'::timestamp AT TIME ZONE 'UTC', '2028-04-21 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (22, '+966561779588', 'A1UV042687648', 'A1UV', '', 1, '2026-04-25'::date, '2026-07-24 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-25 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-24 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (23, '+966540575125', 'A100042687116', 'A100', '', 1, '2026-04-26'::date, '2026-07-25 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-26 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-25 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (24, '+966505339712', 'A1UV042687637', 'A1UV', '', 1, '2026-04-27'::date, '2026-07-26 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-27 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-26 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (28, '+966538440880', 'A1UV042687638', 'A1UV', '', 1, '2026-05-02'::date, '2026-07-31 15:46:16'::timestamp AT TIME ZONE 'UTC', '2027-05-02 15:46:16'::timestamp AT TIME ZONE 'UTC', '2028-05-01 15:46:16'::timestamp AT TIME ZONE 'UTC'),
  (29, '+966554989679', 'A100042687131', 'A100', '', 1, '2026-05-05'::date, '2026-08-03 14:05:22'::timestamp AT TIME ZONE 'UTC', '2027-05-05 14:05:22'::timestamp AT TIME ZONE 'UTC', '2028-05-04 14:05:22'::timestamp AT TIME ZONE 'UTC'),
  (30, '+966531465262', 'A100042687103', 'A100', '', 1, '2026-05-05'::date, '2026-08-03 15:02:23'::timestamp AT TIME ZONE 'UTC', '2027-05-05 15:02:23'::timestamp AT TIME ZONE 'UTC', '2028-05-04 15:02:23'::timestamp AT TIME ZONE 'UTC'),
  (31, '+966505811789', 'A100042687126', 'A100', '', 1, '2026-05-07'::date, '2026-08-05 17:43:24'::timestamp AT TIME ZONE 'UTC', '2027-05-07 17:43:24'::timestamp AT TIME ZONE 'UTC', '2028-05-06 17:43:24'::timestamp AT TIME ZONE 'UTC'),
  (33, '+966565201940', 'A1UV042687646', 'A1UV', '', 1, '2026-05-12'::date, '2026-08-10 14:38:16'::timestamp AT TIME ZONE 'UTC', '2027-05-12 14:38:16'::timestamp AT TIME ZONE 'UTC', '2028-05-11 14:38:16'::timestamp AT TIME ZONE 'UTC'),
  (34, '+966546067273', 'A100042687125', 'A100', '', 1, '2026-05-12'::date, '2026-08-10 18:14:45'::timestamp AT TIME ZONE 'UTC', '2027-05-12 18:14:45'::timestamp AT TIME ZONE 'UTC', '2028-05-11 18:14:45'::timestamp AT TIME ZONE 'UTC'),
  (35, '+966562517052', 'A100042687128', 'A100', '', 1, '2026-05-14'::date, '2026-08-12 05:37:25'::timestamp AT TIME ZONE 'UTC', '2027-05-14 05:37:25'::timestamp AT TIME ZONE 'UTC', '2028-05-13 05:37:25'::timestamp AT TIME ZONE 'UTC'),
  (36, '+966546456754', 'A1UV042687644', 'A1UV', '', 1, '2026-05-17'::date, '2026-08-15 19:43:05'::timestamp AT TIME ZONE 'UTC', '2027-05-17 19:43:05'::timestamp AT TIME ZONE 'UTC', '2028-05-16 19:43:05'::timestamp AT TIME ZONE 'UTC'),
  (37, '+966567408999', 'A1UV042687660', 'A1UV', '', 1, '2026-05-18'::date, '2026-08-16 17:22:23'::timestamp AT TIME ZONE 'UTC', '2027-05-18 17:22:23'::timestamp AT TIME ZONE 'UTC', '2028-05-17 17:22:23'::timestamp AT TIME ZONE 'UTC'),
  (38, '+966570130484', 'A1UV042687656', 'A1UV', '', 1, '2026-05-20'::date, '2026-08-18 17:01:28'::timestamp AT TIME ZONE 'UTC', '2027-05-20 17:01:28'::timestamp AT TIME ZONE 'UTC', '2028-05-19 17:01:28'::timestamp AT TIME ZONE 'UTC'),
  (39, '+966544954584', 'A100042687108', 'A100', '', 1, '2026-05-21'::date, '2026-08-19 07:40:54'::timestamp AT TIME ZONE 'UTC', '2027-05-21 07:40:54'::timestamp AT TIME ZONE 'UTC', '2028-05-20 07:40:54'::timestamp AT TIME ZONE 'UTC'),
  (40, '+966563652844', 'A100042687109', 'A100', '', 1, '2026-05-24'::date, '2026-08-22 15:29:05'::timestamp AT TIME ZONE 'UTC', '2027-05-24 15:29:05'::timestamp AT TIME ZONE 'UTC', '2028-05-23 15:29:05'::timestamp AT TIME ZONE 'UTC'),
  (41, '+966507423951', 'A1UV042687659', 'A1UV', '', 1, '2026-06-07'::date, '2026-09-05 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-06-07 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-06-06 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (42, '+966599715122', 'A1UV042687658', 'A1UV', '', 1, '2026-06-08'::date, '2026-09-06 17:44:30'::timestamp AT TIME ZONE 'UTC', '2027-06-08 17:44:30'::timestamp AT TIME ZONE 'UTC', '2028-06-07 17:44:30'::timestamp AT TIME ZONE 'UTC'),
  (43, '+966507327527', 'A100042687110', 'A100', '', 1, '2026-06-09'::date, '2026-09-07 13:40:33'::timestamp AT TIME ZONE 'UTC', '2027-06-09 13:40:33'::timestamp AT TIME ZONE 'UTC', '2028-06-08 13:40:33'::timestamp AT TIME ZONE 'UTC'),
  (44, '+966541615774', 'A1UV042687655', 'A1UV', '', 1, '2026-06-10'::date, '2026-09-08 13:23:03'::timestamp AT TIME ZONE 'UTC', '2027-06-10 13:23:03'::timestamp AT TIME ZONE 'UTC', '2028-06-09 13:23:03'::timestamp AT TIME ZONE 'UTC'),
  (46, '+966532547914', 'AAXX042690001', 'AQUA BLUE -7 STAGE RO', 'KBR0012', 1, '2026-04-11'::date, '2026-10-05 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-07-07 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-10 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (47, '+966581995577', 'AAXX042690002', 'ZEFLOW -7 STAGE RO', 'KBR0003', 1, '2026-01-10'::date, '2026-10-07 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-01-10 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-01-10 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (48, '+966552498599', 'AAXX042690003', 'CLASSIC PURE WITHOUT STAND 7 STAGE', 'KBR0005', 1, '2026-02-15'::date, '2026-05-16 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-02-15 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-02-15 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (49, '+966568077904', 'AAXX042690004', 'ZEFLOW -7 STAGE RO', 'KBR0008', 1, '2025-10-15'::date, '2026-07-27 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-28 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-10-15 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (50, '+966503899453', 'AAXX042690005', 'ZEFLOW -7 STAGE RO', 'KBR0001', 1, '2026-01-22'::date, '2026-07-19 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-07-15 05:49:06'::timestamp AT TIME ZONE 'UTC', '2028-01-22 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (51, '+966500405064', 'AAXX042690006', 'AQUA PLUS -7 STAGE RO', 'KBR0002', 1, '2026-01-19'::date, '2026-08-30 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-06-01 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-01-19 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (53, '+966598971788', 'AAXX042690008', 'LEXPURE WITH UV 7 STAGE RO', 'KBR0006', 1, '2025-10-25'::date, '2026-09-05 00:00:00'::timestamp AT TIME ZONE 'UTC', '2026-10-25 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-10-25 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (57, '+966544805340', 'AAXX042690012', 'ZEFLOW -7 STAGE RO', 'DMM0004', 2, '2025-10-31'::date, '2026-01-29 00:00:00'::timestamp AT TIME ZONE 'UTC', '2026-10-31 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-10-31 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (60, '+966508059042', 'AAXX042690015', 'ZEFLOW -7 STAGE RO', 'DMM0007', 1, '2026-01-03'::date, '2026-09-23 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-01-03 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-01-03 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (61, '+966544404729', 'AAXX042690016', 'AQUA BLUE -7 STAGE RO', 'DMM0011', 1, '2026-04-20'::date, '2026-07-19 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-04-20 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-04-19 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (62, '+966511247658', 'AAXX042690017', 'AQUA BLUE -7 STAGE RO', 'JBL0001', 1, '2026-03-04'::date, '2026-06-02 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-03-04 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-03-03 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (63, '+966508292959', 'AAXX042690018', 'AQUA BLUE -7 STAGE RO', 'JBL-0002', 1, '2026-04-19'::date, '2026-07-18 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-07-15 05:48:28'::timestamp AT TIME ZONE 'UTC', '2028-04-18 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (66, '+966592327624', 'AAXX042690022', 'CLASSIC PURE 7 STAGE', 'JBL-0006', 1, '2026-01-28'::date, '2026-04-28 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-01-28 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-01-28 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (70, '+966542907580', 'A1UV042687654', 'A1UV', '', 1, '2026-06-13'::date, '2026-09-11 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-06-13 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-06-12 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (71, '+966537848157', 'A100042687124', 'A100', '', 1, '2026-06-15'::date, '2026-09-13 15:27:43'::timestamp AT TIME ZONE 'UTC', '2027-06-15 15:27:43'::timestamp AT TIME ZONE 'UTC', '2028-06-14 15:27:43'::timestamp AT TIME ZONE 'UTC'),
  (72, '+966553960540', 'A100042687155', 'A100', '', 1, '2026-06-17'::date, '2026-09-15 14:44:56'::timestamp AT TIME ZONE 'UTC', '2027-06-17 14:44:56'::timestamp AT TIME ZONE 'UTC', '2028-06-16 14:44:56'::timestamp AT TIME ZONE 'UTC'),
  (73, '+966503729517', 'A100042687130', 'A100', '', 1, '2026-06-18'::date, '2026-09-16 17:11:30'::timestamp AT TIME ZONE 'UTC', '2027-06-18 17:11:30'::timestamp AT TIME ZONE 'UTC', '2028-06-17 17:11:30'::timestamp AT TIME ZONE 'UTC'),
  (74, '+966595150472', 'A100042687161', 'A100', '', 1, '2026-06-18'::date, '2026-09-16 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-06-18 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-06-17 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (75, '+966500109676', 'A100042687162', 'A100', '', 1, '2026-06-20'::date, '2026-09-18 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-06-20 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-06-19 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (76, '+966508252132', 'A100042687154', 'A100', '', 1, '2026-06-20'::date, '2026-09-18 15:05:25'::timestamp AT TIME ZONE 'UTC', '2027-06-20 15:05:25'::timestamp AT TIME ZONE 'UTC', '2028-06-19 15:05:25'::timestamp AT TIME ZONE 'UTC'),
  (77, '+966549384453', 'A100042687160', 'A100', '', 1, '2026-06-20'::date, '2026-09-18 16:19:07'::timestamp AT TIME ZONE 'UTC', '2027-06-20 16:19:07'::timestamp AT TIME ZONE 'UTC', '2028-06-19 16:19:07'::timestamp AT TIME ZONE 'UTC'),
  (78, '+966543086609', 'A100042687163', 'A100', '', 1, '2026-06-20'::date, '2026-09-18 18:10:44'::timestamp AT TIME ZONE 'UTC', '2027-06-20 18:10:44'::timestamp AT TIME ZONE 'UTC', '2028-06-19 18:10:44'::timestamp AT TIME ZONE 'UTC'),
  (79, '+966565771966', 'A100042687156', 'A100', '', 1, '2026-06-21'::date, '2026-09-19 17:04:28'::timestamp AT TIME ZONE 'UTC', '2027-06-21 17:04:28'::timestamp AT TIME ZONE 'UTC', '2028-06-20 17:04:28'::timestamp AT TIME ZONE 'UTC'),
  (80, '+966558263007', 'A100042687176', 'A100', '', 1, '2026-06-22'::date, '2026-09-20 16:45:17'::timestamp AT TIME ZONE 'UTC', '2027-06-22 16:45:17'::timestamp AT TIME ZONE 'UTC', '2028-06-21 16:45:17'::timestamp AT TIME ZONE 'UTC'),
  (81, '+966551721683', 'A100042687172', 'A100', '', 1, '2026-06-22'::date, '2026-09-20 22:00:08'::timestamp AT TIME ZONE 'UTC', '2027-06-22 22:00:08'::timestamp AT TIME ZONE 'UTC', '2028-06-21 22:00:08'::timestamp AT TIME ZONE 'UTC'),
  (82, '+966590225621', 'A1UV042687690', 'A1UV', '', 1, '2026-06-23'::date, '2026-09-21 09:00:47'::timestamp AT TIME ZONE 'UTC', '2027-06-23 09:00:47'::timestamp AT TIME ZONE 'UTC', '2028-06-22 09:00:47'::timestamp AT TIME ZONE 'UTC'),
  (83, '+966508997845', 'A100042687129', 'A100', '', 1, '2026-06-23'::date, '2026-09-21 14:13:04'::timestamp AT TIME ZONE 'UTC', '2027-06-23 14:13:04'::timestamp AT TIME ZONE 'UTC', '2028-06-22 14:13:04'::timestamp AT TIME ZONE 'UTC'),
  (84, '+966556596569', 'A100042687175', 'A100', '', 1, '2026-06-25'::date, '2026-09-23 16:06:28'::timestamp AT TIME ZONE 'UTC', '2027-06-25 16:06:28'::timestamp AT TIME ZONE 'UTC', '2028-06-24 16:06:28'::timestamp AT TIME ZONE 'UTC'),
  (85, '+966558401957', 'A100042687179', 'A100', '', 1, '2026-06-25'::date, '2026-09-23 18:08:48'::timestamp AT TIME ZONE 'UTC', '2027-06-25 18:08:48'::timestamp AT TIME ZONE 'UTC', '2028-06-24 18:08:48'::timestamp AT TIME ZONE 'UTC'),
  (86, '+966540859861', 'A100042687157', 'A100', '', 1, '2026-06-30'::date, '2026-09-28 17:54:07'::timestamp AT TIME ZONE 'UTC', '2027-06-30 17:54:07'::timestamp AT TIME ZONE 'UTC', '2028-06-29 17:54:07'::timestamp AT TIME ZONE 'UTC'),
  (87, '+966508854732', 'A1UV042687661', 'A1UV', '', 1, '2026-07-02'::date, '2026-09-30 15:59:44'::timestamp AT TIME ZONE 'UTC', '2027-07-02 15:59:44'::timestamp AT TIME ZONE 'UTC', '2028-07-01 15:59:44'::timestamp AT TIME ZONE 'UTC'),
  (88, '+966509562687', 'A100042687183', 'A100', '', 1, '2026-07-02'::date, '2026-09-30 18:01:38'::timestamp AT TIME ZONE 'UTC', '2027-07-02 18:01:38'::timestamp AT TIME ZONE 'UTC', '2028-07-01 18:01:38'::timestamp AT TIME ZONE 'UTC'),
  (89, '+966504448193', 'A100042687184', 'A100', '', 1, '2026-07-03'::date, '2026-10-01 09:49:29'::timestamp AT TIME ZONE 'UTC', '2027-07-03 09:49:29'::timestamp AT TIME ZONE 'UTC', '2028-07-02 09:49:29'::timestamp AT TIME ZONE 'UTC'),
  (90, '+966506466310', 'A100042687178', 'A100', '', 1, '2026-07-05'::date, '2026-10-03 13:26:02'::timestamp AT TIME ZONE 'UTC', '2027-07-05 13:26:02'::timestamp AT TIME ZONE 'UTC', '2028-07-04 13:26:02'::timestamp AT TIME ZONE 'UTC'),
  (91, '+966592845628', 'A100042687182', 'A100', '', 1, '2026-07-05'::date, '2026-10-03 14:44:04'::timestamp AT TIME ZONE 'UTC', '2027-07-05 14:44:04'::timestamp AT TIME ZONE 'UTC', '2028-07-04 14:44:04'::timestamp AT TIME ZONE 'UTC'),
  (92, '+966509493833', 'A100042687177', 'A100', '', 1, '2026-07-05'::date, '2026-10-03 17:02:58'::timestamp AT TIME ZONE 'UTC', '2027-07-05 17:02:58'::timestamp AT TIME ZONE 'UTC', '2028-07-04 17:02:58'::timestamp AT TIME ZONE 'UTC'),
  (93, '+966503706138', 'A100042687158', 'A100', '', 1, '2026-07-05'::date, '2026-10-03 17:32:54'::timestamp AT TIME ZONE 'UTC', '2027-07-05 17:32:54'::timestamp AT TIME ZONE 'UTC', '2028-07-04 17:32:54'::timestamp AT TIME ZONE 'UTC'),
  (94, '+966593300859', 'A1UV042687651', 'A1UV', '', 1, '2026-07-06'::date, '2026-10-04 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-07-06 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-07-05 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (95, '+966558386300', 'A100042687153', 'A100', '', 1, '2026-07-06'::date, '2026-10-04 00:00:00'::timestamp AT TIME ZONE 'UTC', '2027-07-06 00:00:00'::timestamp AT TIME ZONE 'UTC', '2028-07-05 00:00:00'::timestamp AT TIME ZONE 'UTC'),
  (97, '+966571687224', 'A100042687181', 'A100', '', 1, '2026-07-09'::date, '2026-10-07 17:46:25'::timestamp AT TIME ZONE 'UTC', '2027-07-09 17:46:25'::timestamp AT TIME ZONE 'UTC', '2028-07-08 17:46:25'::timestamp AT TIME ZONE 'UTC'),
  (98, '+966581077291', 'A100042687170', 'A100', '', 1, '2026-07-11'::date, '2026-10-09 14:56:21'::timestamp AT TIME ZONE 'UTC', '2027-07-11 14:56:21'::timestamp AT TIME ZONE 'UTC', '2028-07-10 14:56:21'::timestamp AT TIME ZONE 'UTC'),
  (99, '+966570994625', 'A100042687165', 'A100', '', 1, '2026-07-12'::date, '2026-10-10 17:43:08'::timestamp AT TIME ZONE 'UTC', '2027-07-12 17:43:08'::timestamp AT TIME ZONE 'UTC', '2028-07-11 17:43:08'::timestamp AT TIME ZONE 'UTC'),
  (100, '+966542902619', 'A100042687167', 'A100', '', 1, '2026-07-12'::date, '2026-10-10 19:07:23'::timestamp AT TIME ZONE 'UTC', '2027-07-12 19:07:23'::timestamp AT TIME ZONE 'UTC', '2028-07-11 19:07:23'::timestamp AT TIME ZONE 'UTC'),
  (101, '+966599296959', 'A100042687188', 'A100', '', 1, '2026-07-14'::date, '2026-10-12 17:47:01'::timestamp AT TIME ZONE 'UTC', '2027-07-14 17:47:01'::timestamp AT TIME ZONE 'UTC', '2028-07-13 17:47:01'::timestamp AT TIME ZONE 'UTC')
) AS v(legacy_id, phone, qr_code, product_type, client_code, quantity,
       registration_date, filter_expiry, service_expiry, warranty_expiry)
JOIN customers c ON c.phone = v.phone
ON CONFLICT (qr_code) DO NOTHING;

-- ── 4) service history ───────────────────────────────────────────────────
--    SOURCE DEFECT: service_history has NO foreign key in the live MySQL DB,
--    so deleting a warranty orphaned its history. 22 of 106 rows point at
--    warranty_ids that no longer exist (17 from the 2026-06-11 CSV import
--    batch, since deleted; 5 test rows on warranty 96). They are already
--    unreachable in the PHP app — it only fetches history for warranties it
--    found — so dropping them changes nothing visible. 84 import.
--    The FK in v27_warranty_schema.sql prevents this recurring.
--    The activation trigger skips rows with legacy_id set, so no duplicates.
INSERT INTO warranty_service_history (warranty_id, service_type, notes, created_at)
SELECT w.id, v.service_type, NULLIF(v.notes,''), v.created_at
FROM (VALUES
  (28, 'activation', 'Initial product activation and registration', '2026-05-02 15:46:16'::timestamp AT TIME ZONE 'UTC'),
  (29, 'activation', 'Initial product activation and registration', '2026-05-05 14:05:22'::timestamp AT TIME ZONE 'UTC'),
  (30, 'activation', 'Initial product activation and registration', '2026-05-05 15:02:23'::timestamp AT TIME ZONE 'UTC'),
  (31, 'activation', 'Initial product activation and registration', '2026-05-07 17:43:24'::timestamp AT TIME ZONE 'UTC'),
  (33, 'activation', 'Initial product activation and registration', '2026-05-12 14:38:16'::timestamp AT TIME ZONE 'UTC'),
  (34, 'activation', 'Initial product activation and registration', '2026-05-12 18:14:45'::timestamp AT TIME ZONE 'UTC'),
  (35, 'activation', 'Initial product activation and registration', '2026-05-14 05:37:25'::timestamp AT TIME ZONE 'UTC'),
  (36, 'activation', 'Initial product activation and registration', '2026-05-17 19:43:05'::timestamp AT TIME ZONE 'UTC'),
  (37, 'activation', 'Initial product activation and registration', '2026-05-18 17:22:23'::timestamp AT TIME ZONE 'UTC'),
  (38, 'activation', 'Initial product activation and registration', '2026-05-20 17:01:28'::timestamp AT TIME ZONE 'UTC'),
  (39, 'activation', 'Initial product activation and registration', '2026-05-21 07:40:54'::timestamp AT TIME ZONE 'UTC'),
  (40, 'activation', 'Initial product activation and registration', '2026-05-24 15:29:05'::timestamp AT TIME ZONE 'UTC'),
  (41, 'activation', 'Initial product activation and registration', '2026-06-07 18:26:30'::timestamp AT TIME ZONE 'UTC'),
  (42, 'activation', 'Initial product activation and registration', '2026-06-08 17:44:30'::timestamp AT TIME ZONE 'UTC'),
  (16, 'filter', '', '2026-06-09 10:52:37'::timestamp AT TIME ZONE 'UTC'),
  (43, 'activation', 'Initial product activation and registration', '2026-06-09 13:40:33'::timestamp AT TIME ZONE 'UTC'),
  (44, 'activation', 'Initial product activation and registration', '2026-06-10 13:23:03'::timestamp AT TIME ZONE 'UTC'),
  (46, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (47, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (48, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (49, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (50, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (51, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (53, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (57, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (60, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (61, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (62, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (63, 'activation', 'Imported from field installation records', '2026-06-11 14:53:22'::timestamp AT TIME ZONE 'UTC'),
  (66, 'activation', 'Imported from field installation records', '2026-06-11 14:53:23'::timestamp AT TIME ZONE 'UTC'),
  (70, 'activation', 'Initial product activation and registration', '2026-06-13 15:15:54'::timestamp AT TIME ZONE 'UTC'),
  (71, 'activation', 'Initial product activation and registration', '2026-06-15 15:27:43'::timestamp AT TIME ZONE 'UTC'),
  (72, 'activation', 'Initial product activation and registration', '2026-06-17 14:44:56'::timestamp AT TIME ZONE 'UTC'),
  (73, 'activation', 'Initial product activation and registration', '2026-06-18 17:11:30'::timestamp AT TIME ZONE 'UTC'),
  (74, 'activation', 'Initial product activation and registration', '2026-06-18 19:18:12'::timestamp AT TIME ZONE 'UTC'),
  (75, 'activation', 'Initial product activation and registration', '2026-06-20 12:51:25'::timestamp AT TIME ZONE 'UTC'),
  (76, 'activation', 'Initial product activation and registration', '2026-06-20 15:05:25'::timestamp AT TIME ZONE 'UTC'),
  (77, 'activation', 'Initial product activation and registration', '2026-06-20 16:19:07'::timestamp AT TIME ZONE 'UTC'),
  (78, 'activation', 'Initial product activation and registration', '2026-06-20 18:10:44'::timestamp AT TIME ZONE 'UTC'),
  (79, 'activation', 'Initial product activation and registration', '2026-06-21 17:04:28'::timestamp AT TIME ZONE 'UTC'),
  (80, 'activation', 'Initial product activation and registration', '2026-06-22 16:45:17'::timestamp AT TIME ZONE 'UTC'),
  (81, 'activation', 'Initial product activation and registration', '2026-06-22 22:00:08'::timestamp AT TIME ZONE 'UTC'),
  (82, 'activation', 'Initial product activation and registration', '2026-06-23 09:00:47'::timestamp AT TIME ZONE 'UTC'),
  (83, 'activation', 'Initial product activation and registration', '2026-06-23 14:13:04'::timestamp AT TIME ZONE 'UTC'),
  (84, 'activation', 'Initial product activation and registration', '2026-06-25 16:06:28'::timestamp AT TIME ZONE 'UTC'),
  (85, 'activation', 'Initial product activation and registration', '2026-06-25 18:08:48'::timestamp AT TIME ZONE 'UTC'),
  (86, 'activation', 'Initial product activation and registration', '2026-06-30 17:54:07'::timestamp AT TIME ZONE 'UTC'),
  (87, 'activation', 'Initial product activation and registration', '2026-07-02 15:59:44'::timestamp AT TIME ZONE 'UTC'),
  (88, 'activation', 'Initial product activation and registration', '2026-07-02 18:01:38'::timestamp AT TIME ZONE 'UTC'),
  (89, 'activation', 'Initial product activation and registration', '2026-07-03 09:49:29'::timestamp AT TIME ZONE 'UTC'),
  (90, 'activation', 'Initial product activation and registration', '2026-07-05 13:26:02'::timestamp AT TIME ZONE 'UTC'),
  (91, 'activation', 'Initial product activation and registration', '2026-07-05 14:44:04'::timestamp AT TIME ZONE 'UTC'),
  (92, 'activation', 'Initial product activation and registration', '2026-07-05 17:02:58'::timestamp AT TIME ZONE 'UTC'),
  (93, 'activation', 'Initial product activation and registration', '2026-07-05 17:32:54'::timestamp AT TIME ZONE 'UTC'),
  (16, 'filter', 'changed filter ', '2026-07-06 14:02:38'::timestamp AT TIME ZONE 'UTC'),
  (94, 'activation', 'Initial product activation and registration', '2026-07-06 18:23:18'::timestamp AT TIME ZONE 'UTC'),
  (95, 'activation', 'Initial product activation and registration', '2026-07-06 18:27:05'::timestamp AT TIME ZONE 'UTC'),
  (50, 'filter', 'Performed on: Jun 15, 2026', '2026-07-07 09:57:10'::timestamp AT TIME ZONE 'UTC'),
  (51, 'filter', 'Performed on: Jun 15, 2026', '2026-07-07 09:58:27'::timestamp AT TIME ZONE 'UTC'),
  (49, 'service', 'Performed on: Apr 28, 2026', '2026-07-07 10:00:10'::timestamp AT TIME ZONE 'UTC'),
  (49, 'filter', 'Performed on: Apr 28, 2026', '2026-07-07 10:00:34'::timestamp AT TIME ZONE 'UTC'),
  (53, 'filter', 'Performed on: May 01, 2026', '2026-07-07 10:01:46'::timestamp AT TIME ZONE 'UTC'),
  (60, 'filter', 'Performed on: Jun 20, 2026', '2026-07-07 13:06:30'::timestamp AT TIME ZONE 'UTC'),
  (66, 'filter', 'Performed on: May 25, 2026', '2026-07-07 13:18:48'::timestamp AT TIME ZONE 'UTC'),
  (46, 'filter', 'Performed on: Jul 07, 2026', '2026-07-08 07:23:05'::timestamp AT TIME ZONE 'UTC'),
  (46, 'service', 'Performed on: Jul 07, 2026', '2026-07-09 05:23:36'::timestamp AT TIME ZONE 'UTC'),
  (46, 'filter', 'Performed on: Jul 07, 2026', '2026-07-09 05:23:49'::timestamp AT TIME ZONE 'UTC'),
  (97, 'activation', 'Initial product activation and registration', '2026-07-09 17:46:25'::timestamp AT TIME ZONE 'UTC'),
  (47, 'filter', 'Performed on: Jul 09, 2026', '2026-07-11 05:41:15'::timestamp AT TIME ZONE 'UTC'),
  (51, 'service', 'Performed on: Jun 01, 2026', '2026-07-11 06:15:29'::timestamp AT TIME ZONE 'UTC'),
  (51, 'filter', 'Performed on: Jun 01, 2026', '2026-07-11 06:15:45'::timestamp AT TIME ZONE 'UTC'),
  (50, 'service', 'Does filter replacement by self. | Performed on: Apr 20, 2026', '2026-07-11 06:18:17'::timestamp AT TIME ZONE 'UTC'),
  (50, 'filter', 'Does filter replacement by self. | Performed on: Apr 20, 2026', '2026-07-11 06:19:04'::timestamp AT TIME ZONE 'UTC'),
  (53, 'filter', 'Performed on: Jun 07, 2026', '2026-07-11 06:45:49'::timestamp AT TIME ZONE 'UTC'),
  (60, 'filter', 'Performed on: Jun 25, 2026', '2026-07-11 06:46:38'::timestamp AT TIME ZONE 'UTC'),
  (98, 'activation', 'Initial product activation and registration', '2026-07-11 14:56:21'::timestamp AT TIME ZONE 'UTC'),
  (99, 'activation', 'Initial product activation and registration', '2026-07-12 17:43:08'::timestamp AT TIME ZONE 'UTC'),
  (100, 'activation', 'Initial product activation and registration', '2026-07-12 19:07:23'::timestamp AT TIME ZONE 'UTC'),
  (18, 'filter', 'Performed on: Jun 13, 2026', '2026-07-13 05:24:47'::timestamp AT TIME ZONE 'UTC'),
  (20, 'filter', 'Performed on: 14/07/2026', '2026-07-14 05:36:28'::timestamp AT TIME ZONE 'UTC'),
  (101, 'activation', 'Initial product activation and registration', '2026-07-14 17:47:01'::timestamp AT TIME ZONE 'UTC'),
  (63, 'service', 'Said ''we will manage ourselves''.', '2026-07-15 05:48:28'::timestamp AT TIME ZONE 'UTC'),
  (50, 'service', 'Last time, did filter replacement by self.', '2026-07-15 05:49:06'::timestamp AT TIME ZONE 'UTC'),
  (21, 'service', 'Arab who is near showroom.', '2026-07-15 05:49:29'::timestamp AT TIME ZONE 'UTC')
) AS v(legacy_warranty_id, service_type, notes, created_at)
JOIN warranties w ON w.legacy_id = v.legacy_warranty_id
WHERE NOT EXISTS (SELECT 1 FROM warranty_service_history x
                  WHERE x.warranty_id = w.id AND x.service_type = v.service_type
                    AND x.created_at = v.created_at);

-- ── 5) follow-ups (INTERNAL — admin-only via RLS, anon is REVOKEd) ───────
INSERT INTO customer_followups (customer_id, followup_date, note, created_by, status, created_at)
SELECT c.id, v.followup_date, v.note, 'legacy import (admin_h2o)', v.status, v.created_at
FROM (VALUES
  ('+966506320304', '2026-08-25'::date, 'On vacation, needs replacement', 'pending', '2026-07-13 09:29:15'::timestamp AT TIME ZONE 'UTC'),
  ('+966508292959', '2026-08-15'::date, 'On vacation currently. Filter replacement may be required.', 'pending', '2026-07-15 05:51:04'::timestamp AT TIME ZONE 'UTC'),
  ('+966537086063', '2026-07-20'::date, 'Filter change for Ali Bhai & Akheel Bhai', 'pending', '2026-07-16 08:38:00'::timestamp AT TIME ZONE 'UTC'),
  ('+966532752787', '2026-07-20'::date, 'Message and check', 'pending', '2026-07-16 08:38:34'::timestamp AT TIME ZONE 'UTC')
) AS v(phone, followup_date, note, status, created_at)
JOIN customers c ON c.phone = v.phone
WHERE NOT EXISTS (SELECT 1 FROM customer_followups x
                  WHERE x.customer_id = c.id AND x.followup_date = v.followup_date
                    AND x.note = v.note);

COMMIT;

-- ── verification — run this separately after the import ──────────────────
SELECT 'customers'      AS table_name, count(*) AS rows, 91 AS expected FROM customers
UNION ALL SELECT 'warranties',      count(*), 70 FROM warranties
UNION ALL SELECT 'service history', count(*), 84 FROM warranty_service_history
UNION ALL SELECT 'follow-ups',      count(*),  4 FROM customer_followups
UNION ALL SELECT 'product models',  count(*),  8 FROM product_models;

