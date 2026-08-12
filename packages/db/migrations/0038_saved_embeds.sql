-- Saved embeds (spec-gap EMB-15): the Embeds screen was a pure generator —
-- configure a widget, copy the snippet, and the configuration evaporated on
-- navigation. This table persists named configurations so the screen gets a
-- list ("what have we embedded where?") and a Save button.
--
-- `options` is the admin SPA's EmbedOptionsInput shape as one JSON blob:
-- only the SPA ever reads it back (snippets are rebuilt client-side from
-- these options at copy time, never stored), so per-field columns would buy
-- nothing. `widget`/`format` are their own columns because the list screen
-- shows them and the API validates them against the loader's allowlists.
CREATE TABLE saved_embeds (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  widget TEXT NOT NULL,   -- sessions | speakers | agenda | schedule | gallery
  format TEXT NOT NULL,   -- script | iframe | json | xml | ics
  options TEXT NOT NULL,  -- JSON: EmbedOptionsInput
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_saved_embeds_event ON saved_embeds (event_id, created_at);
