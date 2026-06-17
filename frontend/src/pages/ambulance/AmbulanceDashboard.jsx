import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import PropTypes from 'prop-types'
import { useAuth } from '../../context/AuthContext.jsx'
import * as api from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'
import { haversineKm, parseCaseCoordinates, sortCasesByPriority } from '../../utils/incidentInsights.js'
import ChatAssistant from '../../components/shared/ChatAssistant.jsx'
import { POLLING } from '../../constants/polling.js'

// P4.1 – Use centralised polling constant (was 3000 hardcoded)
const REFRESH_MS = POLLING.AMBULANCE_CASES

const STATUS_OPTIONS = [
  { label: 'Idle', value: 'idle' },
  { label: 'En-Route', value: 'en_route' },
  { label: 'On-Scene', value: 'on_scene' },
  { label: 'Transporting', value: 'transporting' },
  { label: 'Delivered', value: 'delivered' },
]

const WORKFLOW_STEPS = [
  { label: 'Dispatch', status: 'idle' },
  { label: 'En-Route', status: 'en_route' },
  { label: 'On-Scene', status: 'on_scene' },
  { label: 'Transporting', status: 'transporting' },
  { label: 'Hospital', status: 'arrived' },
  { label: 'Delivered', status: 'delivered' },
]

function safeString(value) {
  if (value == null || value === '') return '—'
  return String(value)
}

function normalizeSeverity(value) {
  const severity = safeString(value).toUpperCase()
  return ['P0', 'P1', 'P2', 'P3'].includes(severity) ? severity : 'P3'
}

function normalizeStatus(value) {
  return safeString(value).toLowerCase().replace(/\s+/g, '_')
}

function toBackendAmbulanceStatus(value) {
  switch (normalizeStatus(value)) {
    case 'idle':
      return 'idle'
    case 'delivered':
      return 'delivered'
    case 'on_scene':
      return 'on_scene'
    case 'transporting':
      return 'transporting'
    case 'en_route':
    case 'on-route':
    case 'on_route':
      return 'en_route'
    case 'hospital':
    case 'at_hospital':
      return 'at_hospital'
    default:
      return 'en_route'
  }
}

function displayStatusFromBackend(status) {
  switch (normalizeStatus(status)) {
    case 'idle':
      return 'Idle'
    case 'en_route':
      return 'En-Route'
    case 'on_scene':
      return 'On-Scene'
    case 'transporting':
      return 'Transporting'
    case 'at_hospital':
    case 'arrived':
      return 'Hospital'
    case 'delivered':
      return 'Delivered'
    default:
      return 'Idle'
  }
}

function formatKm(distanceKm) {
  if (distanceKm == null || Number.isNaN(distanceKm)) return '—'
  if (distanceKm < 1) return `${Math.round(distanceKm * 1000)} m`
  return `${distanceKm.toFixed(1)} km`
}

function formatTravelMinutes(distanceKm) {
  if (distanceKm == null || Number.isNaN(distanceKm)) return '—'
  return `${Math.max(1, Math.round(distanceKm * 3.5))} min`
}

function getCaseId(item) {
  return item?.id ?? item?.case_id ?? item?.caseId ?? item?._id ?? ''
}

function getPatientName(item) {
  return item?.patient_name || item?.patientName || item?.name || item?.full_name || `Patient ${getCaseId(item) || ''}`.trim()
}

function getCondition(item) {
  return item?.condition || item?.medical_condition || item?.description || '—'
}

function getCaseCoordinates(item) {
  return parseCaseCoordinates(item)
}

function getScoreBySeverity(severity) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[normalizeSeverity(severity)] ?? 3
}

function getSeverityTone(severity) {
  switch (normalizeSeverity(severity)) {
    case 'P0':
      return 'border-rose-200 bg-rose-100 text-rose-800'
    case 'P1':
      return 'border-orange-200 bg-orange-100 text-orange-800'
    case 'P2':
      return 'border-amber-200 bg-amber-100 text-amber-800'
    default:
      return 'border-emerald-200 bg-emerald-100 text-emerald-800'
  }
}

function getStatusTone(status) {
  switch (normalizeStatus(status)) {
    case 'idle':
      return 'border-slate-200 bg-slate-100 text-slate-700'
    case 'en_route':
      return 'border-sky-200 bg-sky-100 text-sky-700'
    case 'on_scene':
      return 'border-violet-200 bg-violet-100 text-violet-700'
    case 'transporting':
      return 'border-amber-200 bg-amber-100 text-amber-800'
    case 'delivered':
      return 'border-emerald-200 bg-emerald-100 text-emerald-700'
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700'
  }
}

