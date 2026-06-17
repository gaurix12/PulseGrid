import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getAllCases, getHospitalResources } from '../../services/api.js'
import { useUiStore } from '../../store/uiStore.js'

function summarizeResources(resources) {
  const bedTotal = Number(resources?.beds_total ?? 0)
  const bedAvailable = Number(resources?.beds_available ?? 0)
  const icuTotal = Number(resources?.icu_total ?? 0)
  const icuAvailable = Number(resources?.icu_available ?? 0)
  const ventilatorTotal = Number(resources?.ventilators_total ?? 0)
  const ventilatorAvailable = Number(resources?.ventilators_available ?? 0)

  return {
    beds: bedTotal ? Math.round(((bedTotal - bedAvailable) / bedTotal) * 100) : 0,
    icu: icuTotal ? Math.round(((icuTotal - icuAvailable) / icuTotal) * 100) : 0,
    ventilators: ventilatorTotal ? Math.round(((ventilatorTotal - ventilatorAvailable) / ventilatorTotal) * 100) : 0,
    bedAvailable,
    bedTotal,
    icuAvailable,
    icuTotal,
    ventilatorAvailable,
    ventilatorTotal,
  }
}

function HospitalDetails() {
  const { hospitalId } = useParams()
  const pushToast = useUiStore((state) => state.pushToast)
  const [cases, setCases] = useState([])
  const [resources, setResources] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const [allCases, resourceSnapshot] = await Promise.all([getAllCases(), getHospitalResources(hospitalId)])
        setCases((Array.isArray(allCases) ? allCases : []).filter((item) => String(item.hospital_id) === String(hospitalId)))
        setResources(resourceSnapshot?.data || resourceSnapshot || null)
      } catch (error) {
        pushToast({ title: 'Unable to load hospital details', description: error.message, tone: 'error' })
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [hospitalId])

  const summary = useMemo(() => summarizeResources(resources), [resources])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-sky-600">Hospital Details</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900">Hospital {hospitalId}</h1>
        </div>
        <Link to="/admin/dashboard" className="btn-secondary">
          Back to dashboard
        </Link>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard label="Beds utilization" value={`${summary.beds}%`} />
        <MetricCard label="ICU utilization" value={`${summary.icu}%`} />
        <MetricCard label="Ventilator utilization" value={`${summary.ventilators}%`} />
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
        <h2 className="text-xl font-black text-slate-900">Current resources</h2>
        {loading ? (
          <p className="mt-4 text-sm text-slate-500">Loading resources...</p>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <ResourceCard label="Beds" available={summary.bedAvailable} total={summary.bedTotal} />
            <ResourceCard label="ICU" available={summary.icuAvailable} total={summary.icuTotal} />
            <ResourceCard label="Ventilators" available={summary.ventilatorAvailable} total={summary.ventilatorTotal} />
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
        <h2 className="text-xl font-black text-slate-900">Active cases</h2>
        <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Case</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cases.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3 font-semibold text-slate-900">#{item.id}</td>
                  <td className="px-4 py-3 text-slate-700">{item.patient_name || 'Unknown'}</td>
                  <td className="px-4 py-3 text-slate-700">{item.severity || 'P2'}</td>
                  <td className="px-4 py-3 text-slate-700">{item.status || 'triaged'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function MetricCard({ label, value }) {
  return (
    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
      <p className="text-xs font-bold uppercase tracking-[0.25em] text-slate-400">{label}</p>
      <p className="mt-3 text-3xl font-black text-slate-900">{value}</p>
    </article>
  )
}

function ResourceCard({ label, available, total }) {
  const percent = total ? Math.round((available / total) * 100) : 0
  const tone = percent >= 80 ? 'bg-rose-500' : percent >= 55 ? 'bg-amber-500' : 'bg-emerald-500'

  return (
    <article className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-slate-900">{label}</p>
        <span className="text-sm font-black text-slate-900">{percent}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-3 text-sm text-slate-600">
        {available}/{total}
      </p>
    </article>
  )
}

export default HospitalDetails