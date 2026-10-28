-- v98: Storage bucket for product catalogue images, uploaded from the device
-- in the new admin Products panel instead of pasting a URL by hand.
--
-- Same public-bucket, upload()+getPublicUrl() convention as installation-
-- proofs (v22) and whatsapp-media (v86) — no server round-trip needed, the
-- bucket's own RLS policy allows any authenticated (admin/owner) write; the
-- Products panel itself is the only thing that calls it.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('product-images', 'product-images', true, 5242880) -- 5MB
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "product-images read"  ON storage.objects;
DROP POLICY IF EXISTS "product-images write" ON storage.objects;
CREATE POLICY "product-images read"  ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'product-images');
CREATE POLICY "product-images write" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'product-images');
