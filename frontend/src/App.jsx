import './App.css'

function App() {
  return (
    <main className="dummy-app">
      <section className="dummy-hero">
        <div className="dummy-copy">
          <p className="eyebrow">PulsePath emergency ops</p>
          <h1>Command, triage, and route critical care in one console.</h1>
          <p className="lead">
            A polished demo shell for ambulance dispatch, hospital allocation, and live
            incident chat.
          </p>

          <div className="button-row">
            <a className="primary" href="/login">
              Open login
            </a>
            <a className="ghost" href="http://127.0.0.1:5000/api/health" target="_blank" rel="noreferrer">
              Check backend
            </a>
          </div>

          <div className="mini-metrics">
            <article>
              <strong>42</strong>
              <span>active incidents</span>
            </article>
            <article>
              <strong>6.4m</strong>
              <span>avg response</span>
            </article>
            <article>
              <strong>99%</strong>
              <span>unit uptime</span>
            </article>
          </div>
        </div>

        <div className="dummy-panel">
          <div className="dummy-status">
            <span className="status-dot"></span>
            Live dispatch board
          </div>
          <div className="signal-grid">
            <div className="signal-card highlight">
              <span>Case #1842</span>
              <strong>Chest pain routed to cardiology</strong>
            </div>
            <div className="signal-card">
              <span>Ambulance A-12</span>
              <strong>En route, ETA 4 min</strong>
            </div>
            <div className="signal-card">
              <span>Hospital North Wing</span>
              <strong>2 ICU beds reserved</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="feature-grid">
        <article className="feature-card">
          <p className="eyebrow">Role aware</p>
          <h2>One login, role-specific dashboards.</h2>
          <p>
            Admin, hospital, and ambulance users see the tools that match their workflow.
          </p>
        </article>
        <article className="feature-card">
          <p className="eyebrow">Dispatch AI</p>
          <h2>Structured triage and smart allocation.</h2>
          <p>
            Cases flow through triage, dispatch, hospital matching, and resource logging.
          </p>
        </article>
        <article className="feature-card">
          <p className="eyebrow">Chat</p>
          <h2>Shared incident messaging.</h2>
          <p>
            The chat surface keeps teams aligned while the backend keeps the workflow moving.
          </p>
        </article>
      </section>
    </main>
  )
}

export default App
