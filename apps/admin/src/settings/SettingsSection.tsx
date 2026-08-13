import { useCallback, useEffect, useState } from 'react'
import {
  createToken,
  getDemoSettings,
  listTokens,
  resetDemoData,
  revokeToken,
  type ApiTokenRow,
  type Me,
} from '../api'
import { DesktopOnlyNotice } from '@kms/ui/desktop-only'
import { appAlert, appConfirm } from '../components/dialogs'
import { RoomsTracksCard } from './RoomsTracksCard'
import { SettingsHistory } from './SettingsHistory'
import { ContactFieldsCard } from './ContactFieldsCard'
import { SpeakerStatusesCard } from './SpeakerStatusesCard'
import { EmailTemplatesCard } from './EmailTemplatesCard'
import { ChaseSettingsCard } from './ChaseSettingsCard'
import { FileCollectionDefaultsCard } from './FileCollectionDefaultsCard'
import { AirtableSettingsCard } from './AirtableSettingsCard'
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

/**
 * What the redirect does to one address, shown so the tester can see the shape
 * before committing to a reset. Mirrors apps/api/src/demoEmails.ts, which owns
 * the real derivation — this only ever illustrates the first seeded speaker.
 */
const plusExample = (email: string): string => {
  const at = email.lastIndexOf('@')
  if (at <= 0) return email
  return `${email.slice(0, at).split('+')[0]}+ada@${email.slice(at + 1)}`
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
  // The tester mailbox seeded contacts are redirected to. `null` while the
  // setting is still loading, so the field does not flash empty over a stored
  // value and then save that emptiness on the next reset.
  const [redirectEmail, setRedirectEmail] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoadError(null)
    listTokens()
      .then((r) => setTokens(r.tokens))
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load tokens'))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    // 403 means DEMO_RESET is off on this deployment — the card below is
    // harmless there (the button already reports the refusal), so the field
    // just stays empty rather than surfacing an error nobody can act on.
    getDemoSettings()
      .then((r) => setRedirectEmail(r.redirect_email ?? ''))
      .catch(() => setRedirectEmail(''))
  }, [])

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
    const target = (redirectEmail ?? '').trim()
    const confirmed = await appConfirm(
      `Reset the demo data? All records for the demo event are deleted and the seed is replayed. This cannot be undone.${
        target ? `\n\nEvery seeded contact will be given a ${target} address (${plusExample(target)}).` : ''
      }`,
      { title: 'Reset demo data', confirmLabel: 'Reset', danger: true },
    )
    if (!confirmed) return
    setResetBusy(true)
    setResetNote(null)
    try {
      // Passing the field value saves it as well as applying it, so a typed
      // address survives the nightly reset without a separate Save button.
      const result = await resetDemoData(target)
      setResetNote(
        result.redirect_email
          ? `Demo data restored, with contact emails redirected to ${result.redirect_email}.`
          : 'Demo data restored to the seeded state.',
      )
    } catch (err) {
      setResetNote(err instanceof Error ? err.message : 'Reset failed.')
    } finally {
      setResetBusy(false)
    }
  }

  const curlExample = `curl -H "Authorization: Bearer kms_…" \\\n  "${window.location.origin}/api/v1/events/${me.event.id}/submissions?status=pending&sort=-created_at"`

  return (
    <>
      {/*
        * Tier C refusal (docs/16 item 7): the hub is configuration — token
        * tables, room/track and field libraries, email template bodies — all
        * of it "arrange many things". CSS-only gate, no viewport detection.
        */}
      <div className="kms-compact-only">
        <DesktopOnlyNotice
          title="Settings needs a wider window."
          message="Token tables, the field library and email template bodies are all wider than a phone. Open this one on a laptop."
          summary={
            <dl className="settings-compact-summary">
              <dt>Event</dt>
              <dd>{me.event.name}</dd>
              <dt>Timezone</dt>
              <dd>{me.event.timezone}</dd>
              <dt>Slug</dt>
              <dd>{me.event.slug}</dd>
            </dl>
          }
          action={{ label: 'Open the speaker portal', href: `/portal/${me.event.slug}` }}
        />
      </div>
    <div className="settings-shell kms-wide-only">
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
          <div className="settings-error">
            {loadError}{' '}
            <button type="button" className="settings-ghost" onClick={reload}>
              Retry
            </button>
          </div>
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

      <SpeakerStatusesCard />

      <EmailTemplatesCard />

      <ChaseSettingsCard />

      <FileCollectionDefaultsCard />

      <AirtableSettingsCard />

      {/*
        * Wave E (workplan 14, D8): pre-edit snapshots of the event's settings
        * (name/slug/dates/description/…, content_revisions entity_type
        * 'settings') — and, since the rooms/tracks history fix, of the room
        * and track lists too. Restore writes an event-fields snapshot back
        * through the normal events PATCH, which snapshots the replaced values
        * itself; rooms/tracks rows are informational (their way back is the
        * delete confirmation's Undo).
        */}
      <section className="settings-card">
        <h2>Settings history</h2>
        <p className="settings-hint">
          Every change to the event's details — including room and track edits — is recorded; restore puts
          the pre-edit values back.
        </p>
        <SettingsHistory eventId={me.event.id} />
      </section>

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
        <label className="settings-field">
          <span>Send all contact email to</span>
          <input
            type="email"
            placeholder="you@example.com (optional)"
            value={redirectEmail ?? ''}
            disabled={redirectEmail === null || resetBusy}
            onChange={(e) => setRedirectEmail((e.target as HTMLInputElement).value)}
          />
        </label>
        <p className="settings-hint">
          {(redirectEmail ?? '').trim() ? (
            <>
              Every seeded contact is given a distinct variant of this address — Ada Lovelace becomes{' '}
              <code>{plusExample((redirectEmail ?? '').trim())}</code> — so all demo mail lands in one mailbox and you
              can still tell who each message was for. Organiser accounts keep their real address so you can still sign
              in. Saved with the reset, and reapplied by the nightly reset; clear the field to go back to the seeded{' '}
              <code>@example.com</code> addresses.
            </>
          ) : (
            <>
              Optional. Give a mailbox you can open and every seeded contact is rewritten to a{' '}
              <code>you+name@…</code> variant of it, so demo mail is deliverable but still distinguishable. Left empty,
              contacts keep their seeded <code>@example.com</code> addresses.
            </>
          )}
        </p>
        <div className="settings-reset-row">
          <button className="settings-danger" disabled={resetBusy} onClick={() => void handleReset()}>
            {resetBusy ? 'Resetting…' : 'Reset demo data'}
          </button>
          {resetNote && <span role="status">{resetNote}</span>}
        </div>
      </section>
    </div>
    </>
  )
}
