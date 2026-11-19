import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as api from '../services/api.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useData } from '../context/DataContext.jsx'
import { createSocket } from '../services/socket.js'
import StatCard from '../components/StatCard.jsx'
import Panel from '../components/Panel.jsx'
import StatusPill from '../components/StatusPill.jsx'
import TopBar from '../components/TopBar.jsx'
import {
  buildCaseQueue,
  formatTimeAgo,
  h3GridDistance,
  parseCaseCoordinates,
  sortCasesByPriority,
} from '../utils/incidentInsights.js'

function describeDistance(gridDistance) {
  if (gridDistance == null) return 'Unknown distance'
  return `${gridDistance} H3 cells away`
}

function AmbulanceQuickAccess() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { cases, loading: dataLoading, refreshCases } = useData()
  const [ambulanceId, setAmbulanceId] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [currentCase, setCurrentCase] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [delayMins, setDelayMins] = useState('')
  const [delayMessage, setDelayMessage] = useState('')
  const [skippedCaseIds, setSkippedCaseIds] = useState([])
  const [statusHistory, setStatusHistory] = useState([])
  const [location, setLocation] = useState({ latitude: '', longitude: '' })
  const socketRef = useRef(null)

  const origin = useMemo(() => {
    const latitude = Number(location.latitude)
    const longitude = Number(location.longitude)
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude }
    }
    return null
  }, [location])

  const assignedCases = useMemo(() => {
    if (!ambulanceId) return []
    return sortCasesByPriority(
      cases.filter((item) => String(item.ambulance_id || '') === String(ambulanceId)),
      origin,
    )
  }, [ambulanceId, cases, origin])

  const recommendedQueue = useMemo(() => {
    return buildCaseQueue(
      cases.filter((item) => !skippedCaseIds.includes(String(item.id))),
      origin,
    ).filter((item) => item.status !== 'discharged' && item.status !== 'failed_escalation')
  }, [cases, origin, skippedCaseIds])

  const nearbyCases = useMemo(() => {
    return recommendedQueue
      .filter((item) => item.h3GridDistance == null || item.h3GridDistance <= 20)
      .slice(0, 5)
  }, [recommendedQueue])

  const activeCase = currentCase || assignedCases[0] || nearbyCases[0] || null

  const normalizeCase = (item, fallbackAmbulanceId) => ({
    ...item,
    hospital: item.hospital_name || (item.hospital_id ? `Hospital ${item.hospital_id}` : '—'),
    ambulance:
      item.driver_name ||
      (item.ambulance_id || fallbackAmbulanceId ? `Ambulance ${item.ambulance_id || fallbackAmbulanceId}` : '—'),
  })

  const pushHistory = (entry) => {
    setStatusHistory((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ...entry,
      },
      ...prev,
    ].slice(0, 8))
  }

  useEffect(() => {
    if (user?.role === 'ambulance' && user?.ambulance_id) {
      const ambId = String(user.ambulance_id)
      setAmbulanceId(ambId)
      setIsAuthenticated(true)
      setLoading(true)

      api
        .getAssignedCases(ambId)
        .then((assigned) => {
          const nextCase = Array.isArray(assigned) && assigned.length > 0 ? normalizeCase(assigned[0], ambId) : null
          setCurrentCase(nextCase)
          if (nextCase) {
            pushHistory({ label: 'Loaded assigned case', detail: `Case ${nextCase.id}` })
          }
        })
        .catch(() => {
          setCurrentCase({
            id: `${ambId}-DEMO`,
            status: 'Dispatched',
            severity: 'P0',
            location: 'Demo location',
            hospital: 'Demo hospital',
            eta: '6 min',
          })
        })
        .finally(() => {
          setLoading(false)
        })
    }
  }, [user])

  useEffect(() => {
    if (!isAuthenticated) return

    const socket = createSocket()
    socketRef.current = socket

    socket.on('response', (payload) => {
      if (!payload?.success) return
      if (payload?.ambulance) {
        setCurrentCase((prev) => ({
          ...prev,
          ambulance_id: payload.ambulance.id,
        }))
      }
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [isAuthenticated])

  const syncLocation = async (latitude, longitude) => {
    if (!ambulanceId) return
    await api.updateAmbulanceLocation(ambulanceId, latitude, longitude)
    socketRef.current?.emit('update_ambulance', {
      ambulance_id: ambulanceId,
      current_latitude: latitude,
      current_longitude: longitude,
      current_case_id: currentCase?.id || null,
    })
    pushHistory({ label: 'Location synced', detail: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}` })
  }

  const handleAccessClick = async () => {
    if (!ambulanceId.trim()) return
    setLoading(true)
    setError('')

    try {
      const assigned = await api.getAssignedCases(ambulanceId)
      setIsAuthenticated(true)
      const nextCase = Array.isArray(assigned) && assigned.length > 0 ? normalizeCase(assigned[0], ambulanceId) : null
      setCurrentCase(nextCase)
      if (nextCase) {
        pushHistory({ label: 'Access granted', detail: `Case ${nextCase.id}` })
      }
    } catch {
      setIsAuthenticated(true)
      setCurrentCase({
        id: `${ambulanceId}-DEMO`,
        status: 'Dispatched',
        severity: 'P0',
        location: 'Demo location',
        hospital: 'Demo hospital',
        eta: '6 min',
      })
      pushHistory({ label: 'Demo access enabled', detail: `Ambulance ${ambulanceId}` })
    } finally {
      setLoading(false)
    }
  }

  const handleStatusUpdate = async (status) => {
    if (!activeCase) return
    setLoading(true)

    const statusMap = {
      Dispatched: 'en_route',
      'Picked Up': 'en_route',
      'En Route': 'en_route',
      Arrived: 'at_hospital',
      Idle: 'idle',
    }

    const normalizedStatus = statusMap[status] || 'en_route'

    try {
      await api.updateAmbulanceStatus(ambulanceId, normalizedStatus)
      socketRef.current?.emit('update_ambulance', {
        ambulance_id: ambulanceId,
        status: normalizedStatus,
        current_case_id: activeCase.id,
      })
      setCurrentCase((prev) => ({ ...prev, status }))
      pushHistory({ label: 'Status updated', detail: `${status} · Case ${activeCase.id}` })
      await refreshCases()
    } catch (err) {
      setError(err.message || 'Failed to update status.')
    } finally {
      setLoading(false)
    }
  }

  const handleAcceptCase = async (caseItem) => {
    if (!caseItem) return
    setCurrentCase(caseItem)
    await handleStatusUpdate('En Route')
  }

  const handleSkipCase = (caseId) => {
    setSkippedCaseIds((prev) => [...prev, String(caseId)])
    pushHistory({ label: 'Case skipped', detail: `Case ${caseId} removed from the preview queue` })
  }

  const handleDelaySubmit = async () => {
    if (!delayMins || !activeCase) return
    setLoading(true)
    try {
      await api.updateCaseStatus(activeCase.id, `Delayed by ${delayMins} minutes`)
      setDelayMessage(`Delay noted: ${delayMins} minutes. Dispatch and hospital updated.`)
      pushHistory({ label: 'Delay note sent', detail: `${delayMins} minutes for case ${activeCase.id}` })
      setTimeout(() => setDelayMessage(''), 3000)
      await refreshCases()
    } catch (err) {
      setError(err.message || 'Failed to send delay note.')
    } finally {
      setLoading(false)
    }
  }

  const handleUseDeviceLocation = () => {
    if (!navigator.geolocation) {
      setError('This browser does not support geolocation.')
      return
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const nextLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }
        setLocation({
          latitude: String(nextLocation.latitude),
          longitude: String(nextLocation.longitude),
        })
        try {
          await syncLocation(nextLocation.latitude, nextLocation.longitude)
        } catch (err) {
          setError(err.message || 'Failed to sync current location.')
        }
      },
      () => setError('Unable to read current location.'),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  const activeCaseCoords = parseCaseCoordinates(activeCase)
  const etaEstimate =
    origin && activeCaseCoords
      ? Math.max(3, (h3GridDistance(origin, activeCaseCoords) || 0) * 4)
      : null

  const stats = [
    { label: 'Assigned case', value: activeCase?.id ? String(activeCase.id) : '—', helper: activeCase?.severity || 'Priority view' },
    { label: 'Nearby cases', value: String(nearbyCases.length), helper: dataLoading ? 'Refreshing...' : 'Sorted by distance' },
    { label: 'ETA estimate', value: etaEstimate ? `${etaEstimate} min` : '—', helper: activeCase?.location || 'Needs coordinates' },
    { label: 'Live location', value: origin ? 'Synced' : 'Pending', helper: origin ? `${origin.latitude.toFixed(4)}, ${origin.longitude.toFixed(4)}` : 'Use GPS or manual entry' },
  ]

  if (!isAuthenticated) {
    return (
      <div className="login">
        <div className="login-card">
          <div className="brand">
            <div className="pulse" />
            <div>
              <p className="eyebrow">Driver Access</p>
              <h1>Scan Ambulance ID</h1>
              <p className="subtitle">Quick access to your current case, nearby recommendations, and live location sync.</p>
            </div>
          </div>
          <form
            className="login-actions"
            onSubmit={(event) => {
              event.preventDefault()
              handleAccessClick()
            }}
          >
            <label>
              Ambulance ID
              <input
                type="text"
                placeholder="e.g., 1"
                value={ambulanceId}
                onChange={(event) => setAmbulanceId(event.target.value)}
                disabled={loading}
                autoFocus
              />
            </label>
            {error ? <p style={{ color: 'var(--danger)', fontSize: '12px' }}>{error}</p> : null}
            <button type="submit" className="primary full" disabled={loading}>
              {loading ? 'Accessing...' : 'Access case'}
            </button>
            <button type="button" className="ghost full" onClick={() => navigate('/login')} disabled={loading}>
              Back to login
            </button>
            <button type="button" className="ghost full" onClick={() => navigate('/chat')} disabled={loading}>
              Open chat
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="page ambulance-page">
      <TopBar
        title={`Ambulance Unit ${ambulanceId || user?.ambulance_id || '—'}`}
        subtitle="Geo-based recommendation, acceptance flow, and live dispatch sync"
        actions={
          <>
            <button className="ghost" onClick={handleUseDeviceLocation}>
              Use GPS
            </button>
            <button className="ghost" onClick={() => navigate('/chat')}>
              Open chat
            </button>
            <button className="primary" onClick={() => handleStatusUpdate('Arrived')}>
              Mark arrived
            </button>
          </>
        }
      />

      <section className="stats-grid">
        {stats.map((item) => (
          <StatCard key={item.label} label={item.label} value={item.value} helper={item.helper} />
        ))}
      </section>

      <section className="grid">
        <Panel title="Active case" className="cases">
          {activeCase ? (
            <div className="active-case">
              <div>
                <h4>{activeCase.patient_name || activeCase.id}</h4>
                <p className="muted">{activeCase.location || 'Location pending'}</p>
                <div className="pill-row">
                  <span className={`severity ${(activeCase.severity || 'P2').toLowerCase()}`}>
                    {activeCase.severity || 'P2'}
                  </span>
                  <span className="pill">Hospital: {activeCase.hospital || activeCase.hospital_id || 'TBD'}</span>
                </div>
              </div>

              <div className="status-controls">
                <p className="metric-label">Update status</p>
                <div className="status-buttons">
                  {['Dispatched', 'Picked Up', 'En Route', 'Arrived', 'Idle'].map((status) => (
                    <button key={status} className="chip" onClick={() => handleStatusUpdate(status)} disabled={loading}>
                      {status}
                    </button>
                  ))}
                </div>

                <div className="delay-section">
                  <label>
                    Delayed by (minutes)
                    <input
                      type="number"
                      placeholder="e.g., 5"
                      value={delayMins}
                      onChange={(event) => setDelayMins(event.target.value)}
                      disabled={loading}
                    />
                  </label>
                  <button className="primary full" onClick={handleDelaySubmit} disabled={loading}>
                    {loading ? 'Sending...' : 'Send delay note'}
                  </button>
                  {delayMessage ? <p className="success-message">{delayMessage}</p> : null}
                  {error ? <p style={{ color: 'var(--danger)', fontSize: '12px' }}>{error}</p> : null}
                </div>
              </div>
            </div>
          ) : (
            <p className="muted">No assigned case yet. Check the nearby queue for the next pickup.</p>
          )}
        </Panel>

        <Panel title="Navigation brief" className="timeline">
          <ul className="request-list">
            <li>
              <div>
                <strong>Current location</strong>
                <span>{origin ? `${origin.latitude.toFixed(4)}, ${origin.longitude.toFixed(4)}` : 'Not synced'}</span>
              </div>
              <StatusPill text={origin ? 'Synced' : 'Pending'} tone={origin ? 'active' : 'dispatching'} />
            </li>
            <li>
              <div>
                <strong>Destination</strong>
                <span>{activeCase?.location || 'No destination selected'}</span>
              </div>
              <StatusPill text={describeDistance(etaEstimate ? etaEstimate / 2.4 : null)} tone="dispatching" />
            </li>
            <li>
              <div>
                <strong>Directions link</strong>
                <span>Open the route in your map app</span>
              </div>
              <a
                className="chip"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(activeCase?.location || '')}`}
                target="_blank"
                rel="noreferrer"
              >
                Open map
              </a>
            </li>
          </ul>
          <div className="button-row">
            <button className="ghost" onClick={handleUseDeviceLocation}>
              Refresh GPS
            </button>
            <button
              className="primary"
              onClick={async () => {
                if (!origin) return
                try {
                  await syncLocation(origin.latitude, origin.longitude)
                } catch (err) {
                  setError(err.message || 'Failed to sync location.')
                }
              }}
              disabled={!origin}
            >
              Sync location
            </button>
          </div>
        </Panel>

        <Panel title="Nearby case queue" className="map">
          {nearbyCases.length === 0 ? (
            <p className="muted">No nearby cases found.</p>
          ) : (
            <ul className="request-list">
              {nearbyCases.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>Case {item.id}</strong>
                    <span>
                      {item.severity || 'P2'} · {item.h3GridDistance != null ? describeDistance(item.h3GridDistance) : 'Location pending'}
                    </span>
                  </div>
                  <div className="button-row" style={{ gap: '8px' }}>
                    <button className="chip" onClick={() => handleAcceptCase(item)} disabled={loading}>
                      Accept
                    </button>
                    <button className="chip" onClick={() => handleSkipCase(item.id)}>
                      Skip
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Nearby hospital options" className="form">
          {activeCase ? (
            <ul className="request-list">
              {sortCasesByPriority(cases.filter((item) => item.hospital_id), origin)
                .slice(0, 5)
                .map((item) => (
                  <li key={`${item.id}-${item.hospital_id}`}>
                    <div>
                      <strong>Hospital {item.hospital_id}</strong>
                      <span>
                        {item.eta ? `${item.eta} min ETA` : 'Resource match'} · Case {item.id}
                      </span>
                    </div>
                    <StatusPill text={item.status || 'active'} tone="active" />
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">Choose a case to see route-friendly hospital options.</p>
          )}
        </Panel>

        <Panel title="Status history" className="chat">
          <ul className="request-list">
            {statusHistory.length === 0 ? (
              <li>
                <div>
                  <strong>No updates yet</strong>
                  <span>Accepted cases, status changes, and location syncs appear here.</span>
                </div>
              </li>
            ) : (
              statusHistory.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <StatusPill text={item.time} tone="dispatching" />
                </li>
              ))
            )}
          </ul>
        </Panel>

        <Panel title="Quick actions" className="cases">
          <div className="actions-list">
            <button className="action-btn" onClick={() => handleStatusUpdate('En Route')}>
              <span>🚑</span> Accept / go en route
            </button>
            <button className="action-btn" onClick={() => handleStatusUpdate('Arrived')}>
              <span>🏥</span> Mark arrived
            </button>
            <button className="action-btn" onClick={() => handleUseDeviceLocation()}>
              <span>📍</span> Sync GPS
            </button>
            <button className="action-btn" onClick={() => navigate('/chat')}>
              <span>💬</span> Open dispatch chat
            </button>
          </div>
        </Panel>
      </section>
    </div>
  )
}

export default AmbulanceQuickAccess