import { useEffect, useMemo, useState } from 'react'
import * as api from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'

const STATUS_LABELS = {
  created: 'Created',
  triaged: 'Triaged',
  dispatched: 'Dispatched',
  arrived: 'Arrived',
  resolved: 'Resolved',
  alerts_sent: 'Active / Incoming',
  discharged: 'Discharged',
  failed_escalation: 'Transferred',
}

function safeString(value) {
  if (value == null || value === '') return '—'
  return String(value)
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return safeString(value)
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function normalizeSeverity(value) {
  const severity = safeString(value).toUpperCase()
  return ['P0', 'P1', 'P2', 'P3'].includes(severity) ? severity : 'P3'
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
  switch (safeString(status).toLowerCase()) {
    case 'discharged':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700'
    case 'failed':
      return 'border-rose-200 bg-rose-50 text-rose-700'
    case 'arrived':
      return 'border-sky-200 bg-sky-50 text-sky-700'
    case 'en-route':
    case 'en route':
      return 'border-indigo-200 bg-indigo-50 text-indigo-700'
    case 'dispatched':
      return 'border-violet-200 bg-violet-50 text-violet-700'
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700'
  }
}

function getCaseId(caseData) {
  return caseData?.id ?? caseData?.case_id ?? caseData?.caseId ?? caseData?._id ?? ''
}

function getPatientName(caseData) {
  return caseData?.patient_name || caseData?.patientName || caseData?.name || caseData?.full_name || `Patient ${getCaseId(caseData) || ''}`.trim()
}

function getAssignedAmbulance(caseData) {
  const ambulance = caseData?.ambulance || caseData?.assigned_ambulance || caseData?.assignedAmbulance || null
  return {
    driverName: ambulance?.driver_name || ambulance?.driverName || caseData?.ambulance_driver_name || safeString(caseData?.ambulance_id || caseData?.ambulanceId),
    status: ambulance?.status || caseData?.ambulance_status || caseData?.ambulanceStatus || '—',
  }
}

function getStatusValue(caseData) {
  return safeString(caseData?.status || caseData?.case_status || 'triaged')
}

function CaseDetailsModal({ caseData, hospitalLabel = 'Self (this hospital)', allowStatusUpdate = true, onClose, onUpdated }) {
  const pushToast = useUiStore((state) => state.pushToast)
  const [status, setStatus] = useState(getStatusValue(caseData))
  const [isUpdating, setIsUpdating] = useState(false)

  const caseId = useMemo(() => getCaseId(caseData), [caseData])
  const ambulance = useMemo(() => getAssignedAmbulance(caseData), [caseData])

  useEffect(() => {
    setStatus(getStatusValue(caseData))
  }, [caseData])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const updateStatus = async (nextStatus) => {
    if (!allowStatusUpdate || !caseId || !nextStatus || nextStatus === status) return
    setIsUpdating(true)
    try {
      await api.updateHospitalCaseStatus(caseId, nextStatus)
      setStatus(nextStatus)
      pushToast({
        title: 'Case status updated',
        description: `Case ${caseId} moved to ${nextStatus}.`,
        tone: 'success',
      })
      onUpdated?.()
    } catch (error) {
      pushToast({
        title: 'Unable to update case',
        description: error.message,
        tone: 'error',
      })
      setStatus(getStatusValue(caseData))
    } finally {
      setIsUpdating(false)
    }
  }

  if (!caseData) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-4xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-soft"
        role="dialog"
        aria-modal="true"
        aria-labelledby="case-details-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">Case details</p>
            <h2 id="case-details-title" className="mt-2 text-2xl font-black tracking-tight text-slate-900">
              {getPatientName(caseData)}
            </h2>
            <p className="mt-1 text-sm text-slate-500">Case ID {caseId || '—'}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-lg font-bold text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
            aria-label="Close case details"
          >
            ×
          </button>
        </div>

        <div className="grid gap-0 lg:grid-cols-[1.4fr_0.9fr]">
          <div className="grid gap-4 p-6 md:grid-cols-2">
            <InfoCard label="Case ID" value={caseId || '—'} />
            <InfoCard
              label="Severity"
              value={normalizeSeverity(caseData.severity)}
              valueClassName={`inline-flex w-fit rounded-full border px-3 py-1 text-xs font-bold ${getSeverityTone(caseData.severity)}`}
            />
            <InfoCard label="Condition" value={safeString(caseData.condition || caseData.medical_condition || caseData.description)} />
            <InfoCard label="Location" value={safeString(caseData.location)} />
            <InfoCard
              label="Status"
              value={
                allowStatusUpdate ? (
                  <select
                    className="field mt-2"
                    value={status}
                    disabled={isUpdating}
                    onChange={(event) => updateStatus(event.target.value)}
                  >
                    {!['alerts_sent', 'discharged', 'failed_escalation'].includes(status) && (
                      <option value={status}>{STATUS_LABELS[status] || status}</option>
                    )}
                    <option value="alerts_sent">Active / Incoming</option>
                    <option value="discharged">Discharge Patient</option>
                    <option value="failed_escalation">Transfer to Another Hospital</option>
                  </select>
                ) : (
                  <span className={`inline-flex w-fit rounded-full border px-3 py-1 text-xs font-bold ${getStatusTone(status)}`}>
                    {STATUS_LABELS[status] || status}
                  </span>
                )
              }
            />
            <InfoCard label="Assigned Hospital" value={hospitalLabel} />
            <InfoCard label="Created At" value={formatDateTime(caseData.created_at || caseData.createdAt || caseData.assigned_at)} />
            <InfoCard label="Last Updated" value={formatDateTime(caseData.updated_at || caseData.updatedAt || caseData.created_at)} />
          </div>

          <aside className="border-t border-slate-200 bg-slate-50 p-6 lg:border-l lg:border-t-0">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Assigned Ambulance</p>
              <div className="mt-3 space-y-3 text-sm text-slate-700">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Driver</p>
                  <p className="mt-1 font-semibold text-slate-900">{ambulance.driverName}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Status</p>
                  <p className="mt-1 font-semibold text-slate-900">{safeString(ambulance.status)}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">ETA</p>
                  <p className="mt-1 font-semibold text-slate-900">{safeString(caseData.eta)}</p>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">Editable field</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {allowStatusUpdate
                  ? 'Status is the only editable field in this modal. Closing the dialog keeps the table view unchanged.'
                  : 'This case view is read-only from the admin overview.'}
              </p>
              {isUpdating ? <p className="mt-4 text-sm font-semibold text-sky-600">Updating status...</p> : null}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function InfoCard({ label, value, valueClassName = 'mt-2 font-semibold text-slate-900' }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-500">{label}</p>
      <div className={valueClassName}>{value}</div>
    </div>
  )
}

export default CaseDetailsModal