function calculateDistanceKm(from, to) {
  if (!from || !to) return null
  return haversineKm(from, to)
}

function AmbulanceDashboard() {
  const { currentUser } = useAuth()
  const routeLocation = useLocation()
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (routeLocation.hash) {
      const element = document.getElementById(routeLocation.hash.slice(1))
      if (element) {
        setTimeout(() => {
          element.scrollIntoView({ behavior: 'smooth' })
        }, 100)
      }
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [routeLocation])
  const ambulanceId = currentUser?.ambulance_id ?? currentUser?.ambulanceId ?? currentUser?.id

  const [assignedCase, setAssignedCase] = useState(null)
  const [historyCases, setHistoryCases] = useState([])
  const [allCases, setAllCases] = useState([])
  const [currentStatus, setCurrentStatus] = useState('idle')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [location, setLocation] = useState({ latitude: '', longitude: '' })
  const [locationModalOpen, setLocationModalOpen] = useState(false)
  const [callDialogOpen, setCallDialogOpen] = useState(false)
  const [workflowStatus, setWorkflowStatus] = useState('idle')
  const [hospitals, setHospitals] = useState([])
  const autoRefreshRef = useRef(null)

  const ambulanceLocation = useMemo(() => {
    const latitude = Number(location.latitude)
    const longitude = Number(location.longitude)
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude }
    return null
  }, [location])

  const loadData = async ({ silent = false } = {}) => {
    if (!ambulanceId) return
    if (!silent) setLoading(true)
    else setRefreshing(true)

    try {
      const [assignedResponse, casesResponse, ambulanceProfileResponse] = await Promise.all([
        api.getAssignedCases(ambulanceId),
        api.getAllCases(),
        api.getAmbulance(ambulanceId),
      ])
      const hospitalResponse = await api.getHospitals().catch(() => [])

      const assigned = Array.isArray(assignedResponse) ? assignedResponse : []
      const safeCases = Array.isArray(casesResponse) ? casesResponse : []
      const safeHospitals = Array.isArray(hospitalResponse) ? hospitalResponse : []
      const ambProfile = ambulanceProfileResponse?.data || (ambulanceProfileResponse?.success === false ? null : ambulanceProfileResponse)
      
      setAllCases(safeCases)
      setHospitals(safeHospitals)

      const activeCaseId = ambProfile ? ambProfile.current_case_id : null
      let active = null
      let history = []

      if (activeCaseId) {
        active = assigned.find((c) => Number(getCaseId(c)) === Number(activeCaseId)) || null
        if (active && ['discharged', 'failed', 'failed_escalation', 'resolved'].includes(normalizeStatus(active.status))) {
          active = null
        }
      }

      history = assigned.filter((c) => {
        const isNotActive = active ? Number(getCaseId(c)) !== Number(getCaseId(active)) : true
        const isCompleted = ['arrived', 'resolved', 'discharged'].includes(normalizeStatus(c.status))
        return isNotActive && isCompleted
      })

      setAssignedCase(active)
      setHistoryCases(history)

      const ambStatus = ambProfile ? ambProfile.status : 'idle'
      const backendStatus = normalizeStatus(ambStatus)
      setCurrentStatus(backendStatus)
      setWorkflowStatus(displayStatusFromBackend(backendStatus))
    } catch (error) {
      pushToast({ title: 'Ambulance data unavailable', description: error.message, tone: 'error' })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadData()

    autoRefreshRef.current = window.setInterval(() => {
      loadData({ silent: true })
    }, REFRESH_MS)

    return () => {
      if (autoRefreshRef.current) {
        window.clearInterval(autoRefreshRef.current)
      }
    }
  }, [ambulanceId])

  useEffect(() => {
    if (!ambulanceLocation) return
  }, [ambulanceLocation])

  const activeCaseLocation = useMemo(() => getCaseCoordinates(assignedCase), [assignedCase])
  const activeHospitalLocation = useMemo(() => {
    if (!assignedCase?.hospital?.latitude || !assignedCase?.hospital?.longitude) return null
    return {
      latitude: Number(assignedCase.hospital.latitude),
      longitude: Number(assignedCase.hospital.longitude),
    }
  }, [assignedCase])

  const distanceToCase = useMemo(() => calculateDistanceKm(ambulanceLocation, activeCaseLocation), [ambulanceLocation, activeCaseLocation])
  const distanceToHospital = useMemo(() => calculateDistanceKm(activeCaseLocation, activeHospitalLocation), [activeCaseLocation, activeHospitalLocation])

  const currentCase = assignedCase || null
  const headerDistance = distanceToCase != null ? formatKm(distanceToCase) : '—'
  const selectedWorkflowLabel = workflowStatus || displayStatusFromBackend(currentStatus)

  const updateStatus = async (nextStatus) => {
    if (!ambulanceId || !nextStatus || nextStatus === currentStatus) return
    setSaving(true)
    try {
      const backendStatus = toBackendAmbulanceStatus(nextStatus)
      await api.updateAmbulanceStatus(ambulanceId, backendStatus)
      setCurrentStatus(backendStatus)
      setWorkflowStatus(nextStatus)
      pushToast({ title: 'Status updated', description: `Ambulance status set to ${nextStatus}.`, tone: 'success' })
      await loadData({ silent: true })
    } catch (error) {
      pushToast({ title: 'Status update failed', description: error.message, tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const updateLocation = async (latitude, longitude) => {
    if (!ambulanceId) return
    const lat = Number(latitude)
    const lon = Number(longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return

    setSaving(true)
    try {
      await api.updateAmbulanceLocation(ambulanceId, lat, lon)
      setLocation({ latitude: String(lat), longitude: String(lon) })
      pushToast({ title: 'Location updated', description: `Now at ${lat.toFixed(5)}, ${lon.toFixed(5)}.`, tone: 'success' })
      await loadData({ silent: true })
    } catch (error) {
      pushToast({ title: 'Location update failed', description: error.message, tone: 'error' })
    } finally {
      setSaving(false)
      setLocationModalOpen(false)
    }
  }

  const useDeviceLocation = () => {
    if (!navigator.geolocation) {
      pushToast({ title: 'GPS unavailable', description: 'This browser does not support location access.', tone: 'error' })
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        updateLocation(position.coords.latitude, position.coords.longitude)
      },
      (error) => {
        pushToast({ title: 'GPS denied', description: error.message || 'Unable to get your location.', tone: 'error' })
      },
      { enableHighAccuracy: true, timeout: 6000 },
    )
  }

  const rejectCase = () => {
    pushToast({ 
      title: 'Reassignment requested', 
      description: 'Please contact the AI Dispatcher or Coordinator to request case reassignment.', 
      tone: 'warning' 
    })
  }

  const callHospital = () => {
    const hospital = currentHospital
    const number = hospital?.phone || hospital?.contact_number || hospital?.contact || 'Hospital contact unavailable'
    setCallDialogOpen(true)
    pushToast({ title: 'Hospital contact', description: safeString(number), tone: 'info', timeout: 3500 })
  }

  const currentHospital = useMemo(() => {
    if (!currentCase?.hospital_id) return null
    return hospitals.find((item) => String(item.id) === String(currentCase.hospital_id)) || {
      id: currentCase.hospital_id,
      name: `Hospital ${currentCase.hospital_id}`,
      location: 'Location unavailable',
    }
  }, [currentCase, hospitals])

  return (
    <div className="space-y-5 pb-8">
      <section className="rounded-[2rem] border border-slate-200 bg-slate-950 p-5 text-white shadow-soft">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-300">Ambulance Dashboard</p>
              <h1 className="mt-2 text-3xl font-black tracking-tight">Driver console</h1>
            </div>
            <button type="button" className="rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-sm font-bold text-white" onClick={() => loadData()}>
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <StatusChip label="My Status" value={workflowStatus || STATUS_OPTIONS.find((item) => item.value === currentStatus)?.label || 'Idle'} />
            <StatusChip
              label="Current Location"
              value={ambulanceLocation ? `${ambulanceLocation.latitude.toFixed(5)}, ${ambulanceLocation.longitude.toFixed(5)}` : 'Not set'}
            />
            <StatusChip label="Current Case" value={currentCase ? `#${getCaseId(currentCase)} · ${getPatientName(currentCase)} · ${headerDistance}` : 'No active case'} />
          </div>

          <p className="text-sm text-slate-300">{currentCase ? `Active case assigned. Current workflow: ${selectedWorkflowLabel}.` : 'No active case. View available cases below.'}</p>
        </div>
      </section>

      <section className="grid gap-4 rounded-[2rem] border border-slate-200 bg-white p-4 shadow-soft sm:grid-cols-2 xl:grid-cols-5">
        {STATUS_OPTIONS.map((option) => {
          const active = normalizeStatus(selectedWorkflowLabel) === option.label.toLowerCase().replace(/\s+/g, '_') || normalizeStatus(currentStatus) === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => updateStatus(option.value)}
              disabled={saving}
              className={`rounded-2xl border px-4 py-4 text-sm font-black uppercase tracking-[0.2em] transition ${
                active ? 'border-sky-500 bg-sky-600 text-white shadow-lg' : 'border-slate-200 bg-slate-50 text-slate-700 active:scale-[0.99]'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <article className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-soft">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Status Workflow Indicator</p>
              <h2 className="mt-1 text-2xl font-black text-slate-900">Dispatch → Delivered</h2>
            </div>
            <button type="button" className="btn-secondary" onClick={useDeviceLocation} disabled={saving}>
              Use GPS
            </button>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {WORKFLOW_STEPS.map((step, index) => {
              const active = normalizeStatus(selectedWorkflowLabel) === step.label.toLowerCase().replace(/\s+/g, '_') || normalizeStatus(currentStatus) === step.status
              return (
                <button
                  key={step.status}
                  type="button"
                  disabled={saving}
                  onClick={() => updateStatus(step.status)}
                  className={`rounded-full border px-4 py-3 text-xs font-black uppercase tracking-[0.2em] transition ${
                    active ? 'border-sky-500 bg-sky-600 text-white' : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  {index + 1}. {step.label}
                </button>
              )
            })}
          </div>

          <div className="mt-5 rounded-[1.75rem] border border-slate-200 bg-slate-50 p-4">
            {currentCase ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Active Case Panel</p>
                    <h3 className="mt-1 text-2xl font-black text-slate-900">Patient {getPatientName(currentCase)}</h3>
                  </div>
                  <span className={`inline-flex rounded-full border px-3 py-2 text-xs font-bold ${getSeverityTone(currentCase.severity)}`}>
                    {normalizeSeverity(currentCase.severity)}
                  </span>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <InfoCard label="Case ID" value={`#${getCaseId(currentCase)}`} />
                  <InfoCard label="Condition" value={getCondition(currentCase)} />
                  <InfoCard label="Case Location" value={safeString(currentCase.location)} />
                  <InfoCard label="Hospital" value={currentHospital ? `${currentHospital.name || 'Assigned hospital'} · ${currentHospital.location || 'Unknown location'}` : 'Pending'} />
                  <InfoCard label="Distance to Case" value={formatKm(distanceToCase)} />
                  <InfoCard label="Distance to Hospital" value={formatKm(distanceToHospital)} />
                  <InfoCard label="Travel Time" value={formatTravelMinutes(distanceToCase)} />
                  <InfoCard label="Status" value={safeString(selectedWorkflowLabel || currentCase.status || currentStatus)} />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <button type="button" className="btn-primary text-base" onClick={callHospital}>
                    Call Hospital
                  </button>
                  <button type="button" className="btn-secondary text-base" onClick={rejectCase}>
                    Reject / Cancel Case
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">
                No active case. View available cases below.
              </div>
            )}
          </div>
        </article>

        <aside className="space-y-4">
          <article id="navigation" className="rounded-[2rem] border border-slate-200 bg-slate-950 p-5 text-white shadow-soft">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-300">Current Location</p>
                <h3 className="mt-1 text-2xl font-black">Track and update</h3>
              </div>
              <button type="button" className="rounded-2xl border border-white/10 bg-white/10 px-4 py-3 text-sm font-bold text-white" onClick={() => setLocationModalOpen(true)}>
                Update Location
              </button>
            </div>

            <p className="mt-3 text-sm text-slate-300">{ambulanceLocation ? `${ambulanceLocation.latitude.toFixed(5)}, ${ambulanceLocation.longitude.toFixed(5)}` : 'Location not set yet.'}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" className="btn-primary" onClick={useDeviceLocation} disabled={saving}>
                Use GPS
              </button>
              <button type="button" className="btn-secondary" onClick={() => setLocationModalOpen(true)}>
                Manual Update
              </button>
            </div>
          </article>

          <article id="status" className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-soft">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Current Status Header</p>
                <h3 className="mt-1 text-xl font-black text-slate-900">Workflow status</h3>
              </div>
            </div>
            <div className="mt-4 grid gap-2">
              {STATUS_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => updateStatus(item.value)}
                  disabled={saving}
                  className={`flex items-center justify-between rounded-2xl border px-4 py-3 text-left text-sm font-bold ${normalizeStatus(currentStatus) === item.value ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 bg-slate-50 text-slate-700'}`}
                >
                  <span>{item.label}</span>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Tap</span>
                </button>
              ))}
            </div>
          </article>
        </aside>
      </section>

      <section id="ai-dispatch" className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-soft transition-all">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Automated Dispatch System</p>
            <h2 className="mt-1 text-2xl font-black text-slate-900">AI Dispatch Center</h2>
          </div>
          <button 
            type="button" 
            onClick={() => loadData()} 
            className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition active:scale-95" 
            disabled={loading || refreshing}
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className="mt-4 overflow-hidden rounded-[1.75rem]">
          {loading ? (
            <div className="rounded-[1.75rem] border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-slate-500 animate-pulse font-medium">
              Synchronizing with AI Dispatcher...
            </div>
          ) : assignedCase ? (
            <div className="relative overflow-hidden bg-slate-950 p-6 text-white shadow-lg transition-all duration-300">
              <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-sky-500/10 blur-3xl"></div>
              <div className="absolute -left-10 -bottom-10 h-40 w-40 rounded-full bg-indigo-500/10 blur-3xl"></div>

              <div className="relative space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-3.5 w-3.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-amber-500"></span>
                    </span>
                    <span className="text-xs font-black uppercase tracking-[0.2em] text-amber-400">Mission Active</span>
                  </div>
                  <span className={`rounded-full border px-3 py-1 text-xs font-black tracking-wider ${getSeverityTone(assignedCase.severity)}`}>
                    {normalizeSeverity(assignedCase.severity)}
                  </span>
                </div>

                <div className="space-y-1">
                  <h3 className="text-2xl font-black tracking-tight">Case #{getCaseId(assignedCase)}</h3>
                  <p className="text-sm text-slate-300">
                    Patient: <span className="font-bold text-white">{getPatientName(assignedCase)}</span> · Condition: <span className="italic text-slate-200">{getCondition(assignedCase)}</span>
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-4">
                  <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center">
                    <p className="text-[0.65rem] font-bold uppercase tracking-wider text-slate-400">Target Hospital</p>
                    <p className="mt-1 text-xs font-black text-white truncate">{safeString(assignedCase.hospital_name || (assignedCase.hospital_id ? `Hospital ${assignedCase.hospital_id}` : '—'))}</p>
                  </div>
                  <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center">
                    <p className="text-[0.65rem] font-bold uppercase tracking-wider text-slate-400">Current Location</p>
                    <p className="mt-1 text-xs font-black text-white">{ambulanceLocation ? `${ambulanceLocation.latitude.toFixed(4)}, ${ambulanceLocation.longitude.toFixed(4)}` : 'Not Set'}</p>
                  </div>
                  <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center">
                    <p className="text-[0.65rem] font-bold uppercase tracking-wider text-slate-400">ETA</p>
                    <p className="mt-1 text-xs font-black text-white">{getEta(assignedCase)}</p>
                  </div>
                  <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center">
                    <p className="text-[0.65rem] font-bold uppercase tracking-wider text-slate-400">System Workflow</p>
                    <p className="mt-1 text-xs font-black text-sky-400 uppercase tracking-wider">{selectedWorkflowLabel}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100/40 p-8 text-center transition-all duration-300">
              <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-sky-50 shadow-inner">
                <span className="absolute inline-flex h-full w-full rounded-full bg-sky-100/50 animate-pulse"></span>
                <span className="text-2xl animate-bounce">📡</span>
              </div>
              <div className="mt-4 space-y-1">
                <h3 className="text-lg font-black text-slate-900 tracking-tight">Standing By for AI Dispatch</h3>
                <p className="max-w-md mx-auto text-xs text-slate-500 leading-relaxed">
                  PulsePath Triage & Selection Agents are actively monitoring incoming emergencies. You will be automatically assigned and alerted when a case matches your location and sector.
                </p>
              </div>
              <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-4 py-1.5 text-[0.7rem] font-black uppercase tracking-wider text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping"></span>
                <span>Active Connection · Waiting for page...</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section id="history" className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-soft">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-600">History of Cases Attended</p>
            <h2 className="mt-1 text-2xl font-black text-slate-900">Cases Attended History</h2>
          </div>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            {historyCases.length} total
          </span>
        </div>

        <div className="mt-4 space-y-3">
          {historyCases.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-600">
              No completed or previous cases found.
            </div>
          ) : (
            historyCases.map((item) => (
              <article key={getCaseId(item)} className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4 transition-all hover:bg-slate-100/50">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-black text-slate-900">Patient: {getPatientName(item)}</p>
                    <p className="mt-1 text-sm text-slate-600">{getCondition(item)}</p>
                  </div>
                  <span className={`inline-flex rounded-full border px-3 py-2 text-xs font-bold ${getSeverityTone(item.severity)}`}>
                    {normalizeSeverity(item.severity)}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <SmallStat label="Case ID" value={`#${getCaseId(item)}`} />
                  <SmallStat label="Location" value={safeString(item.location)} />
                  <SmallStat label="Hospital" value={safeString(item.hospital_name || (item.hospital_id ? `Hospital ${item.hospital_id}` : '—'))} />
                  <SmallStat label="Final Status" value={safeString(item.status)} />
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      {locationModalOpen ? (
        <LocationModal
          initialLatitude={location.latitude}
          initialLongitude={location.longitude}
          onClose={() => setLocationModalOpen(false)}
          onSubmit={updateLocation}
          onUseGPS={useDeviceLocation}
          loading={saving}
        />
      ) : null}

      {callDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" onClick={() => setCallDialogOpen(false)}>
          <div className="w-full max-w-sm rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-soft" onClick={(event) => event.stopPropagation()}>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Call Hospital</p>
            <h3 className="mt-2 text-2xl font-black text-slate-900">{currentHospital?.name || 'Hospital contact'}</h3>
            <p className="mt-2 text-sm text-slate-600">{currentHospital?.phone || currentHospital?.contact_number || currentHospital?.contact || 'No number available in data.'}</p>
            <button type="button" className="btn-primary mt-4 w-full" onClick={() => setCallDialogOpen(false)}>
              Close
            </button>
          </div>
        </div>
      ) : null}

      <ChatAssistant caseId={assignedCase ? Number(getCaseId(assignedCase)) : undefined} />
    </div>
  )
}

function StatusChip({ label, value }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 px-4 py-4">
      <p className="text-[0.66rem] font-bold uppercase tracking-[0.25em] text-slate-300">{label}</p>
      <p className="mt-1 text-sm font-black text-white">{value}</p>
    </div>
  )
}

function InfoCard({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  )
}

function SmallStat({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-center">
      <p className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-slate-400">{label}</p>
      <p className="mt-1 text-sm font-black text-slate-900">{value}</p>
    </div>
  )
}

function LocationModal({ initialLatitude, initialLongitude, onClose, onSubmit, onUseGPS, loading }) {
  const [latitude, setLatitude] = useState(initialLatitude)
  const [longitude, setLongitude] = useState(initialLongitude)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-soft" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-600">Update Location</p>
            <h3 className="mt-1 text-2xl font-black text-slate-900">Current location</h3>
          </div>
          <button type="button" onClick={onClose} className="text-2xl font-black text-slate-500">×</button>
        </div>

        <div className="mt-4 grid gap-3">
          <label className="space-y-2">
            <span className="text-sm font-semibold text-slate-700">Latitude</span>
            <input className="field" type="number" step="0.000001" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="13.0827" />
          </label>
          <label className="space-y-2">
            <span className="text-sm font-semibold text-slate-700">Longitude</span>
            <input className="field" type="number" step="0.000001" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="80.2707" />
          </label>
        </div>

        <div className="mt-4 flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onUseGPS} disabled={loading}>
            Use GPS
          </button>
          <button type="button" className="btn-primary flex-1" onClick={() => onSubmit(latitude, longitude)} disabled={loading || !latitude || !longitude}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

StatusChip.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
}

InfoCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
}

SmallStat.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
}

LocationModal.propTypes = {
  initialLatitude: PropTypes.string,
  initialLongitude: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onUseGPS: PropTypes.func.isRequired,
  loading: PropTypes.bool,
}

export default AmbulanceDashboard