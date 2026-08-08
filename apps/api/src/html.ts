// Plain-HTML pages for M0 — a deliberate, documented choice (React SSR arrives with M1).
// Every user-supplied value interpolated into markup must pass through esc().

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
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f5f6f8;color:#1f2937;min-height:100vh;display:flex;justify-content:center;align-items:flex-start;padding:3rem 1rem;line-height:1.5}
main.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.06);width:100%;max-width:640px;padding:2rem}
h1{font-size:1.35rem;margin:0 0 .75rem}
h2{font-size:1rem;margin:1.75rem 0 .5rem;color:#374151}
p{margin:.5rem 0}
.muted{color:#6b7280;font-size:.9rem}
a{color:#2563eb}
label{display:block;font-weight:600;font-size:.9rem;margin:1rem 0 .3rem}
input,select{width:100%;box-sizing:border-box;padding:.55rem .7rem;border:1px solid #d1d5db;border-radius:6px;font:inherit;background:#fff}
button{margin-top:1.25rem;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1f2937;color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:#374151}
table{width:100%;border-collapse:collapse;margin-top:.75rem}
th{text-align:left;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;padding:.45rem .5rem;border-bottom:2px solid #e5e7eb}
td{padding:.55rem .5rem;border-bottom:1px solid #f3f4f6;vertical-align:top}
ul.list{list-style:none;margin:.5rem 0 0;padding:0}
ul.list li{display:flex;align-items:baseline;gap:.6rem;padding:.55rem 0;border-bottom:1px solid #f3f4f6}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82rem;color:#6b7280;white-space:nowrap}
.banner{background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:6px;padding:.5rem .8rem;font-size:.88rem;margin-bottom:1rem}
.devlink{background:#eef2ff;border:1px solid #c7d2fe;border-radius:6px;padding:.6rem .8rem;font-size:.85rem;word-break:break-all;margin-top:1rem}
.chip{display:inline-block;padding:.12rem .6rem;border-radius:999px;font-size:.75rem;font-weight:600;white-space:nowrap}
.st-draft{background:#f3f4f6;color:#4b5563}
.st-pending{background:#fef9c3;color:#854d0e}
.st-accept_queue{background:#dcfce7;color:#15803d}
.st-accepted{background:#bbf7d0;color:#166534}
.st-decline_queue{background:#fef3c7;color:#b45309}
.st-declined{background:#fee2e2;color:#b91c1c}
.st-withdrawn{background:#e2e8f0;color:#475569}
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
