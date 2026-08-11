// Record-level file authorization (sweep item P1-4). loadFile already scopes
// by event; this resolves the asset's *relation* to the requester and applies
// the decision table:
//   owner/admin  -> any asset in their event
//   any member   -> event branding assets (logo/background)
//   reviewer     -> headshots of contacts participating in submissions the
//                   reviewer is assigned to; nothing else
//   speaker      -> own headshot, assets they uploaded, their file-request
//                   uploads, their task-upload responses
//   otherwise    -> deny
// Malware scanning is intentionally out of scope for this pass (flagged in
// docs); signatures/size are checked at upload time in filestore.ts.

import type { Role } from '@kms/core';

export interface FileAccessActor {
  contactId: string;
  role: Role;
  eventId: string;
}

export async function resolveFileAccess(
  db: D1Database,
  actor: FileAccessActor,
  assetId: string,
): Promise<boolean> {
  if (actor.role === 'owner' || actor.role === 'admin') return true;

  // Branding assets are public to every signed-in member of the event.
  const branding = await db
    .prepare(`SELECT 1 AS ok FROM events WHERE id = ? AND (logo_asset_id = ? OR background_asset_id = ?)`)
    .bind(actor.eventId, assetId, assetId)
    .first<{ ok: number }>();
  if (branding) return true;

  if (actor.role === 'reviewer') {
    const row = await db
      .prepare(
        // The headshot pointer is per-event (event_contacts), which is exactly
        // the scoping this guard wants: a reviewer sees a participant's headshot
        // for THIS event only. The submissions join pins the participation to
        // the same event — without it a contact's participation in another event
        // in the org would satisfy the check.
        `SELECT 1 AS ok
         FROM event_contacts ec
         JOIN submission_participants sp ON sp.contact_id = ec.contact_id
         JOIN submissions s ON s.id = sp.submission_id AND s.event_id = ?2
         JOIN review_assignments ra ON ra.submission_id = sp.submission_id
         WHERE ec.headshot_asset_id = ?1 AND ec.event_id = ?2 AND ra.reviewer_contact_id = ?3
         LIMIT 1`,
      )
      .bind(assetId, actor.eventId, actor.contactId)
      .first<{ ok: number }>();
    return row !== null;
  }

  // Speaker: any of the four ownership relations grants access.
  //
  // All four key on contactId, which since 0015 is an ORG-level id rather than
  // an event-level one. What keeps them event-safe is files.ts calling
  // loadFile(env, id, session.eventId) first, so ?1 is already known to belong
  // to the actor's event. That is an implicit coupling between two files, so the
  // headshot relation — the only one that reads a contact-owned pointer rather
  // than the asset itself — now carries its own event predicate as well.
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM (
         SELECT 1 FROM event_contacts WHERE contact_id = ?2 AND headshot_asset_id = ?1 AND event_id = ?3
         UNION ALL
         SELECT 1 FROM file_assets WHERE id = ?1 AND uploaded_by_contact_id = ?2
         UNION ALL
         SELECT 1 FROM file_request_uploads WHERE file_asset_id = ?1 AND contact_id = ?2
         UNION ALL
         SELECT 1 FROM task_assignments WHERE response_id = ?1 AND contact_id = ?2
       ) LIMIT 1`,
    )
    .bind(assetId, actor.contactId, actor.eventId)
    .first<{ ok: number }>();
  return row !== null;
}
