import { Component, type ReactNode } from 'react'

/**
 * Section-level error boundary (manual review: admin surfaces dying with a
 * bare "Failed to fetch" instead of a renderable message). Catches render
 * and lifecycle exceptions in the wrapped subtree — NOT rejected promises
 * from a plain `fetch()` inside a `useEffect`, which never reach React/Preact's
 * error path. Section components that load data async should still catch
 * their own fetch failures and set local error state (as DataList and
 * ReviewerWorkspace already do); this boundary is the backstop for anything
 * that throws while rendering — a malformed API payload the section didn't
 * guard against, a null-deref in a formatter, etc. — so one section's bug
 * can't blank the whole admin shell.
 *
 * `resetKey` remounts the boundary (clearing a caught error) when it
 * changes — pass something that identifies the content being shown, e.g. the
 * current event id or nav section key, so navigating away and back retries
 * instead of staying stuck on the last error.
 */

interface AdminErrorBoundaryProps {
  children: ReactNode
  /** Optional label shown in the fallback, e.g. "Review" or the failing endpoint. */
  section?: string
  resetKey?: string | number
}

interface AdminErrorBoundaryState {
  error: Error | null
}

export class AdminErrorBoundary extends Component<AdminErrorBoundaryProps, AdminErrorBoundaryState> {
  state: AdminErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AdminErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error(`AdminErrorBoundary caught an error${this.props.section ? ` in ${this.props.section}` : ''}`, error)
  }

  componentDidUpdate(prevProps: AdminErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (error) {
      return (
        <div className="admin-error-boundary" role="alert">
          <h2>{this.props.section ? `${this.props.section} failed to load` : 'Something went wrong'}</h2>
          <p className="admin-error-boundary-message">{error.message || 'Unexpected error.'}</p>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
