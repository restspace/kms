// Plain-HTML pages for M0 — a deliberate, documented choice (React SSR arrives with M1).
// Every user-supplied value interpolated into markup must pass through esc().
//
// Colour, type and density come from @kms/theme, the same token layer the
// admin SPA imports as a stylesheet — these pages carry no palette of their own.

import { baseCss, statusChipCss, tokensCss } from '@kms/theme';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML-escape a user-supplied value before interpolating it into markup. */
export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);
}

/** Colour-coded status chip for the 7 submission statuses (docs/02 §4). */
export function statusChip(status: string): string {
  const label = status
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `<span class="chip st-${esc(status)}">${esc(label)}</span>`;
}

const CSS = `
${tokensCss}
${baseCss}
${statusChipCss}
body{min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:3rem 1rem}
main.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);width:100%;max-width:640px;padding:2rem}
h1{font-family:var(--font-display);font-size:1.5rem;font-weight:600;margin:0 0 .75rem}
h2{font-family:var(--font-display);font-size:1rem;margin:1.75rem 0 .5rem;color:var(--text-secondary)}
p{margin:.5rem 0}
label{margin:1rem 0 .3rem;font-size:.9rem}
button{margin-top:1.25rem;padding:.6rem 1.2rem;border:0;border-radius:var(--radius);background:var(--text);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
button:hover{background:var(--text-secondary)}
table{width:100%;border-collapse:collapse;margin-top:.75rem}
th{text-align:left;font-family:var(--font-display);font-size:.78rem;text-transform:uppercase;letter-spacing:var(--tracking-label);color:var(--text-muted);padding:.45rem .5rem;border-bottom:2px solid var(--border)}
td{padding:.55rem .5rem;border-bottom:1px solid var(--border);vertical-align:top}
ul.list{list-style:none;margin:.5rem 0 0;padding:0}
ul.list li{display:flex;align-items:baseline;gap:.6rem;padding:.55rem 0;border-bottom:1px solid var(--border)}
.code{white-space:nowrap}
.devlink{background:var(--accent-soft);border:1px solid var(--accent-border);border-radius:var(--radius);padding:.6rem .8rem;font-size:.85rem;word-break:break-all;margin-top:1rem}
/* Banner above the page heading — the one thing a first-time visitor should
   read before anything else on the page competes for attention. */
.notice{background:var(--accent-soft);border:1px solid var(--accent-border);border-radius:var(--radius);padding:.8rem .9rem;margin:0 0 1.5rem}
.notice strong{display:block;font-family:var(--font-display);font-size:.95rem;margin-bottom:.15rem}
.notice ul{list-style:none;margin:.4rem 0 0;padding:0}
.notice li{padding:.2rem 0}
.notice .muted{font-size:.85rem;margin:0}

/* Compact (640): phone layout. Appended so the desktop rules above stand.
   The table rule matters for the listing pages that reuse page() — they
   scroll their own table rather than the document. */
@media (max-width:640px){
body{padding:1.5rem .75rem}
main.card{padding:1.25rem}
h1{font-size:1.3rem}
button{min-height:44px;width:100%}
table{display:block;overflow-x:auto;white-space:nowrap}
}
`.trim();

/** Complete HTML5 document wrapping `body` in the shared card layout. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>`;
}
