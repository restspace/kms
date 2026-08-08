import type { ReactNode } from 'react'

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

const baseCss = `
:root { color-scheme: light dark; --fg:#111827; --muted:#6b7280; --bg:#ffffff; --line:#e5e7eb; --accent:#4f46e5; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#f3f4f6; --muted:#9ca3af; --bg:#0b0f19; --line:#1f2937; --accent:#818cf8; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 42rem; margin: 0 auto; padding: 4rem 1.5rem; }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 .5rem; letter-spacing: -.02em; }
p { margin: 0 0 1rem; }
.muted { color: var(--muted); }
.card { border:1px solid var(--line); border-radius:12px; padding:1.25rem; margin:1.5rem 0; }
.row { display:flex; gap:.75rem; align-items:center; }
button { font:inherit; padding:.4rem .9rem; border-radius:8px; border:1px solid var(--line);
  background:transparent; color:var(--fg); cursor:pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em;
  background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.1em .35em; border-radius:4px; }
`
