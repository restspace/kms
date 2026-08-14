import { describe, expect, it, vi } from 'vitest'
import {
  clearDeploymentRecoveryMarker,
  recoverFromStaleDeployment,
  type DeploymentRecoveryStorage,
} from './deploymentRecovery'

function memoryStorage(): DeploymentRecoveryStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

describe('stale deployment recovery', () => {
  it('reloads once and suppresses the first missing-chunk error', () => {
    const storage = memoryStorage()
    const preventDefault = vi.fn()
    const reload = vi.fn()

    expect(recoverFromStaleDeployment({ preventDefault }, storage, reload)).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(reload).toHaveBeenCalledOnce()

    const repeatedPreventDefault = vi.fn()
    expect(recoverFromStaleDeployment({ preventDefault: repeatedPreventDefault }, storage, reload)).toBe(false)
    expect(repeatedPreventDefault).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('can recover again after the replacement app has remained healthy', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    recoverFromStaleDeployment({ preventDefault: vi.fn() }, storage, reload)

    clearDeploymentRecoveryMarker(storage)

    expect(recoverFromStaleDeployment({ preventDefault: vi.fn() }, storage, reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('does not risk a reload loop when session storage is unavailable', () => {
    const storage: DeploymentRecoveryStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    }
    const preventDefault = vi.fn()
    const reload = vi.fn()

    expect(recoverFromStaleDeployment({ preventDefault }, storage, reload)).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })
})
