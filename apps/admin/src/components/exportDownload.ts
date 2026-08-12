// Export download with visible feedback (2026-08-12 eval: the ↓CSV/↓XLSX
// buttons fired a silent anchor click — no confirmation, no filename, no
// failure state, so the organiser could not tell whether anything happened).
//
// Fetching the export ourselves (same-origin cookie auth, like every other
// API call) lets us: (1) surface a real success/failure outcome, (2) read the
// server's Content-Disposition filename so the on-screen note names the file
// that actually landed in the downloads folder, and (3) still hand the bytes
// to the browser as a normal download via a Blob URL.

/** Pull the filename out of a Content-Disposition header, or null. */
export function parseAttachmentFilename(header: string | null | undefined): string | null {
  if (!header) return null
  // RFC 5987 extended form first (filename*=UTF-8''...), then the quoted and
  // bare forms of the plain parameter.
  const ext = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (ext?.[1]) {
    try {
      return decodeURIComponent(ext[1].trim())
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/.exec(header)
  if (quoted?.[1]) return quoted[1]
  const bare = /filename\s*=\s*([^;\s]+)/.exec(header)
  return bare?.[1] ?? null
}

/**
 * Fetch `url` and trigger a browser download of the response body.
 * Resolves with the downloaded filename; rejects with a human-readable Error
 * when the server answers non-2xx (the JSON error code is surfaced) or the
 * network fails.
 */
export async function downloadExport(url: string, fallbackName: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: '*/*' } })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ? `the server answered ${body.error}` : `the server answered HTTP ${res.status}`)
  }
  const filename = parseAttachmentFilename(res.headers.get('content-disposition')) ?? fallbackName
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Give the click a tick to hand the URL to the download machinery.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
  }
  return filename
}
