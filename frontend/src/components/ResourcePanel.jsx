import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { getHospitalResources, updateHospitalResources } from '../services/api.js'

const RESOURCE_TYPES = [
  { key: 'beds', label: 'General Beds', resourceType: 'bed', color: '#3b82f6' },
  { key: 'icu', label: 'ICU Beds', resourceType: 'icu', color: '#f59e0b' },
  { key: 'ventilators', label: 'Ventilators', resourceType: 'ventilator', color: '#ef4444' },
]

function normalizeResourcePayload(payload) {
  if (!payload) {
    return null
  }

  if (payload.data && typeof payload.data === 'object') {
    return payload.data
  }

  return payload
}

function ResourcePanel({ hospitalId }) {
  const [resources, setResources] = useState(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(null)
  const [error, setError] = useState('')

  const fetchResources = async () => {
    if (!hospitalId) {
      setResources(null)
      setLoading(false)
      setError('No hospital is assigned to this account yet.')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await getHospitalResources(hospitalId)
      if (response?.success === false) {
        setResources(null)
        setError(response.error || response.message || 'Failed to load resources')
        return
      }

      setResources(normalizeResourcePayload(response))
    } catch (err) {
      setResources(null)
      setError(err.message || 'Failed to load resources')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchResources()
  }, [hospitalId])

  const handleAdjust = async (resourceType, delta) => {
    if (!hospitalId) {
      setError('No hospital is assigned to this account yet.')
      return
    }

    setUpdating(resourceType)
    setError('')

    try {
      const response = await updateHospitalResources(hospitalId, resourceType, delta)
      if (response?.success === false) {
        setError(response.error || response.message || 'Update failed')
        return
      }

      await fetchResources()
    } catch (err) {
      setError(err.message || 'Update failed')
    } finally {
      setUpdating(null)
    }
  }

  const handleRefresh = async () => {
    await fetchResources()
  }

  if (loading && !resources) {
    return (
      <section className="panel resource-panel resource-panel-loading">
        <div className="resource-panel-state">Loading hospital resources...</div>
      </section>
    )
  }

  if (!resources) {
    return (
      <section className="panel resource-panel resource-panel-error">
        <div className="resource-panel-state">Unable to load hospital resources.</div>
      </section>
    )
  }

  return (
    <section className="panel resource-panel">
      <div className="resource-panel-header">
        <div>
          <p className="resource-panel-kicker">Hospital resources</p>
          <h3>Bed, ICU, and ventilator availability</h3>
        </div>
        <button className="refresh-btn" type="button" onClick={handleRefresh} aria-label="Refresh hospital resources">
          ↻
        </button>
      </div>

      {error ? (
        <div className="resource-error">
          <span>⚠ {error}</span>
          <button type="button" className="close-error" onClick={() => setError('')} aria-label="Dismiss error">
            ×
          </button>
        </div>
      ) : null}

      <div className="resource-grid">
        {RESOURCE_TYPES.map(({ key, label, resourceType, color }) => {
          const available = Number(resources[`${key}_available`] || 0)
          const total = Number(resources[`${key}_total`] || 0)
          const percent = total > 0 ? Math.round((available / total) * 100) : 0
          const isUpdating = updating === resourceType

          return (
            <article className="resource-card" key={key}>
              <div className="resource-card-header">
                <h4>{label}</h4>
                <span className="utilization-percent">{percent}% available</span>
              </div>

              <div className="resource-bar" aria-hidden="true">
                <div
                  className="resource-bar-fill"
                  style={{ width: `${percent}%`, backgroundColor: color }}
                />
              </div>

              <div className="resource-count">
                <span className="count-value count-available">{available}</span>
                <span className="count-separator">/</span>
                <span className="count-value count-total">{total}</span>
              </div>

              <div className="resource-controls">
                <button
                  type="button"
                  className="delta-btn delta-minus"
                  onClick={() => handleAdjust(resourceType, -1)}
                  disabled={isUpdating || available <= 0}
                  title={available <= 0 ? 'No available capacity to remove' : 'Mark one unit as in use'}
                >
                  -
                </button>
                <button
                  type="button"
                  className="delta-btn delta-plus"
                  onClick={() => handleAdjust(resourceType, 1)}
                  disabled={isUpdating || available >= total}
                  title={available >= total ? 'Already at capacity' : 'Mark one unit as available'}
                >
                  +
                </button>
              </div>

              {isUpdating ? (
                <div className="resource-updating">
                  <span className="spinner-small" />
                  Updating...
                </div>
              ) : null}
            </article>
          )
        })}
      </div>

      <div className="resource-note">
        <p>
          Use <strong>+</strong> when beds or equipment come back online, and <strong>-</strong> when they are in use.
        </p>
      </div>
    </section>
  )
}

ResourcePanel.propTypes = {
  hospitalId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
}

export default ResourcePanel