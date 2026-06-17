import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useData } from '../context/DataContext.jsx'
import MapPanel from '../components/MapPanel.jsx'
import Panel from '../components/Panel.jsx'
import StatCard from '../components/StatCard.jsx'
import StatusPill from '../components/StatusPill.jsx'
import TopBar from '../components/TopBar.jsx'
import EmergencyDispatchForm from '../components/EmergencyDispatchForm.jsx'
import CaseMap from '../components/CaseMap.jsx'
import * as api from '../services/api.js'
import {
  buildAuditTrail,
  groupCasesByStatus,
  summarizeCases,
  sortCasesByPriority,
} from '../utils/incidentInsights.js'

function AdminDashboard() {
  const {
    cases,
    hospitals,
    ambulances,
    loading,
    error,
    refreshCases,
    refreshHospitals,
    refreshAmbulances,
  } = useData()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [assignment, setAssignment] = useState({ caseId: '', hospitalId: '', ambulanceId: '' })
  const [activityMessage, setActivityMessage] = useState('')
  const [submitting, setSubmitting] = useState('')

  const analytics = useMemo(() => summarizeCases(cases), [cases])
  const grouped = useMemo(() => groupCasesByStatus(cases), [cases])
  const auditTrail = useMemo(() => buildAuditTrail(cases), [cases])

  const filteredCases = useMemo(() => {
    const query = search.trim().toLowerCase()
    return sortCasesByPriority(cases).filter((item) => {
      const matchesSeverity =
        severityFilter === 'all' || String(item.severity || '').toUpperCase() === severityFilter
      const matchesStatus =
        statusFilter === 'all' || String(item.status || '').toLowerCase() === statusFilter
      const matchesQuery =
        !query ||
        [item.id, item.patient_name, item.condition, item.location, item.hospital_id, item.ambulance_id]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query))

      return matchesSeverity && matchesStatus && matchesQuery
    })
  }, [cases, search, severityFilter, statusFilter])

  const fleetRows = useMemo(() => {
    return ambulances.map((ambulance) => {
      const assignedCase = cases.find((item) => String(item.ambulance_id) === String(ambulance.id)) || null
      return {
        ...ambulance,
        assignedCase,
      }
    })
  }, [ambulances, cases])

  const selectedCase = useMemo(
    () => filteredCases.find((item) => String(item.id) === String(assignment.caseId)) || filteredCases[0] || null,
    [assignment.caseId, filteredCases],
  )

  const statusCards = [
    { label: 'Active cases', value: String(analytics.active), helper: 'Open incidents' },
    { label: 'Critical cases', value: String(analytics.critical), helper: 'P0 / P1 cases' },
    { label: 'Average ETA', value: analytics.avgEta ? `${analytics.avgEta} min` : '—', helper: 'From case records' },
    { label: 'Average age', value: analytics.avgAge ? `${analytics.avgAge} min` : '—', helper: 'Time since creation' },
  ]

  const handleAssignment = async (kind) => {
    const caseId = assignment.caseId
    if (!caseId) {
      setActivityMessage('Select a case first.')
      return
    }

    try {
      setSubmitting(kind)
      setActivityMessage('')

      if (kind === 'hospital') {
        if (!assignment.hospitalId) {
          setActivityMessage('Select a hospital first.')
          return
        }
        await api.changeHospital(caseId, assignment.hospitalId)
        setActivityMessage(`Case ${caseId} reassigned to hospital ${assignment.hospitalId}.`)
      }

      if (kind === 'ambulance') {
        if (!assignment.ambulanceId) {
          setActivityMessage('Select an ambulance first.')
          return
        }
        await api.changeAmbulance(caseId, assignment.ambulanceId)
        setActivityMessage(`Case ${caseId} reassigned to ambulance ${assignment.ambulanceId}.`)
      }

      await Promise.all([refreshCases(), refreshHospitals(), refreshAmbulances()])
    } catch (err) {
      setActivityMessage(err.message || 'Assignment failed.')
    } finally {
      setSubmitting('')
    }
  }

  if (error) {
    return (
      <div className="page">
        <TopBar title="City Admin Command" subtitle="Error loading data" />
        <div className="panel" style={{ gridColumn: 'span 3' }}>
          <p style={{ color: 'var(--danger)' }}>Error: {error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <EmergencyDispatchForm />

      <TopBar
        title="City Admin Command"
        subtitle={loading ? 'Loading...' : 'System-wide analytics, reassignment, and audit controls'}
        actions={
          <>
            <button className="ghost" onClick={() => navigate('/chat')}>
              Open chat
            </button>
            <button
              className="ghost"
              onClick={() => Promise.all([refreshCases(), refreshHospitals(), refreshAmbulances()])}
            >
              Refresh data
            </button>
            <button className="primary" onClick={() => navigate('/hospital/dashboard')}>
              Hospital view
            </button>
          </>
        }
      />

      <section className="stats-grid">
        {statusCards.map((item) => (
          <StatCard key={item.label} label={item.label} value={item.value} helper={item.helper} />
        ))}
      </section>

      <section className="grid">
        <Panel title="Hospital analytics" className="cases">
          <div className="admin-toolbar">
            <input
              type="search"
              placeholder="Search cases, patients, locations..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}>
              <option value="all">All severities</option>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All statuses</option>
              <option value="created">Created</option>
              <option value="triaged">Triaged</option>
              <option value="dispatched">Dispatched</option>
              <option value="arrived">Arrived</option>
              <option value="resolved">Resolved</option>
              <option value="alerts_sent">Alerts sent</option>
              <option value="discharged">Discharged</option>
            </select>
          </div>

          {filteredCases.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>No cases match the current filters.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Hospital</th>
                  <th>Ambulance</th>
                </tr>
              </thead>
              <tbody>
                {filteredCases.slice(0, 8).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>#{item.id}</strong>
                      <div className="muted">{item.patient_name || 'Unknown patient'}</div>
                    </td>
                    <td>
                      <span className={`severity ${String(item.severity || 'P2').toLowerCase()}`}>
                        {item.severity || 'P2'}
                      </span>
                    </td>
                    <td>
                      <StatusPill text={item.status || 'created'} tone="dispatching" />
                    </td>
                    <td>{item.hospital_id || 'Unassigned'}</td>
                    <td>{item.ambulance_id || 'Unassigned'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Real-time case map" className="map">
          <CaseMap />
        </Panel>

        <Panel title="Smart case assignment" className="form">
          <div className="admin-assignment">
            <label>
              Case
              <select
                value={assignment.caseId}
                onChange={(event) => setAssignment((prev) => ({ ...prev, caseId: event.target.value }))}
              >
                <option value="">Select case</option>
                {filteredCases.map((item) => (
                  <option key={item.id} value={item.id}>
                    Case {item.id} · {item.severity || 'P2'}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Hospital
              <select
                value={assignment.hospitalId}
                onChange={(event) => setAssignment((prev) => ({ ...prev, hospitalId: event.target.value }))}
              >
                <option value="">Select hospital</option>
                {hospitals.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || `Hospital ${item.id}`}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Ambulance
              <select
                value={assignment.ambulanceId}
                onChange={(event) => setAssignment((prev) => ({ ...prev, ambulanceId: event.target.value }))}
              >
                <option value="">Select ambulance</option>
                {ambulances.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.driver_name || `Ambulance ${item.id}`}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="button-row">
            <button className="primary" onClick={() => handleAssignment('hospital')} disabled={Boolean(submitting)}>
              {submitting === 'hospital' ? 'Reassigning...' : 'Assign hospital'}
            </button>
            <button className="ghost" onClick={() => handleAssignment('ambulance')} disabled={Boolean(submitting)}>
              {submitting === 'ambulance' ? 'Reassigning...' : 'Assign ambulance'}
            </button>
          </div>

          {activityMessage ? <p className="muted">{activityMessage}</p> : null}

          {selectedCase ? (
            <div className="context-card">
              <p className="eyebrow">Selected case</p>
              <h4>Case {selectedCase.id}</h4>
              <p className="muted">
                {selectedCase.condition || 'No condition'} · {selectedCase.location || 'No location'}
              </p>
            </div>
          ) : null}
        </Panel>

        <Panel title="Ambulance fleet" className="timeline">
          {fleetRows.length === 0 ? (
            <p className="muted">No ambulances tracked yet.</p>
          ) : (
            <ul className="request-list">
              {fleetRows.slice(0, 6).map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.driver_name || `Ambulance ${item.id}`}</strong>
                    <span>
                      {item.status || 'idle'} · {item.assignedCase ? `Case ${item.assignedCase.id}` : 'No case'}
                    </span>
                  </div>
                  <StatusPill
                    text={item.status || 'idle'}
                    tone={item.status === 'idle' ? 'active' : 'dispatching'}
                  />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Audit trail" className="chat">
          <ul className="request-list">
            {auditTrail.length === 0 ? (
              <li>
                <div>
                  <strong>No case activity yet</strong>
                  <span>Workflow events will appear here as cases move through the system.</span>
                </div>
              </li>
            ) : (
              auditTrail.map((item) => (
                <li key={`${item.id}-${item.time}`}>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <StatusPill text={item.time} tone="dispatching" />
                </li>
              ))
            )}
          </ul>
        </Panel>

        <Panel title="Operations summary" className="map">
          <div className="mini-metrics" style={{ marginTop: 0 }}>
            <article>
              <strong>{grouped.created.length}</strong>
              <span>Created</span>
            </article>
            <article>
              <strong>{grouped.triaged.length}</strong>
              <span>Triaged</span>
            </article>
            <article>
              <strong>{grouped.dispatched.length}</strong>
              <span>Dispatched</span>
            </article>
          </div>
          <p className="muted" style={{ marginTop: '14px' }}>
            The backend currently exposes case-level records rather than a dedicated logs API, so the audit view is derived from live case state.
          </p>
        </Panel>
      </section>
    </div>
  )
}

export default AdminDashboard