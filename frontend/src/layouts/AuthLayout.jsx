import { Outlet, Link } from 'react-router-dom'

function AuthLayout() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-sky-500/20 blur-3xl" />
        <div className="absolute right-0 top-1/3 h-80 w-80 rounded-full bg-rose-500/15 blur-3xl" />
      </div>
      <div className="relative mx-auto grid min-h-screen max-w-7xl items-center gap-10 px-4 py-8 lg:grid-cols-[1.1fr_0.9fr] lg:px-8">
        <section className="hidden rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-soft backdrop-blur lg:block">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-sky-300">Emergency Dispatch</p>
          <h1 className="mt-4 max-w-xl text-5xl font-black leading-none text-white">Command the network that moves patients faster.</h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
            Role-aware operations for hospitals, administrators, and ambulance crews. Track cases, manage resources, and coordinate in real time.
          </p>
          <div className="mt-8 grid grid-cols-3 gap-4">
            {[
              ['Live cases', '128'],
              ['Hospitals', '24'],
              ['Fleet uptime', '99.2%'],
            ].map(([label, value]) => (
              <article key={label} className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <p className="text-xs uppercase tracking-[0.25em] text-slate-400">{label}</p>
                <p className="mt-2 text-2xl font-bold text-white">{value}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-xl rounded-[2rem] border border-slate-200/10 bg-white p-6 text-slate-900 shadow-soft md:p-8">
          <div className="mb-6 flex items-center justify-between">
            <Link to="/login" className="text-sm font-semibold text-slate-500 hover:text-slate-900">
              Emergency Dispatch System
            </Link>
            <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.22em] text-sky-700">
              Healthcare Ops
            </span>
          </div>
          <Outlet />
        </section>
      </div>
    </div>
  )
}

export default AuthLayout