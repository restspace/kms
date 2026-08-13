// Tester-mailbox redirection for the demo reset.
//
// A tester driving the demo needs the mail it sends — decisions, reminders,
// portal invites, chase drafts — to arrive somewhere they can open, without
// losing track of which seeded speaker each message was addressed to. Setting
// a redirect address on the Settings screen rewrites every seeded contact to a
// plus-addressed variant of it: `you+ada@…`, `you+grace@…`, one per contact.
// Every major provider (Gmail, Outlook/M365, Fastmail, Proton) delivers
// `user+tag@domain` to `user@domain` and preserves the tag in the To: header,
// so one mailbox receives everything and each message still says who it was
// for.
//
// The organisers (owner/admin seats) are deliberately left alone: rewriting
// the account you sign in with locks you out of the demo you are testing.
//
// The derivation is pure and total so it can be unit-tested without a D1
// binding, and so the same contact always yields the same tag — a reset must
// not reshuffle addresses a tester has already filtered their inbox on.

/** The minimum a contact row has to carry to be given a redirect address. */
export interface RedirectContact {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface RedirectBase {
  local: string;
  domain: string;
}

/**
 * Split a tester address into the parts a plus-tag is built from. Any existing
 * `+tag` is dropped rather than nested: a tester who pastes back an address the
 * feature already generated (`you+ada@…`) must not produce `you+ada+grace@…`.
 * Returns null for anything that is not a plausible single address — the API
 * layer turns that into a 400 rather than writing an unusable setting.
 */
export function parseRedirectBase(email: string | null | undefined): RedirectBase | null {
  const trimmed = (email ?? '').trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  if (/[\s,;<>"]/.test(trimmed)) return null;
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at).split('+')[0] ?? '';
  const domain = trimmed.slice(at + 1);
  // A domain needs a dot and no consecutive/edge dots; the local part must
  // survive the +tag strip with something left.
  if (local.length === 0 || !/^[^.@]+(\.[^.@]+)+$/.test(domain)) return null;
  return { local, domain: domain.toLowerCase() };
}

/** Lowercase, ASCII-only, punctuation-free — a tag safe in an address. */
const tagPart = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The `+tag` for one contact: their first name where that is distinctive, then
 * first+last initial, then first+last, then a numeric suffix. `taken` is
 * mutated so a batch of contacts is disambiguated against each other.
 */
export function emailTag(contact: RedirectContact, taken: Set<string>): string {
  const first = tagPart(contact.first_name);
  const last = tagPart(contact.last_name);
  const candidates = [
    first || last,
    last ? `${first}${last.slice(0, 1)}` : '',
    last ? `${first}${last}` : '',
  ].filter((candidate) => candidate.length > 0);
  // A contact with no usable name at all still needs a tag to be addressed by.
  if (candidates.length === 0) candidates.push('contact');

  for (const candidate of candidates) {
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }

  // Every name-derived form is spoken for: fall back to a counter on the best
  // candidate so the result stays unique.
  const stem = candidates[0] ?? 'contact';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * contact id → redirected address, for the contacts given. Order matters (it
 * decides who wins an undecorated first-name tag), so callers pass a stably
 * sorted list; contacts whose address already matches are still included, and
 * the SQL UPDATE is simply a no-op for them.
 */
export function buildRedirectMap(contacts: RedirectContact[], base: RedirectBase): Map<string, string> {
  const taken = new Set<string>();
  const map = new Map<string, string>();
  for (const contact of contacts) {
    map.set(contact.id, `${base.local}+${emailTag(contact, taken)}@${base.domain}`);
  }
  return map;
}

/**
 * Rewrite the demo organisation's contact emails to plus-addressed variants of
 * `redirectEmail`. Called at the tail of every reset (button, landing page and
 * nightly cron alike), so the demo cannot quietly revert to @example.com.
 *
 * Organisers — anyone holding an owner or admin seat on any event — keep their
 * real address, so the sign-in the tester is using survives the reset.
 * `message_log` is rewritten alongside `contacts`: the seeded comms history is
 * shown to the tester as that speaker's mail, and leaving the old address on
 * those rows makes the Messages tab disagree with the Speakers tab.
 *
 * Returns the number of contacts rewritten (0 when no redirect is configured).
 */
export async function applyEmailRedirect(db: D1Database, redirectEmail: string | null): Promise<number> {
  const base = parseRedirectBase(redirectEmail);
  if (!base) return 0;

  const { results } = await db
    .prepare(
      `SELECT c.id, c.email, c.first_name, c.last_name
         FROM contacts c
        WHERE c.org_id IN (SELECT id FROM organisations WHERE slug = 'ai-engineer')
          AND c.id NOT IN (
            SELECT contact_id FROM event_users WHERE role IN ('owner', 'admin')
          )
        ORDER BY c.created_at, c.id`,
    )
    .all<RedirectContact>();
  if (results.length === 0) return 0;

  const map = buildRedirectMap(results, base);
  const statements: D1PreparedStatement[] = [];
  for (const [id, email] of map) {
    statements.push(db.prepare('UPDATE contacts SET email = ? WHERE id = ?').bind(email, id));
    statements.push(db.prepare('UPDATE message_log SET to_email = ? WHERE contact_id = ?').bind(email, id));
  }

  const chunkSize = 40;
  for (let i = 0; i < statements.length; i += chunkSize) {
    await db.batch(statements.slice(i, i + chunkSize));
  }
  return map.size;
}

/** The configured tester mailbox, or null when the demo runs on seeded addresses. */
export async function readRedirectEmail(db: D1Database): Promise<string | null> {
  try {
    const row = await db
      .prepare('SELECT redirect_email FROM demo_settings WHERE id = 1')
      .first<{ redirect_email: string | null }>();
    const value = row?.redirect_email?.trim();
    return value ? value : null;
  } catch {
    // The table arrives with migration 0043; a Worker deployed ahead of the
    // D1 migration must still be able to reset, just without redirection.
    return null;
  }
}

/** Store (or, with null, clear) the tester mailbox. */
export async function writeRedirectEmail(db: D1Database, email: string | null, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO demo_settings (id, redirect_email, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET redirect_email = excluded.redirect_email, updated_at = excluded.updated_at`,
    )
    .bind(email, now)
    .run();
}
