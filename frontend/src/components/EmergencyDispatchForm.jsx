import { useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import * as api from '../services/api.js'
import EmergencyDispatchResult from './EmergencyDispatchResult.jsx'

function EmergencyDispatchForm({ onDispatched }) {
  const [message, setMessage] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const location = useMemo(() => {
    const lat = String(latitude).trim()
    const lon = String(longitude).trim()
    return lat && lon ? `${lat},${lon}` : ''
  }, [latitude, longitude])

  const handleSubmit = async (event) => {
    event.preventDefault()

    if (!message.trim() || !latitude.trim() || !longitude.trim()) {
      setError('Please enter symptoms, latitude, and longitude.')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await api.dispatchEmergency({ message: message.trim(), location })
      const responseData = response?.data || response

      if (response?.success === false || responseData?.error_message) {
        throw new Error(response?.message || responseData?.error_message || 'Dispatch failed')
      }

      setResult(responseData)
      onDispatched?.(responseData)
      setMessage('')
      setLatitude('')
      setLongitude('')
    } catch (err) {
      setError(err.message || 'Dispatch failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <section className="dispatch-form-card">
        <div className="dispatch-form-head">
          <div>
            <p className="eyebrow">Emergency dispatch</p>
            <h2>Trigger a new emergency workflow</h2>
          </div>
          <span className="dispatch-form-hint">Backend: POST /emergency/dispatch</span>
        </div>

        {error ? <div className="dispatch-error">{error}</div> : null}

        <form className="dispatch-form" onSubmit={handleSubmit}>
          <label>
            Patient symptoms / message
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="e.g. chest pain, difficulty breathing, unconscious, severe bleeding"
              rows={4}
              disabled={loading}
            />
          </label>

          <div className="dispatch-location-grid">
            <label>
              Latitude
              <input
                type="number"
                step="0.0001"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="13.0827"
                disabled={loading}
              />
            </label>
            <label>
              Longitude
              <input
                type="number"
                step="0.0001"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="80.2707"
                disabled={loading}
              />
            </label>
          </div>

          <button type="submit" className="primary full" disabled={loading}>
            {loading ? 'Dispatching...' : 'Dispatch emergency'}
          </button>
        </form>
      </section>

      {result ? <EmergencyDispatchResult dispatchResult={result} onClose={() => setResult(null)} /> : null}
    </>
  )
}

EmergencyDispatchForm.propTypes = {
  onDispatched: PropTypes.func,
}

export default EmergencyDispatchForm
