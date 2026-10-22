-- v84: Allow a lead with no phone number.
--
-- Instagram DM leads from the CRM legitimately have no client_phone — a
-- contact is identified by their Instagram handle/name there, not a phone
-- number. leads.phone was NOT NULL (v52), which rejected every one of
-- these with a 400 from /api/webhooks/crm. Every place in the admin
-- dashboard that renders l.phone already guards against null/undefined
-- (escB(), `|| ''`, optional chaining), so this is safe app-side; a sales
-- agent converting one of these into a booking will just need to collect
-- a real phone number first, same as they would from any other channel
-- that doesn't hand one over up front.

ALTER TABLE leads ALTER COLUMN phone DROP NOT NULL;
