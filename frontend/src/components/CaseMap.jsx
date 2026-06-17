import { useEffect, useMemo, useState } from 'react'
import * as api from '../services/api.js'
import { parseCaseCoordinates, sortCasesByPriority } from '../utils/incidentInsights.js'

const REFRESH_MS = 5000

const severityConfig = {
  P0: { label: 'Critical', color: '#ef4444' },
  P1: { label: 'High', color: '#f97316' },
  P2: { label: 'Medium', color: '#eab308' },
  P3: { label: 'Low', color: '#22c55e' },
}

function normalizeCases(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.cases)) return payload.cases
  return []
}

function hashToPosition(text) {
  const value = String(text || '')
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return {
    x: 12 + (hash % 76),
    y: 12 + ((hash >> 8) % 76),
  }
}

function CaseMap() {
  const [cases, setCases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true

    const fetchCases = async () => {
      try {
        const response = await api.getAllCases()
        const nextCases = normalizeCases(response)
        if (mounted) {
          setCases(nextCases)
          setError('')
          setLoading(false)
        }
      } catch (err) {
        if (mounted) {
          setError(err.message || 'Failed to load cases')
          setLoading(false)
        }
      }
    }

    fetchCases()
    const interval = setInterval(fetchCases, REFRESH_MS)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  const markers = useMemo(() => {
    return sortCasesByPriority(cases)
      .map((incidentCase) => {
        const coordinates = parseCaseCoordinates(incidentCase)
        const position = coordinates
          ? { x: 12 + ((coordinates.longitude + 180) / 360) * 76, y: 12 + ((90 - coordinates.latitude) / 180) * 76 }
          : hashToPosition(incidentCase.location || incidentCase.patient_name || incidentCase.id)

        const severity = incidentCase.severity || 'P3'
        const config = severityConfig[severity] || severityConfig.P3

        return {
          case: incidentCase,
          position,
          severity,
          label: config.label,
          color: config.color,
        }
      })
      .filter(Boolean)
  }, [cases])

  const severityCounts = useMemo(() => {
    return cases.reduce(
      (acc, incidentCase) => {
        const severity = incidentCase.severity || 'P3'
        acc[severity] = (acc[severity] || 0) + 1
        return acc
      },
      { P0: 0, P1: 0, P2: 0, P3: 0 },
    )
  }, [cases])

  if (loading) {
    return <div className="case-map-state">Loading live case map...</div>
  }

  if (error) {
    return <div className="case-map-state error">Error loading map: {error}</div>
  }

  return (
    <div className="case-map-shell">
      <div className="case-map-head">
        <div>
          <p className="eyebrow">Live map</p>
          <h2>Emergency cases across Chennai</h2>
        </div>
        <div className="case-map-legend">
          {Object.entries(severityConfig).map(([severity, config]) => (
            <span key={severity} className="case-map-legend-item">
              <i style={{ backgroundColor: config.color }} />
              {severity} · {severityCounts[severity] || 0}
            </span>
          ))}
        </div>
      </div>

      <div className="case-map-card">
        <div className="case-map-canvas">
          <div className="case-map-grid" aria-hidden="true" />
          {markers.map(({ case: incidentCase, position, severity, label, color }) => (
            <button
              key={incidentCase.id}
              type="button"
              className="case-map-marker-button"
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
              title={`Case ${incidentCase.id}`}
            >
              <div className="case-map-marker" style={{ background: color }}>
                <span>{severity}</span>
              </div>
              <div className="case-map-popup">
                <div className="case-map-popup-body">
                  <div className="case-map-popup-head">
                    <strong>Case #{incidentCase.id}</strong>
                    <span className={`case-map-severity ${severity.toLowerCase()}`} style={{ backgroundColor: color }}>
                      {severity} · {label}
                    </span>
                  </div>
                  <p><span>Patient:</span> {incidentCase.patient_name || 'Unknown'}</p>
                  <p><span>Condition:</span> {incidentCase.condition || 'Unspecified'}</p>
                  <p><span>Ambulance:</span> {incidentCase.ambulance_id ?? 'Pending'}</p>
                  <p><span>Hospital:</span> {incidentCase.hospital_id ?? 'Pending'}</p>
                  <p><span>ETA:</span> {incidentCase.eta ?? 'N/A'}</p>
                  <p><span>Status:</span> {incidentCase.delay ? 'Delayed' : 'On time'}</p>
                  <p className="case-map-popup-meta">{incidentCase.created_at || 'No timestamp'}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {markers.length === 0 ? (
        <div className="case-map-empty">
          No geocoded cases yet. Dispatch an emergency with a lat/lon location to place markers.
        </div>
      ) : null}
    </div>
  )
}

export default CaseMap
