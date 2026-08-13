-- Demo-reset configuration: the tester mailbox every seeded contact's email is
-- rewritten to (apps/api/src/demo.ts applyEmailRedirect).
--
-- Testers driving the demo need every automated email — decisions, reminders,
-- portal invites, chase drafts — to land in one mailbox they can actually
-- open, while still being able to tell which seeded speaker each message was
-- addressed to. Storing `redirect_email` here turns that into a property of
-- the deployment rather than a flag on one button press: the Settings reset,
-- the landing page's reset and the nightly 09:00 UTC cron replay all read the
-- same row, so the demo does not silently revert to @example.com overnight.
--
-- Singleton, not per-org, for the same reason airtable_settings (0041) is: the
-- demo reset itself is deployment-global. It deliberately lives outside the
-- organisation graph so the seed's leading DELETE — which cascades the whole
-- demo org away — cannot take the tester's configuration with it.
--
-- NULL/empty redirect_email means "leave the seeded addresses alone", which is
-- the state a fresh deployment starts in.
CREATE TABLE demo_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  redirect_email TEXT,
  updated_at     TEXT NOT NULL
);
