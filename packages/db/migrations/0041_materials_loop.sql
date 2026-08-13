-- Workplan 15, waves 5/6/7: what happens after accepted.
--
-- W5a — the materials state. A flag alongside accepted, exactly like
-- accept_condition in 0040 (D9). No CHECK (0026 precedent); validated in the
-- route against MATERIALS_STATES the way APPROVAL_STATES is.
--   NULL | received | reviewed | revision_requested | final
-- 'received' is set automatically when a current upload lands against the
-- event's slides file request — that transition needs no human, and pretending
-- otherwise adds a click to every deck. The rest are set by a person.
ALTER TABLE submissions ADD COLUMN materials_state TEXT;
ALTER TABLE submissions ADD COLUMN materials_state_at TEXT;   -- UTC ISO of the last transition

-- Deck review has never scaled: the 2016 retro action item was "divide up
-- slide deck reviews and share the load" and ten years later it is still one
-- person. A reviewer per deck is the smallest thing that makes sharing the
-- load expressible.
ALTER TABLE submissions ADD COLUMN materials_owner_id TEXT REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX idx_submissions_materials_state ON submissions (event_id, materials_state);

-- W6 — the show-flow handoff. The median intro script lands at T-20 with a
-- 10th percentile of T-2, so this is a field filled late by whoever is
-- nearest: it lives on the submission and is editable from the green room
-- screen as well as the detail panel.
ALTER TABLE submissions ADD COLUMN intro_script TEXT;

-- W7 — last year's attendee rating, imported and never collected (D11). It
-- lives on event_contacts rather than contacts because a rating is a fact
-- about one person at one event, the same field-split rule docs/02 §2 applies
-- to bio and job title. Never folded into rating_cache or any aggregate: the
-- doc is explicit that this input is a veto argued out loud by a human.
ALTER TABLE event_contacts ADD COLUMN prior_rating REAL;        -- attendee rating at THIS event
ALTER TABLE event_contacts ADD COLUMN prior_rating_note TEXT;   -- e.g. "bottom quartile, n=41"
