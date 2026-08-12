-- 0035: AIA-08 auto-schedule assist. Auto-placed sessions are provisional
-- until an organiser confirms them: pencilled_at records when the assistant
-- placed the session; NULL means organiser-confirmed. Public agenda feeds,
-- the speaker portal and bulk invite sends exclude rows where pencilled_at
-- IS NOT NULL. Any manual schedule write clears it (touching = confirming).
ALTER TABLE submissions ADD COLUMN pencilled_at TEXT;
