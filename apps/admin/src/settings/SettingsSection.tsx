import { useCallback, useEffect, useState } from 'react'
import {
  createToken,
  listTokens,
  resetDemoData,
  revokeToken,
  type ApiTokenRow,
  type Me,
} from '../api'
import { appAlert, appConfirm } from '../components/dialogs'
import { RoomsTracksCard } from './RoomsTracksCard'
import { ContactFieldsCard } from './ContactFieldsCard'
import { EmailTemplatesCard } from './EmailTemplatesCard'
import './settings.css'

/**
 * Settings (docs/12 M6): API token management for the public REST surface,
 * pointers to /docs, and the demo-data reset. Tokens are organisation-scoped;
 * the secret is shown exactly once at creation.
 */

const fmtWhen = (iso: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function SettingsSection({ me }: { me: Me }) {
  const [tokens, setTokens] = useState<ApiTokenRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [freshToken, setFreshToken] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetNote, setResetNote] = useState<string | null>(null)

  const reload = useCallback(() => {
    listTokens()
      .then((r) => setTokens(r.tokens))
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load tokens'))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const created = await createToken(name.trim() || 'API token')
      setFreshToken({ name: created.name, token: created.token })
      setCopied(false)
      setName('')
      reload()
    } catch (err) {
      void appAlert(err instanceof Error ? err.message : 'Failed to create the token.')
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (token: ApiTokenRow) => {
    const confirmed = await appConfirm(
      `Revoke "${token.name}" (${token.token_prefix}…)? Requests using it will start failing immediately.`,
      { title: 'Revoke API token', confirmLabel: 'Revoke', danger: true },
    )
    if (!confirmed) return
    await revokeToken(token.id)
    reload()
  }

  const handleReset = async () => {
    const confirmed = await appConfirm(
      'Reset the demo data? All records for the demo event are deleted and the seed is replayed. This cannot be undone.',
      { title: 'Reset demo data', confirmLabel: 'Reset', danger: true },
    )
    if (!confirmed) return
    setResetBusy(true)
    setResetNote(null)
    try {
      await resetDemoData()
      setResetNote('Demo data restored to the seeded state.')
    } catch (err) {
      setResetNote(err instanceof Error ? err.message : 'Reset failed.')
    } finally {
      setResetBusy(false)
    }
  }

  const curlExample = `curl -H "Authorization: Bearer kms_…" \\\n  "${window.location.origin}/api/v1/events/${me.event.id}/submissions?status=pending&sort=-created_at"`

  return (
    <div className="settings-shell">
      <h1>Settings</h1>

      <section className="settings-card">
        <h2>API tokens</h2>
        <p className="settings-hint">
          Bearer tokens for the <a href="/docs" target="_blank" rel="noopener">REST API</a>. Tokens can reach
          every event in your organisation; the event id travels in the URL path.
        </p>

        {freshToken && (
          <div className="settings-fresh-token" role="status">
            <div>
              <strong>{freshToken.name}</strong> created — copy the token now, it is not shown again:
            </div>
            <code className="settings-token-value">{freshToken.token}</code>
            <div className="settings-fresh-actions">
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(freshToken.token).then(() => setCopied(true))
                }}
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
              <button className="settings-ghost" onClick={() => setFreshToken(null)}>Dismiss</button>
            </div>
          </div>
        )}

        <form
          className="settings-token-create"
          onSubmit={(e) => {
            e.preventDefault()
            void handleCreate()
          }}
        >
          <input
            type="text"
            placeholder="Token name (e.g. Zapier sync)"
            value={name}
            aria-label="Token name"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create token'}
          </button>
        </form>

        {loadError ? (
          <div className="settings-error">{loadError}</div>
        ) : tokens === null ? (
          <div className="settings-hint">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="settings-empty">No tokens yet — create one to call the API.</div>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Created</th>
                <th>Last used</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className={t.revoked_at ? 'revoked' : ''}>
                  <td>{t.name}</td>
                  <td><code>{t.token_prefix}…</code></td>
                  <td>{fmtWhen(t.created_at)}</td>
                  <td>{fmtWhen(t.last_used_at)}</td>
                  <td>
                    {t.revoked_at ? (
                      <span className="settings-revoked-chip">revoked</span>
                    ) : (
                      <button className="settings-ghost danger" onClick={() => void handleRevoke(t)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <RoomsTracksCard />

      <ContactFieldsCard />

      <EmailTemplatesCard />

      <section className="settings-card">
        <h2>API docs</h2>
        <p className="settings-hint">
          Interactive reference at <a href="/docs" target="_blank" rel="noopener">/docs</a> · raw spec at{' '}
          <a href="/api/v1/openapi.json" target="_blank" rel="noopener">/api/v1/openapi.json</a>. This event's
          id is <code>{me.event.id}</code>.
        </p>
        <pre className="settings-curl"><code>{curlExample}</code></pre>
      </section>

      <section className="settings-card">
        <h2>Demo data</h2>
        <p className="settings-hint">
          Restore the demo event to its seeded state (also runs automatically every night on the public demo).
        </p>
        <div className="settings-reset-row">
          <button className="settings-danger" disabled={resetBusy} onClick={() => void handleReset()}>
            {resetBusy ? 'Resetting…' : 'Reset demo data'}
          </button>
          {resetNote && <span role="status">{resetNote}</span>}
        </div>
      </section>
    </div>
  )
}
