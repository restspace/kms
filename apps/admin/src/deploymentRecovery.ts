const DEPLOYMENT_RELOAD_KEY = 'kms:deployment-reload'

export interface DeploymentRecoveryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Recover when an already-open admin bundle requests a lazy chunk removed by a
 * newer deployment. The session marker permits one reload and lets a repeated
 * failure reach the normal error boundary instead of creating a reload loop.
 */
export function recoverFromStaleDeployment(
  event: Pick<Event, 'preventDefault'>,
  storage: DeploymentRecoveryStorage,
  reload: () => void,
): boolean {
  try {
    if (storage.getItem(DEPLOYMENT_RELOAD_KEY)) return false
    storage.setItem(DEPLOYMENT_RELOAD_KEY, '1')
  } catch {
    // Without a marker that survives navigation, reloading could loop forever.
    return false
  }

  event.preventDefault()
  reload()
  return true
}

/** Clear the loop guard after the replacement application has stayed healthy. */
export function clearDeploymentRecoveryMarker(storage: DeploymentRecoveryStorage): void {
  try {
    storage.removeItem(DEPLOYMENT_RELOAD_KEY)
  } catch {
    // Storage can be unavailable in restricted browsing modes; recovery simply
    // remains disabled there.
  }
}
