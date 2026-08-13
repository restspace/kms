// Shapes shared by the two generated manual modules (scripts/build-manual.mjs)
// and the Help section that renders them. Hand-written, not generated — the
// generator imports these types so a shape change fails the typecheck rather
// than silently producing a module nothing can read.

/** One converted manual page: `html` is the body, the `# Title` excluded. */
export interface ManualPage {
  slug: string
  title: string
  html: string
  headings: Array<{ id: string; level: number; text: string }>
}

/** Slug → title, statically imported so the '?' button can label its target. */
export interface ManualPageMeta {
  slug: string
  title: string
}

export interface ManualNavItem {
  slug: string
  label: string
  /** The "Covers" column from the manual's own index tables. */
  blurb: string
  /** 0 = top level, 1 = a `↳` child row (the workspace sub-tabs). */
  depth: number
}

export interface ManualNavSection {
  title: string
  items: ManualNavItem[]
}
