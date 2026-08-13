import { useEffect, useState } from 'react'
import {
  getAirtableSettings,
  testAirtableConnection,
  updateAirtableSettings,
  type AirtableSettings,
} from '../api'

/**
 * Airtable mirror configuration (moves the sweep's gating out of
 * wrangler.toml/env secrets). Deployment-global singleton — the mirror writes
 * one base per deployment (workplan-9 §5 option (b)), so the settings are
 * global too. The PAT never round-trips: the server returns key_set + last 4
 * chars, the input stays blank unless the user is replacing the key, and Save
 * omits api_key entirely when the input is blank.
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
      const trimmedKey = apiKey.trim()
      const trimmedBase = baseId.trim()
      const r = await testAirtableConnection({
        ...(trimmedKey !== '' ? { api_key: trimmedKey } : {}),
        ...(trimmedBase !== '' ? { base_id: trimmedBase } : {}),
      })
      setTestResult(
        r.ok
          ? { ok: true, message: 'Connected — the base answered.' }
          : { ok: false, message: r.error ?? 'Connection failed.' },
      )
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : 'Connection failed.' })
    } finally {
      setTesting(false)
    }
  }

  const keyPlaceholder = settings?.key_set
    ? `••••${settings.key_last4 ?? ''} (set)`
    : 'pat… (personal access token)'

  return (
    <section className="settings-card">
      <h2>Airtable mirror</h2>
      <p className="settings-hint">
        One-way mirror of this deployment's data (D1 → Airtable) into a <strong>single base</strong>, swept{' '}
        <strong>every minute</strong>. Changes here flow to Airtable; edits made in Airtable are never read
        back. Needs a personal access token with write access to the base.
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
          <label className="settings-chase-mode">
            <input
              type="checkbox"
              checked={enabled}
              disabled={saving}
              onChange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
            />
            <span>Mirror to Airtable</span>
          </label>

          <label className="settings-chase-mode">
            <span>API key (personal access token)</span>
            <input
              type="password"
              value={apiKey}
              disabled={saving}
              placeholder={keyPlaceholder}
              aria-label="Airtable API key"
              autoComplete="off"
              onChange={(e) => setApiKey((e.target as HTMLInputElement).value)}
            />
          </label>

          <label className="settings-chase-mode">
            <span>Base ID</span>
            <input
              type="text"
              value={baseId}
              disabled={saving}
              placeholder="app…"
              aria-label="Airtable base ID"
              onChange={(e) => setBaseId((e.target as HTMLInputElement).value)}
            />
          </label>

          <div className="settings-reset-row">
            <button type="button" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="settings-ghost" disabled={testing} onClick={() => void test()}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {testResult && (
              <span role="status" className={testResult.ok ? undefined : 'settings-error'}>
                {testResult.message}
              </span>
            )}
          </div>
        </>
      ) : null}

      {note && <div className="settings-hint" role="status">{note}</div>}
    </section>
  )
}
