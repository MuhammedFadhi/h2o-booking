-- v96: PDF first-page thumbnails in the WhatsApp chat view.
--
-- A document message (PDF) previously showed only a generic file icon +
-- filename link. thumbnail_url, when present, is a small JPG of the PDF's
-- first page (rendered via CloudConvert — see pdfFirstPageThumbnail() in
-- api/admin/whatsapp.js and api/webhooks/whatsapp.js), shown in the chat
-- bubble in place of the icon. NULL for every existing row and for any
-- future message where generation fails/times out — the UI falls back to
-- the plain icon+filename exactly as before when this is unset.

ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS thumbnail_url text;
