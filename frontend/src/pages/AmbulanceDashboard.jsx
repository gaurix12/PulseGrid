import ChatPanel from '../components/ChatPanel.jsx'
import MapPanel from '../components/MapPanel.jsx'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import StatusPill from '../components/StatusPill.jsx'
import TopBar from '../components/TopBar.jsx'

const activeCase = {
  id: 'C-1042',
  patient: 'Cardiac arrest, 52F',
  location: 'Docklands / Pier 12',
  hospital: 'St. Vincent',
  severity: 'P0',
  eta: '6 min',
}

const routeUpdates = [
  { id: 1, label: 'Status', value: 'En route' },
  { id: 2, label: 'Traffic delay', value: '+4 min' },
  { id: 3, label: 'Arrival ETA', value: '10:26' },
]

const nearbyHospitals = [
  { name: 'St. Vincent', distance: '4.2 km', icu: '2 beds' },
  { name: 'Royal Melbourne', distance: '5.1 km', icu: '1 bed' },
  { name: 'Alfred', distance: '6.4 km', icu: '0 beds' },
]

const caseQueue = [
  { id: 'C-1042', status: 'Active', severity: 'P0', location: 'Docklands' },
  { id: 'C-1045', status: 'Awaiting pickup', severity: 'P1', location: 'South Yarra' },
]

const messages = [
  { from: 'Dispatch', time: '08:19', text: 'Hold route, bridge closure.' },
  { from: 'Ambulance AI', time: '08:20', text: 'Suggested detour via Harbor Tunnel.' },
]

function AmbulanceDashboard() {
  return (
    <div className="page">
      <TopBar
        title="Ambulance Unit AMB-07"
        subtitle="Active patient transport"
        actions={
          <>
            <button className="ghost">Request backup</button>
            <button className="primary">Update status</button>
          </>
        }
      />

      <section className="stats-grid">
        <StatCard label="Assigned case" value={activeCase.id} helper="Priority P0" />
        <StatCard label="Current ETA" value={activeCase.eta} helper="Traffic +4 min" />
        <StatCard label="Destination" value={activeCase.hospital} helper="ICU bed" />
        <StatCard label="Next update" value="2 min" helper="Auto ping" />
      </section>

      <section className="grid">
        <Panel title="Active case" className="cases">
          <div className="active-case">
            <div>
              <h4>{activeCase.patient}</h4>
              <p className="muted">{activeCase.location}</p>
              <div className="pill-row">
                <span className={`severity ${activeCase.severity.toLowerCase()}`}>
                  {activeCase.severity}
                </span>
                <span className="pill">Hospital: {activeCase.hospital}</span>
              </div>
            </div>
            <div className="status-controls">
              {routeUpdates.map((item) => (
                <div key={item.id}>
                  <p className="metric-label">{item.label}</p>
                  <p className="metric">{item.value}</p>
                </div>
              ))}
              <div className="status-buttons">
                {['Dispatched', 'Picked Up', 'En Route', 'Delayed', 'Arrived'].map(
                  (state) => (
                    <button key={state} className="chip">
                      {state}
                    </button>
                  ),
                )}
              </div>
              <button className="primary full">Send delay note</button>
            </div>
          </div>
        </Panel>

        <Panel title="Nearby hospitals" className="timeline">
          <ul className="request-list">
            {nearbyHospitals.map((item) => (
              <li key={item.name}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.distance} away</span>
                </div>
                <StatusPill text={`ICU ${item.icu}`} tone="active" />
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Cases needing service" className="map">
          <MapPanel
            title="Route coverage"
            subtitle="2 cases awaiting pickup"
            tags={['P0 active', 'P1 waiting', 'Traffic moderate']}
          />
        </Panel>

        <Panel title="Case queue" className="form">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Status</th>
                <th>Severity</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {caseQueue.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.id}</strong>
                  </td>
                  <td>
                    <StatusPill text={item.status} tone="dispatching" />
                  </td>
                  <td>
                    <span className={`severity ${item.severity.toLowerCase()}`}>
                      {item.severity}
                    </span>
                  </td>
                  <td>{item.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Chat" className="chat">
          <ChatPanel
            title="Dispatch chat"
            messages={messages}
            placeholder="Send update to dispatch"
          />
        </Panel>
      </section>
    </div>
  )
}

export default AmbulanceDashboard
