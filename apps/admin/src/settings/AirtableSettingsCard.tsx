import { useEffect, useState } from 'react'
import {
  getAirtableSettings,
  listAirtableBases,
  setUpAirtableBase,
  testAirtableConnection,
  updateAirtableSettings,
  type AirtableSetupReport,
  type AirtableSettings,
} from '../api'

/**
 * Airtable mirror configuration (moves the sweep's gating out of
 * wrangler.toml/env secrets). Deployment-global singleton — the mirror writes
 * one base per deployment (workplan-9 §5 option (b)), so the settings are
 * global too. The PAT never round-trips: the server returns key_set + last 4
 * chars, the input stays blank unless the user is replacing the key, and Save
 * omits api_key entirely when the input is blank.
 *
 * Laid out as numbered steps because every org brings its own Airtable account
 * and the order matters: the token must exist before we can list bases, and the
 * tables must exist before the mirror is switched on (the sweep creates no
 * schema, so turning it on against an empty base fails every write). "Create
 * the tables" is additive and idempotent, so the button stays available for
 * re-runs rather than hiding once it has succeeded.
 */
export function AirtableSettingsCard() {
  const [settings, setSettings] = useState<AirtableSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [baseId, setBaseId] = useState('')
  const [apiKey, setApiKey] = useState('') // blank = keep the stored key
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [bases, setBases] = useState<Array<{ id: string; name: string }> | null>(null)
  const [listing, setListing] = useState(false)
  const [setupRunning, setSetupRunning] = useState(false)
  const [setupResult, setSetupResult] = useState<
    { ok: true; report: AirtableSetupReport } | { ok: false; message: string } | null
  >(null)

  const reload = () => {
    setError(null)
    return getAirtableSettings()
      .then((r) => {
        setSettings(r)
        setEnabled(r.enabled)
        setBaseId(r.base_id)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load Airtable settings'))
  }

  useEffect(() => {
    void reload()
  }, [])

  // The three probe/setup calls all prefer what is typed in the form over what
  // is stored, so the whole flow works before anything is saved.
  const typed = () => {
    const key = apiKey.trim()
    const base = baseId.trim()
    return { ...(key !== '' ? { api_key: key } : {}), ...(base !== '' ? { base_id: base } : {}) }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const trimmedKey = apiKey.trim()
      const r = await updateAirtableSettings({
        enabled,
        base_id: baseId.trim(),
        ...(trimmedKey !== '' ? { api_key: trimmedKey } : {}),
      })
      setSettings(r)
      setEnabled(r.enabled)
      setBaseId(r.base_id)
      setApiKey('')
      setNote(
        r.enabled
          ? 'Saved — the mirror picks this up on the next minutely sweep.'
          : 'Saved — the mirror is off.',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save Airtable settings.')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await testAirtableConnection(typed())
      setTestResult(
        r.ok
          ? { ok: true, message: r.message ?? 'Connected — the base answered.' }
          : { ok: false, message: r.error ?? 'Connection failed.' },
      )
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : 'Connection failed.' })
    } finally {
      setTesting(false)
    }
  }

  const findBases = async () => {
    setListing(true)
    setSetupResult(null)
    try {
      const { api_key } = typed()
      const r = await listAirtableBases(api_key ? { api_key } : {})
      if (!r.ok) {
        setBases(null)
        setSetupResult({ ok: false, message: r.error ?? 'Could not list bases.' })
        return
      }
      setBases(r.bases)
      if (r.bases.length === 0) {
        setSetupResult({
          ok: false,
          message:
            'The token reached Airtable but can see no bases. Create one in Airtable (Create → Start from scratch), then add it to the token’s access list.',
        })
      }
    } catch (e) {
      setSetupResult({ ok: false, message: e instanceof Error ? e.message : 'Could not list bases.' })
    } finally {
      setListing(false)
    }
  }

  const runSetup = async () => {
    setSetupRunning(true)
    setSetupResult(null)
    try {
      const r = await setUpAirtableBase(typed())
      setSetupResult(
        r.ok && r.report ? { ok: true, report: r.report } : { ok: false, message: r.error ?? 'Setup failed.' },
      )
    } catch (e) {
      setSetupResult({ ok: false, message: e instanceof Error ? e.message : 'Setup failed.' })
    } finally {
      setSetupRunning(false)
    }
  }

  const keyPlaceholder = settings?.key_set
    ? `••••${settings.key_last4 ?? ''} (set)`
    : 'pat… (personal access token)'
  const busy = saving || testing || listing || setupRunning

  return (
    <section className="settings-card">
      <h2>Airtable mirror</h2>
      <p className="settings-hint">
        One-way mirror of this deployment's data (D1 → Airtable) into a <strong>single base</strong>, swept{' '}
        <strong>every minute</strong>. Changes here flow to Airtable; edits made in Airtable are never read
        back.
      </p>

      {error && (
        <div className="settings-error">
          {error}{' '}
          <button type="button" className="settings-ghost" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      )}

      {settings === null && !error ? (
        <div className="settings-hint">Loading…</div>
      ) : settings ? (
        <>
          <h3>1. Connect your Airtable account</h3>
          <p className="settings-hint">
            Create a personal access token at{' '}
            <a href="https://airtable.com/create/tokens" target="_blank" rel="noreferrer">
              airtable.com/create/tokens
            </a>
            . Give it the scopes <code>data.records:read</code>, <code>data.records:write</code>,{' '}
            <code>schema.bases:read</code> and <code>schema.bases:write</code>, and add your workspace (or the
            base) to its access list. Airtable shows the token once — paste it here.
          </p>

          <label className="settings-chase-mode">
            <span>API key (personal access token)</span>
            <input
              type="password"
              value={apiKey}
              disabled={busy}
              placeholder={keyPlaceholder}
              aria-label="Airtable API key"
              autoComplete="off"
              onChange={(e) => setApiKey((e.target as HTMLInputElement).value)}
            />
          </label>

          <h3>2. Choose the base</h3>
          <p className="settings-hint">
            In Airtable, <strong>Create → Start from scratch</strong> makes an empty base. Then find it here —
            or paste its ID (the <code>app…</code> part of the base's URL) if you already know it.
          </p>

          <div className="settings-reset-row">
            <button type="button" className="settings-ghost" disabled={busy} onClick={() => void findBases()}>
              {listing ? 'Looking…' : 'Find my bases'}
            </button>
            {/* A button each rather than a dropdown: the token's access list is
                normally one or two bases, and picking the wrong one silently
                mirrors into someone else's spreadsheet. */}
            {bases?.map((b) => (
              <button
                key={b.id}
                type="button"
                className="settings-ghost"
                disabled={busy}
                aria-pressed={baseId === b.id}
                onClick={() => setBaseId(b.id)}
              >
                {b.name}
                {baseId === b.id ? ' ✓' : ''}
              </button>
            ))}
          </div>

          <label className="settings-chase-mode">
            <span>Base ID</span>
            <input
              type="text"
              value={baseId}
              disabled={busy}
              placeholder="app…"
              aria-label="Airtable base ID"
              onChange={(e) => setBaseId((e.target as HTMLInputElement).value)}
            />
          </label>

          <h3>3. Create the tables</h3>
          <p className="settings-hint">
            The mirror writes into eight tables with specific columns and does not create them itself. This
            adds anything missing and never changes or deletes what is already there, so it is safe to run
            again — after a failure, or when an update adds new columns.
          </p>

          <div className="settings-reset-row">
            <button type="button" disabled={busy} onClick={() => void runSetup()}>
              {setupRunning ? 'Creating…' : 'Create the tables in Airtable'}
            </button>
            <button type="button" className="settings-ghost" disabled={busy} onClick={() => void test()}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {testResult && (
              <span role="status" className={testResult.ok ? undefined : 'settings-error'}>
                {testResult.message}
              </span>
            )}
          </div>

          {setupResult && !setupResult.ok && (
            <div className="settings-error" role="status">
              {setupResult.message}
            </div>
          )}

          {setupResult?.ok && <SetupSummary report={setupResult.report} />}

          <h3>4. Turn the mirror on</h3>
          <label className="settings-chase-mode">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
            />
            <span>Mirror to Airtable</span>
          </label>
          <p className="settings-hint">
            The first sweep copies everything across; after that each change reaches Airtable within a minute.
          </p>

          <div className="settings-reset-row">
            <button type="button" disabled={busy} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      ) : null}

      {note && <div className="settings-hint" role="status">{note}</div>}
    </section>
  )
}

/** Plain-language account of what the setup run did — counts, not raw API chatter. */
function SetupSummary({ report }: { report: AirtableSetupReport }) {
  const { createdTables, addedFields, mismatched, unchanged } = report
  const done =
    createdTables.length === 0 && addedFields.length === 0
      ? 'Nothing to do — the base already has every table and column the mirror needs.'
      : [
          createdTables.length > 0 ? `Created ${createdTables.length} table(s): ${createdTables.join(', ')}.` : '',
          addedFields.length > 0 ? `Added ${addedFields.length} column(s): ${addedFields.join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' ')

  return (
    <div className="settings-hint" role="status">
      <p>{done}</p>
      {unchanged.length > 0 && <p>Already complete: {unchanged.join(', ')}.</p>}
      {mismatched.length > 0 && (
        <p className="settings-error">
          These columns already exist with a type the mirror cannot write to — change them in Airtable, or
          rename them and run this again: {mismatched.join('; ')}.
        </p>
      )}
      <p>
        Optional, in Airtable: to see the schedule as its own tab, add a view on <strong>Submissions</strong>{' '}
        filtered to <em>Starts At is not empty</em>. Airtable's API cannot create that for us.
      </p>
    </div>
  )
}
