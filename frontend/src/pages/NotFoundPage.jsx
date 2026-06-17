import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'

function NotFoundPage() {
  const { isAuthenticated, homeRoute } = useAuth()

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-white">
      <div className="max-w-lg rounded-[2rem] border border-white/10 bg-white/5 p-8 text-center shadow-soft backdrop-blur">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-sky-300">404</p>
        <h1 className="mt-4 text-4xl font-black tracking-tight">Page not found</h1>
        <p className="mt-4 text-sm leading-6 text-slate-300">
          The route you requested does not exist. Return to the workspace or sign in again.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            to={isAuthenticated ? homeRoute : '/login'}
            className="rounded-2xl bg-sky-500 px-5 py-3 text-sm font-bold text-white transition hover:bg-sky-400"
          >
            {isAuthenticated ? 'Go to dashboard' : 'Go to login'}
          </Link>
          <Link
            to="/register"
            className="rounded-2xl border border-white/15 px-5 py-3 text-sm font-bold text-white transition hover:bg-white/10"
          >
            Create account
          </Link>
        </div>
      </div>
    </div>
  )
}

export default NotFoundPage