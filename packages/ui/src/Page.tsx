import type { ReactNode } from 'react'
import { baseCss as sharedBaseCss, tokensCss } from '@kms/theme'

interface PageProps {
  title: string
  /** Path of the hydration bundle for this page, if the page has an island. */
  clientEntry?: string
  /** Data handed to the island at hydration time, avoiding a client fetch on first paint. */
  bootstrap?: unknown
  children: ReactNode
}

/**
 * The document shell for every SSR'd public page. Deliberately dependency-free:
 * public pages ship no client JS except their island (docs/03 §6).
 */
export function Page({ title, clientEntry, bootstrap, children }: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: baseCss }} />
      </head>
      <body>
        <div id="root">{children}</div>
        {bootstrap !== undefined && (
          <script
            id="bootstrap"
            type="application/json"
            dangerouslySetInnerHTML={{ __html: safeJson(bootstrap) }}
          />
        )}
        {clientEntry && <script type="module" src={clientEntry} />}
      </body>
    </html>
  )
}

/** JSON embedded in HTML must not be able to close the script element. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * Public pages share the app-wide token layer (@kms/theme) rather than
 * carrying their own palette. Only the page-level layout and element defaults
 * specific to these documents live here.
 */
const baseCss = `
${tokensCss}
${sharedBaseCss}
:root { color-scheme: light dark; }
body { font-size: 16px; line-height: 1.6; }
main { max-width: 42rem; margin: 0 auto; padding: 4rem 1.5rem; }
h1 { font-family: var(--font-display); font-size: 2.25rem; font-weight: 600; line-height: 1.15; margin: 0 0 .5rem; letter-spacing: -.01em; }
p { margin: 0 0 1rem; }
.card { border:1px solid var(--border); border-radius:var(--radius); padding:1.25rem; margin:1.5rem 0; }
.row { display:flex; gap:.75rem; align-items:center; }
button { font:inherit; padding:.4rem .9rem; border-radius:var(--radius); border:1px solid var(--border);
  background:transparent; color:var(--text); cursor:pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
code { font-family: var(--font-mono); font-size:.9em;
  background:color-mix(in srgb, var(--text) 8%, transparent); padding:.1em .35em; border-radius:var(--radius); }
`
