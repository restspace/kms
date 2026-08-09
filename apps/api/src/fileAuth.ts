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
        `SELECT 1 AS ok
         FROM contacts ct
         JOIN submission_participants sp ON sp.contact_id = ct.id
         JOIN review_assignments ra ON ra.submission_id = sp.submission_id
         WHERE ct.headshot_asset_id = ?1 AND ct.event_id = ?2 AND ra.reviewer_contact_id = ?3
         LIMIT 1`,
      )
      .bind(assetId, actor.eventId, actor.contactId)
      .first<{ ok: number }>();
    return row !== null;
  }

  // Speaker: any of the four ownership relations grants access.
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM (
         SELECT 1 FROM contacts WHERE id = ?2 AND headshot_asset_id = ?1
         UNION ALL
         SELECT 1 FROM file_assets WHERE id = ?1 AND uploaded_by_contact_id = ?2
         UNION ALL
         SELECT 1 FROM file_request_uploads WHERE file_asset_id = ?1 AND contact_id = ?2
         UNION ALL
         SELECT 1 FROM task_assignments WHERE response_id = ?1 AND contact_id = ?2
       ) LIMIT 1`,
    )
    .bind(assetId, actor.contactId)
    .first<{ ok: number }>();
  return row !== null;
}
