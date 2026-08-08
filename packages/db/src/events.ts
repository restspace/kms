import type { Event } from './types'

/**
 * Every repository call carries a Scope; the SQL layer appends the scope
 * predicate so tenant isolation cannot be forgotten at the call site
 * (docs/03 §5). Actor/role plumbing arrives with auth in M0.
 */
export interface Scope {
  org_id: string
}

export const eventsRepo = {
  async bySlug(db: D1Database, slug: string, scope: Scope): Promise<Event | null> {
    return db
      .prepare('SELECT * FROM events WHERE org_id = ? AND slug = ? LIMIT 1')
      .bind(scope.org_id, slug)
      .first<Event>()
  },

  async first(db: D1Database, scope: Scope): Promise<Event | null> {
    return db
      .prepare('SELECT * FROM events WHERE org_id = ? ORDER BY starts_on LIMIT 1')
      .bind(scope.org_id)
      .first<Event>()
  },
}
