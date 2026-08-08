// Authorisation: role ranking + a single `can(actor, action, resource)` function
// (docs/03 §5). Pure TS, no I/O — unit-testable without a database.

import type { Actor, Role } from './types';

/** owner > admin > reviewer > speaker */
export const ROLE_RANK: Record<Role, number> = {
  owner: 4,
  admin: 3,
  reviewer: 2,
  speaker: 1,
};

export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}

/** true when `role` is at least as privileged as `min` */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface ResourceRef {
  eventId?: string;
  ownerContactId?: string;
}

/**
 * M0 action matrix:
 *  - 'event.view'       any role
 *  - 'admin.view'       admin or owner
 *  - 'submission.view'  admin/owner, or the contact who owns the record
 * Unknown actions are denied (default-deny).
 */
export function can(actor: Actor, action: string, resource?: ResourceRef): boolean {
  switch (action) {
    case 'event.view':
      return true;
    case 'admin.view':
      return roleAtLeast(actor.role, 'admin');
    case 'submission.view':
      if (roleAtLeast(actor.role, 'admin')) return true;
      return (
        resource?.ownerContactId !== undefined &&
        resource.ownerContactId === actor.contactId
      );
    default:
      return false;
  }
}
