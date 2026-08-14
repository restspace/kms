// The in-app user manual: docs/manual/*.md, converted at build time by
// scripts/build-manual.mjs and rendered here as a two-column reader — the
// manual's own contents tables on the left, the page on the right.
//
// The page bodies (~110KB of HTML) are dynamically imported so Vite splits
// them into their own chunk: an organiser who never opens Help never downloads
// the manual. The nav is statically imported — it is small, and the shell's
// '?' button needs slug→title before the chunk has loaded.
//
// Rendering is dangerouslySetInnerHTML over build-time output. The input is
// repository markdown, not user content, and the converter escapes every
// inline before emitting tags, so no submission text can reach this HTML.

import { useEffect, useRef, useState } from 'react'
import { navigate } from '../router'
import { MANUAL_NAV, MANUAL_PAGE_META } from './manualNav.generated'
import type { ManualPage } from './manualTypes'
import './help.css'

const INDEX_SLUG = 'index'

type PageMap = Record<string, ManualPage>

export interface HelpSectionProps {
  /** Manual slug from the URL; unknown or absent shows the contents page. */
  slug: string | null
}

export function HelpSection({ slug }: HelpSectionProps) {
  const [pages, setPages] = useState<PageMap | null>(null)
  const [loadError, setLoadError] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void import('./manualPages.generated')
      .then((module) => {
        if (!cancelled) setPages(module.MANUAL_PAGES)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const active = slug && MANUAL_PAGE_META.some((p) => p.slug === slug) ? slug : INDEX_SLUG
  const page = pages ? (pages[active] ?? pages[INDEX_SLUG] ?? null) : null

  /**
   * Cross-page links inside the prose are plain `?v=help&page=…` anchors, so
   * they still work with middle-click and "copy link address". Delegating from
   * the container catches them all without walking the injected HTML, and
   * intercepting only the plain-click case keeps the SPA from doing a full page
   * load while leaving modified clicks to the browser.
   */
  const onBodyClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    const anchor = (event.target as HTMLElement | null)?.closest?.('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (!href.startsWith('?v=help')) return
    event.preventDefault()
    const [query, hash] = href.split('#')
    const target = new URLSearchParams((query ?? '').replace(/^\?/, '')).get('page')
    navigate({ v: 'help', page: target })
    // Same page, different section: no re-render happens, so scroll here.
    if (hash) scrollToHeading(hash)
  }

  // A deep link that arrives with a hash (from the manual or a bookmark) can
  // only scroll once the page HTML is actually in the DOM.
  useEffect(() => {
    if (!page) return
    const hash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : ''
    if (hash) scrollToHeading(hash)
    else bodyRef.current?.parentElement?.scrollTo?.({ top: 0 })
  }, [page?.slug])

  /**
   * Narrow screens show one pane at a time (help.css): the contents rail is the
   * screen you land on, and choosing a page slides it in over the rail. The
   * class says which pane is showing; the CSS decides whether that matters.
   */
  const hasSelection = active !== INDEX_SLUG

  return (
    <div className={`manual${hasSelection ? ' manual-has-selection' : ''}`}>
      <nav className="manual-nav" aria-label="Manual contents">
        <button
          type="button"
          className={`manual-nav-link${active === INDEX_SLUG ? ' active' : ''}`}
          aria-current={active === INDEX_SLUG ? 'page' : undefined}
          onClick={() => navigate({ v: 'help', page: null })}
        >
          Contents
        </button>
        {MANUAL_NAV.map((section) => (
          <div key={section.title} className="manual-nav-section">
            <h2>{section.title}</h2>
            {section.items.map((item) => (
              <button
                key={item.slug}
                type="button"
                title={item.blurb}
                className={`manual-nav-link${item.depth > 0 ? ' child' : ''}${active === item.slug ? ' active' : ''}`}
                aria-current={active === item.slug ? 'page' : undefined}
                onClick={() => navigate({ v: 'help', page: item.slug })}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <article className="manual-page">
        {/* Only ever visible on a narrow screen, where the contents rail it
            returns to is off-screen rather than beside this column. */}
        <button
          type="button"
          className="manual-back"
          onClick={() => navigate({ v: 'help', page: null })}
        >
          <span aria-hidden="true">←</span> Contents
        </button>
        {loadError ? (
          <p className="manual-status" role="alert">
            The manual could not be loaded. Reload the page to try again.
          </p>
        ) : !page ? (
          <p className="manual-status" role="status">
            Loading the manual…
          </p>
        ) : (
          <>
            <h1>{page.title}</h1>
            <div
              className="manual-body"
              ref={bodyRef}
              onClick={onBodyClick as never}
              dangerouslySetInnerHTML={{ __html: page.html }}
            />
          </>
        )}
      </article>
    </div>
  )
}

/**
 * Scroll a heading into view and put the hash in the address bar without a
 * history entry — `navigate` owns the query string, so the hash is set here
 * directly rather than routed through it.
 */
function scrollToHeading(id: string): void {
  if (typeof window === 'undefined') return
  window.requestAnimationFrame(() => {
    const target = document.getElementById(id)
    if (!target) return
    target.scrollIntoView({ block: 'start' })
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${id}`)
  })
}

export default HelpSection
