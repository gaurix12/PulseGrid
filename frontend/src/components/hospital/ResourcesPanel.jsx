import { useEffect, useMemo, useState } from 'react'
import { getHospitalResources, updateHospitalResourceStatus } from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'

const RESOURCE_CARDS = [
  {
    key: 'beds',
    title: 'General Beds',
    resourceType: 'bed',
    resourceKey: 'beds',
  },
  {
    key: 'icu',
    title: 'ICU Beds',
    resourceType: 'icu',
    resourceKey: 'icu',
  },
  {
    key: 'ventilators',
    title: 'Ventilators',
    resourceType: 'ventilator',
    resourceKey: 'ventilators',
  },
]

const POLL_INTERVAL_MS = 5000

function normalizeResources(payload) {
  if (!payload) return null
  if (payload?.data && typeof payload.data === 'object') return payload.data
  return payload
}

function getUtilizationTone(available, total) {
  if (!total) return 'bg-emerald-500'
  const availablePercent = (available / total) * 100
  if (availablePercent > 30) return 'bg-emerald-500'
  if (availablePercent >= 10) return 'bg-amber-500'
  return 'bg-rose-500'
}

function formatCount(value) {
  return Number.isFinite(value) ? value : 0
}

function ResourcesPanel({ hospitalId }) {
  const pushToast = useUiStore((state) => state.pushToast)
  const [resources, setResources] = useState(null)
  const [loading, setLoading] = useState(true)
  const [updatingKey, setUpdatingKey] = useState(null)
  const [error, setError] = useState('')

  const loadResources = async ({ silent = false } = {}) => {
    if (!hospitalId) {
      setResources(null)
      setError('No hospital is assigned to this account yet.')
      setLoading(false)
      return
    }

    if (!silent) setLoading(true)

    try {
      const response = await getHospitalResources(hospitalId)
      setResources(normalizeResources(response))
      setError('')
    } catch (err) {
      const message = err.message || 'Failed to load hospital resources.'
      setError(message)
      pushToast({
        title: 'Resource load failed',
        description: message,
        tone: 'error',
      })
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    loadResources()

    const intervalId = window.setInterval(() => {
      loadResources({ silent: true })
    }, POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [hospitalId])

  const adjustResource = async (card, quantityChange) => {
    if (!hospitalId) return

    setUpdatingKey(card.key)
    setError('')

    try {
      await updateHospitalResourceStatus(hospitalId, {
        resource_type: card.resourceType,
        quantity_change: quantityChange,
      })
      await loadResources({ silent: true })
    } catch (err) {
      const message = err.message || 'Unable to update resource.'
      setError(message)
      pushToast({
        title: 'Resource update failed',
        description: message,
        tone: 'error',
      })
    } finally {
      setUpdatingKey(null)
    }
  }

  const cards = useMemo(() => {
    return RESOURCE_CARDS.map((card) => {
      const available = formatCount(Number(resources?.[`${card.resourceKey}_available`] ?? 0))
      const total = formatCount(Number(resources?.[`${card.resourceKey}_total`] ?? 0))
      const utilization = total > 0 ? Math.round(((total - available) / total) * 100) : 0
      const availablePercent = total > 0 ? Math.round((available / total) * 100) : 0

      return {
        ...card,
        available,
        total,
        utilization,
        availablePercent,
        toneClass: getUtilizationTone(available, total),
        isUpdating: updatingKey === card.key,
      }
    })
  }, [resources, updatingKey])

  if (loading && !resources) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
        <p className="text-sm font-semibold text-slate-500">Loading resources...</p>
      </section>
    )
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Resource Management</p>
          <h2 className="mt-2 text-xl font-black text-slate-900">Hospital resources</h2>
          <p className="mt-1 text-sm text-slate-500">Auto-refreshes every 5 seconds.</p>
        </div>
        <button
          type="button"
          onClick={() => loadResources()}
          className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {cards.map((card) => (
          <article key={card.key} className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-black tracking-tight text-slate-900">{card.title}</h3>
                <p className="mt-2 text-sm text-slate-600">
                  <span className="font-semibold text-slate-900">Available:</span> {card.available} / <span className="font-semibold text-slate-900">Total:</span> {card.total}
                </p>
              </div>
              <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 shadow-sm">
                {card.availablePercent}% available
              </span>
            </div>

            <div className="mt-4 h-3 overflow-hidden rounded-full bg-white">
              <div className={`h-full rounded-full ${card.toneClass}`} style={{ width: `${card.availablePercent}%` }} />
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={card.isUpdating || card.available <= 0}
                onClick={() => adjustResource(card, -1)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-2xl font-black text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`Decrease ${card.title}`}
              >
                {card.isUpdating ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" /> : '−'}
              </button>

              <div className="text-center">
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Utilization</p>
                <p className="mt-1 text-2xl font-black text-slate-900">{card.utilization}%</p>
              </div>

              <button
                type="button"
                disabled={card.isUpdating || card.available >= card.total}
                onClick={() => adjustResource(card, 1)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-2xl font-black text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`Increase ${card.title}`}
              >
                {card.isUpdating ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" /> : '+'}
              </button>
            </div>

            <div className="mt-4 text-sm text-slate-500">
              {card.isUpdating ? 'Updating...' : 'Click + to add availability or - to mark one unit in use.'}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

export default ResourcesPanel