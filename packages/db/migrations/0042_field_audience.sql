-- Field-level audience flag (workplan-17 replay defect #4): the public CFP
-- wizard rendered every abstract question on the form, including operational
-- fields that exist for the organiser's import/integration pipeline —
-- "Client Session ID" (the Sessionboard upsert key, importer.ts), "CEU
-- Credits", "Capacity" — which read as confusing internal noise on a public
-- call-for-papers form.
--
-- Rather than a hardcoded name blocklist, every field now declares who it is
-- for:
--   'public'   — speaker-facing: rendered by the CFP wizard and the portal's
--                submission edit page, exactly as every field was before.
--   'internal' — organiser-only: skipped on speaker-facing forms (and their
--                answers discarded server-side), still fully visible in the
--                admin builder/workspace, imports and exports.
--
-- The column default is 'public' so organiser-authored fields keep behaving
-- exactly as they did. Only the three operational system keys above are
-- re-defaulted to 'internal': they were seeded for the importer's column
-- mapping (seed.sql / importer.ts IMPORT_COLUMNS), not authored by an
-- organiser as CFP questions, and no organiser ever marked them public. An
-- organiser can flip any field either way (PUT /app/api/forms/fields/:id).
ALTER TABLE field_definitions ADD COLUMN audience TEXT NOT NULL DEFAULT 'public'
  CHECK (audience IN ('public','internal'));

UPDATE field_definitions SET audience = 'internal'
 WHERE key IN ('capacity', 'ceu_credits', 'client_session_id');
