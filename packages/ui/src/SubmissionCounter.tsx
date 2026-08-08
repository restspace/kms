import { useState } from 'react'

/**
 * Placeholder island. Its only job right now is to prove that a component
 * server-rendered by the Worker hydrates from the public bundle — the mechanism
 * the CFP form wizard will use (docs/03 §3).
 */
export function SubmissionCounter({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial)
  return (
    <div className="row">
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        Simulate a submission
      </button>
      <span className="muted">
        {count} submission{count === 1 ? '' : 's'}
      </span>
    </div>
  )
}
