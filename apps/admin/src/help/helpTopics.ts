// Which manual page answers "what is this screen?" for every screen in the
// admin shell. This is the lookup behind the '?' button in the shell header.
//
// The mapping mirrors the manual's own "Screen reference" table (one page per
// sidebar item, one per workspace sub-tab), so keeping it honest is a matter
// of keeping the two sidebars in step. `helpSlugFor` degrades to the manual's
// index rather than throwing: a view added without a manual page still gets a
// working '?' button, it just lands on the contents page.

import type { ViewKey } from '../router'

/** Sidebar view → manual slug. */
const VIEW_TOPICS: Record<ViewKey, string> = {
  dashboard: 'dashboard',
  workspace: 'workspace',
  forms: 'forms',
  evaluation: 'evaluation',
  review: 'review',
  agenda: 'agenda',
  greenroom: 'greenroom',
  pipeline: 'pipeline',
  embeds: 'embeds',
  settings: 'settings',
  // The Help section's own '?' would be circular; it points at the contents.
  help: 'index',
}

/**
 * Workspace sub-tab → manual slug. Keyed by the tab config keys the shell
 * passes to DataTabManager, not by label, because the URL carries the key.
 */
const WORKSPACE_TAB_TOPICS: Record<string, string> = {
  speakers: 'workspace-speakers',
  submissions: 'workspace-submissions',
  tasks: 'workspace-tasks',
  reviews: 'workspace-reviews',
  comments: 'workspace-comments',
  messages: 'workspace-messages',
  files: 'workspace-files',
  events: 'workspace-events',
}

/**
 * The manual page for the screen currently on show. Workspace resolves to the
 * active tab's page — "Workspace" as a whole only describes the shared tab
 * mechanics, which is rarely the question being asked from inside a tab.
 */
export function helpSlugFor(view: ViewKey, tab: string | null): string {
  if (view === 'workspace') {
    const key = tab ?? 'speakers'
    return WORKSPACE_TAB_TOPICS[key] ?? 'workspace'
  }
  return VIEW_TOPICS[view] ?? 'index'
}
