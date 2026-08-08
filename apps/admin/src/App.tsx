export default function App() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        background: '#f8fafc',
        color: '#0f172a',
        margin: 0,
      }}
    >
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>
          KMS Admin — SPA lands in M1
        </h1>
        <p style={{ color: '#64748b', marginTop: '0.75rem' }}>
          Abstracts grid, agenda builder and dashboards arrive with milestones
          M1–M5.
        </p>
      </div>
    </div>
  )
}
