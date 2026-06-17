/**
 * P5.1 – Offline banner component.
 * Renders a dismissible warning strip at the very top of the viewport when
 * the browser loses network connectivity.
 */
import { useState } from 'react'
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js'

export function OfflineBanner() {
  const isOnline = useOnlineStatus()
  const [dismissed, setDismissed] = useState(false)

  // Auto-clear dismissed state when we come back online
  if (isOnline) {
    if (dismissed) setDismissed(false)
    return null
  }

  if (dismissed) return null

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[9999] flex items-center justify-between gap-4 bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg"
    >
      <span className="flex items-center gap-2">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        You are offline — live data is paused. Some features may not work.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rounded-lg px-2 py-0.5 text-xs hover:bg-white/20"
        aria-label="Dismiss offline warning"
      >
        Dismiss
      </button>
    </div>
  )
}
