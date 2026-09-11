-- New file rows must point at the PDF namespace and carry PDF metadata. The
-- constraints are NOT VALID so an upgrade does not destroy or rewrite any
-- pre-existing rows; PostgreSQL still enforces them for new and changed rows.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_storage_path_pdf_check;
ALTER TABLE files ADD CONSTRAINT files_storage_path_pdf_check
  CHECK (storage_path ~ '^pdfs/[0-9]{4}/[0-9]{2}/[A-Za-z0-9_-]+[.]pdf$') NOT VALID;

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_mime_type_pdf_check;
ALTER TABLE files ADD CONSTRAINT files_mime_type_pdf_check
  CHECK (mime_type = 'application/pdf') NOT VALID;

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_extension_pdf_check;
ALTER TABLE files ADD CONSTRAINT files_extension_pdf_check
  CHECK (extension = 'pdf') NOT VALID;
