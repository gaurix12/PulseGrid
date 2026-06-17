import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useData } from '../context/DataContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import MapPanel from '../components/MapPanel.jsx'
import Panel from '../components/Panel.jsx'
import ResourcePanel from '../components/ResourcePanel.jsx'
import StatCard from '../components/StatCard.jsx'
import StatusPill from '../components/StatusPill.jsx'
import TopBar from '../components/TopBar.jsx'
import * as api from '../services/api.js'
import {
  buildCaseQueue,
  formatTimeAgo,
  getCaseAgeMinutes,
  groupCasesByStatus,
  summarizeCases,
  sortCasesByPriority,
} from '../utils/incidentInsights.js'

const ARCHIVE_WINDOWS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
  { key: 'all', label: 'All time' },
]

function isWithinWindow(createdAt, windowKey) {
  if (!createdAt || windowKey === 'all') return true

  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return false

  const now = Date.now()
  const ageMinutes = Math.max(0, Math.round((now - date.getTime()) / 60000))

  if (windowKey === 'today') return ageMinutes <= 24 * 60
  if (windowKey === 'week') return ageMinutes <= 7 * 24 * 60
  if (windowKey === 'month') return ageMinutes <= 30 * 24 * 60
  return true
}

function HospitalDashboard() {
  const { user } = useAuth()
  const { cases, hospitals, loading, error, refreshCases, refreshHospitals } = useData()
  const navigate = useNavigate()
  const [hospitalCases, setHospitalCases] = useState([])
  const [hospitalError, setHospitalError] = useState('')
  const [archiveWindow, setArchiveWindow] = useState('week')

  useEffect(() => {
    if (!user?.hospital_id) {
      setHospitalCases([])
      return
    }

    api
      .getHospitalCases(user.hospital_id)
      .then((items) => setHospitalCases(Array.isArray(items) ? items : []))
      .catch((err) => {
        setHospitalError(err.message || 'Failed to load hospital cases.')
        setHospitalCases(cases.filter((item) => String(item.hospital_id) === String(user.hospital_id)))
      })
  }, [cases, user?.hospital_id])

  const currentHospital = useMemo(() => {
    if (user?.hospital_id) {
      return hospitals.find((item) => String(item.id) === String(user.hospital_id)) || null
    }
    return hospitals[0] || null
  }, [hospitals, user?.hospital_id])

  const currentHospitalId = currentHospital?.id ?? user?.hospital_id ?? null
  const currentHospitalName = currentHospital?.name || (currentHospitalId ? `Hospital ${currentHospitalId}` : 'Hospital Admin')

  const scopedCases = useMemo(() => {
    return hospitalCases.length > 0
      ? hospitalCases
      : cases.filter((item) => String(item.hospital_id) === String(currentHospitalId))
  }, [cases, currentHospitalId, hospitalCases])

  const archiveCases = useMemo(
    () => sortCasesByPriority(scopedCases.filter((item) => isWithinWindow(item.created_at, archiveWindow))),
    [archiveWindow, scopedCases],
  )

  const workflowGroups = useMemo(() => groupCasesByStatus(archiveCases), [archiveCases])
  const metrics = useMemo(() => summarizeCases(scopedCases), [scopedCases])
  const queue = useMemo(() => buildCaseQueue(scopedCases), [scopedCases])

  const incomingAlerts = queue.slice(0, 5)
  const latestCase = queue[0] || null

  const resourceSummary = [
    {
      label: 'Hospital ID',
      value: currentHospitalId ? String(currentHospitalId) : '—',
      helper: 'Signed-in account',
    },
    {
      label: 'Active cases',
      value: String(metrics.active),
      helper: loading ? 'Refreshing...' : 'Live from backend',
    },
    {
      label: 'Critical cases',
      value: String(metrics.critical),
      helper: 'P0 / P1 inbound',
    },
    {
      label: 'Average SLA',
      value: metrics.avgEta ? `${metrics.avgEta} min` : '—',
      helper: 'ETA across current cases',
    },
  ]

  const workflowStages = ['created', 'triaged', 'dispatched', 'arrived', 'resolved', 'alerts_sent', 'discharged']

  if (error) {
    return (
      <div className="page">
        <TopBar title="Hospital Dashboard" subtitle="Error loading data" />
        <div className="panel" style={{ gridColumn: 'span 3' }}>
          <p style={{ color: 'var(--danger)' }}>Error: {error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <TopBar
        title={currentHospitalName}
        subtitle={loading ? 'Loading...' : 'Incoming emergency dashboard'}
        actions={
          <>
            <button className="ghost" onClick={() => navigate('/chat')}>
              Open chat
            </button>
            <button className="ghost" onClick={() => Promise.all([refreshCases(), refreshHospitals()])}>
              Refresh cases
            </button>
            <button className="primary" onClick={() => navigate('/admin')}>
              Admin view
            </button>
          </>
        }
      />

      <section className="stats-grid">
        {resourceSummary.map((item) => (
          <StatCard key={item.label} label={item.label} value={item.value} helper={item.helper} />
        ))}
      </section>

      <section className="grid">
        <Panel title="Incoming alerts" className="cases" actions={<span className="chip">{incomingAlerts.length} live</span>}>
          {hospitalError ? <p className="muted">{hospitalError}</p> : null}
          {incomingAlerts.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>No incoming cases yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Status</th>
                  <th>Severity</th>
                  <th>ETA</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {incomingAlerts.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>#{item.id}</strong>
                      <div className="muted">{item.patient_name || 'Unknown patient'}</div>
                    </td>
                    <td>
                      <StatusPill text={item.status || 'created'} tone="dispatching" />
                    </td>
                    <td>
                      <span className={`severity ${String(item.severity || 'P2').toLowerCase()}`}>
                        {item.severity || 'P2'}
                      </span>
                    </td>
                    <td>{item.eta ? `${item.eta} min` : '—'}</td>
                    <td>{item.ageMinutes ? `${item.ageMinutes} min` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <ResourcePanel hospitalId={currentHospitalId} />

        <Panel title="Case status workflow" className="map">
          <div className="workflow-strip">
            {workflowStages.map((stage) => (
              <div key={stage} className="workflow-stage">
                <p className="metric-label">{stage.replace('_', ' ')}</p>
                <strong>{workflowGroups[stage]?.length || 0}</strong>
              </div>
            ))}
          </div>
          <div className="context-card" style={{ marginTop: '16px' }}>
            <p className="eyebrow">Current case lifecycle</p>
            <h4>{latestCase ? `Case ${latestCase.id}` : 'No active case'}</h4>
            <p className="muted">
              {latestCase
                ? `${latestCase.severity || 'P2'} · ${latestCase.status || 'created'} · ${latestCase.condition || 'No condition'}`
                : 'Create or refresh a case to see the workflow path.'}
            </p>
          </div>
          <MapPanel
            title="Hospital intake radar"
            subtitle={`${incomingAlerts.length} cases currently in the active queue`}
            tags={['SLA tracking', 'Resource health', 'Discharge review']}
          />
        </Panel>

        <Panel title="SLA tracking" className="timeline">
          <ul className="request-list">
            <li>
              <div>
                <strong>Average response age</strong>
                <span>{metrics.avgAge ? `${metrics.avgAge} minutes` : 'No timing data yet'}</span>
              </div>
              <StatusPill text={metrics.avgAge && metrics.avgAge < 30 ? 'Healthy' : 'Watch'} tone="active" />
            </li>
            <li>
              <div>
                <strong>Delayed cases</strong>
                <span>{metrics.delayed} flagged cases</span>
              </div>
              <StatusPill text={metrics.delayed ? 'Investigate' : 'Clear'} tone="dispatching" />
            </li>
            <li>
              <div>
                <strong>Resolved / discharged</strong>
                <span>{metrics.resolved} cases closed out</span>
              </div>
              <StatusPill text="Lifecycle" tone="active" />
            </li>
          </ul>
          <div className="button-row">
            <button className="ghost" onClick={() => navigate('/chat')}>
              Open discharge chat
            </button>
            <button className="primary" onClick={() => refreshCases()}>
              Refresh workflow
            </button>
          </div>
        </Panel>

        <Panel title="Case archive" className="cases">
          <div className="button-row archive-filters">
            {ARCHIVE_WINDOWS.map((item) => (
              <button
                key={item.key}
                className={archiveWindow === item.key ? 'chip active' : 'chip'}
                onClick={() => setArchiveWindow(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {archiveCases.length === 0 ? (
            <p style={{ color: 'var(--muted)' }}>No archived cases in this range.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Condition</th>
                  <th>Status</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {archiveCases.slice(0, 8).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>#{item.id}</strong>
                    </td>
                    <td>{item.condition || 'Unknown'}</td>
                    <td>
                      <StatusPill text={item.status || 'created'} tone="dispatching" />
                    </td>
                    <td>{getCaseAgeMinutes(item) ? `${getCaseAgeMinutes(item)} min` : formatTimeAgo(item.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Resource health dashboard" className="chat">
          <div className="mini-metrics" style={{ marginTop: 0 }}>
            <article>
              <strong>{currentHospital?.beds_available ?? '—'}</strong>
              <span>Beds available</span>
            </article>
            <article>
              <strong>{currentHospital?.icu_available ?? '—'}</strong>
              <span>ICU available</span>
            </article>
            <article>
              <strong>{currentHospital?.ventilators_available ?? '—'}</strong>
              <span>Ventilators available</span>
            </article>
          </div>
          <p className="muted" style={{ marginTop: '14px' }}>
            This panel is backed by <strong>/hospitals/resources/{String(currentHospitalId || 'id')}</strong> and updates from the same API used by the resource controls.
          </p>
        </Panel>
      </section>
    </div>
  )
}

export default HospitalDashboard