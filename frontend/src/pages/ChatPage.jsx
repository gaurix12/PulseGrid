/**
 * ChatPage – full-screen, standalone chat interface.
 *
 * Fixes applied:
 *   P1.1  Standardised API response shape via api.sendChatMessage
 *   P1.2  No MainLayout wrapper — renders its own header
 *   P2.1  Role-specific config (titles, colours, examples) via chatConfig.js
 *   P2.2  Rich context payload sent with every message
 *   P2.3  Mutating chat actions auto-executed and data refreshed
 *   P2.4  Chat history persisted in localStorage (last 50 messages)
 *   P2.5  Tool name + collapsible args/results shown on AI messages
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { useData } from '../context/DataContext.jsx'
import * as api from '../services/api.js'
import { executeChatAction, isMutatingTool } from '../services/chatActions.js'
import { CHAT_CONFIG } from '../constants/chatConfig.js'

/* ─── helpers ──────────────────────────────────────────────────────────────── */
function getDashboardRoute(role) {
  if (role === 'hospital') return '/hospital/dashboard'
  if (role === 'ambulance') return '/ambulance/dashboard'
  return '/admin/dashboard'
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/* ─── Tool detail panel (P2.5) ─────────────────────────────────────────────── */
function ToolDetail({ toolUsed, toolArgs, results }) {
  const [open, setOpen] = useState(false)
  if (!toolUsed) return null

  return (
    <div className="mt-2 border-t border-white/10 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-sky-300 hover:text-sky-200"
      >
        <span>{open ? '▼' : '▶'}</span>
        <span>Tool: {toolUsed}</span>
      </button>

      {open && (
        <div className="mt-2 rounded-xl bg-slate-950/80 p-3 text-[11px] font-mono text-slate-300 overflow-x-auto">
          {toolArgs && (
            <>
              <p className="text-slate-500 mb-1">Arguments</p>
              <pre className="text-emerald-300">{JSON.stringify(toolArgs, null, 2)}</pre>
            </>
          )}
          {results && (
            <>
              <p className="text-slate-500 mt-2 mb-1">Results</p>
              <pre className="text-sky-300">{JSON.stringify(results, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/* ─── Single message bubble ────────────────────────────────────────────────── */
function MessageBubble({ msg, isUser, accentGradient }) {
  const isSystem = msg.role === 'system'

  if (isSystem) {
    return (
      <div className="mx-auto max-w-[80%] rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-center text-xs text-slate-400">
        {msg.text}
        {msg.error && <span className="ml-1 text-rose-400">({msg.error})</span>}
      </div>
    )
  }

  return (
    <div className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* avatar */}
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white shadow ${
          isUser
            ? `bg-gradient-to-br ${accentGradient}`
            : 'bg-gradient-to-br from-violet-600 to-indigo-600'
        }`}
      >
        {isUser ? 'ME' : 'AI'}
      </span>

      <div className={`max-w-[72%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow ${
            isUser
              ? `bg-gradient-to-br ${accentGradient} text-white rounded-br-sm`
              : 'border border-white/10 text-slate-100 rounded-bl-sm'
          }`}
          style={!isUser ? { background: 'rgba(255,255,255,0.07)' } : undefined}
        >
          <p className="whitespace-pre-wrap">{msg.text}</p>
          {msg.error && (
            <p className="mt-1 text-xs font-bold text-rose-400">⚠ {msg.error}</p>
          )}
          {/* P2.5 – Tool details */}
          {!isUser && (
            <ToolDetail
              toolUsed={msg.toolUsed}
              toolArgs={msg.toolArgs}
              results={msg.results}
            />
          )}
        </div>
        <span className="mt-0.5 px-1 text-[9px] text-slate-500">{msg.time}</span>
      </div>
    </div>
  )
}

/* ─── Typing indicator ──────────────────────────────────────────────────────── */
function TypingIndicator() {
  return (
    <div className="flex items-end gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-indigo-600 text-[10px] font-black text-white">
        AI
      </span>
      <div
        className="rounded-2xl rounded-bl-sm border border-white/10 px-4 py-3"
        style={{ background: 'rgba(255,255,255,0.07)' }}
      >
        <div className="flex gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-slate-400"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ─── Pagination controls ────────────────────────────────────────────────────── */
function Paginator({ page, totalPages, hasPrev, hasNext, prev, next }) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-end gap-2 mt-3 text-xs font-semibold text-slate-400">
      <button onClick={prev} disabled={!hasPrev} className="rounded-lg border border-white/10 px-2 py-1 disabled:opacity-30 hover:bg-white/10 transition">
        ←
      </button>
      <span>{page} / {totalPages}</span>
      <button onClick={next} disabled={!hasNext} className="rounded-lg border border-white/10 px-2 py-1 disabled:opacity-30 hover:bg-white/10 transition">
        →
      </button>
    </div>
  )
}

/* ─── Main component ────────────────────────────────────────────────────────── */
export default function ChatPage() {
  const navigate = useNavigate()
  const { currentUser, role: userRole, logout } = useAuth()
  const { cases, hospitals, ambulances, refreshCases, refreshHospitals, refreshAmbulances } = useData()

  const role = userRole || 'guest'
  const config = CHAT_CONFIG[role] || CHAT_CONFIG.guest

  const hospitalId = currentUser?.hospital_id ?? currentUser?.hospitalId ?? currentUser?.id
  const ambulanceId = currentUser?.ambulance_id ?? currentUser?.ambulanceId ?? currentUser?.id

  // P2.4 – Persist history in localStorage keyed by user + role
  const storageKey = `pulsepath-chatpage-${role}-${currentUser?.id || 'guest'}`

  const loadHistory = useCallback(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }, [storageKey])

  const saveHistory = useCallback(
    (msgs) => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(msgs.slice(-50)))
      } catch {}
    },
    [storageKey],
  )

  // Seed initial messages per role (only if no history saved)
  const seedMessages = useMemo(() => {
    const t = nowTime()
    const seeds = {
      hospital: [
        { id: makeId(), role: 'assistant', text: '🏥 Hospital Ops channel ready. Ask me about incoming cases, resource status, or request updates.', time: t },
      ],
      admin: [
        { id: makeId(), role: 'assistant', text: '🛡️ City Dispatch Command active. You can query hospitals, ambulances, and manage case assignments.', time: t },
      ],
      ambulance: [
        { id: makeId(), role: 'assistant', text: '🚑 Ambulance channel ready. I will show your assigned case and nearby emergencies.', time: t },
      ],
      guest: [
        { id: makeId(), role: 'assistant', text: 'Hello! How can I help you with emergency dispatch today?', time: t },
      ],
    }
    return seeds[role] || seeds.guest
  }, [role])

  const [messages, setMessages] = useState(() => loadHistory() || seedMessages)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [caseSummary, setCaseSummary] = useState(null)

  const feedRef = useRef(null)
  const inputRef = useRef(null)

  // Scroll to bottom on new messages
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  // Save history whenever messages change
  useEffect(() => {
    saveHistory(messages)
  }, [messages, saveHistory])

  // Load assigned case for context
  useEffect(() => {
    if (role === 'ambulance' && ambulanceId) {
      api.getAssignedCases(ambulanceId)
        .then((items) => setCaseSummary(Array.isArray(items) ? items[0] : null))
        .catch(() => setCaseSummary(null))
    } else if (cases.length > 0) {
      setCaseSummary(cases[0])
    }
  }, [cases, role, ambulanceId])

  const appendMsg = (msg) => {
    setMessages((prev) => [...prev, { id: makeId(), time: nowTime(), ...msg }])
  }

  const sendMessage = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    setSending(true)

    appendMsg({ role: 'user', text })

    // P2.2 – Rich context payload
    const payload = {
      message: text,
      user_id: currentUser?.id || currentUser?.userId,
      user_role: role,
      case_id: caseSummary?.id,
      hospital_id: hospitalId,
      ambulance_id: ambulanceId,
      context: {
        current_hospital_id: hospitalId,
        current_ambulance_id: ambulanceId,
        available_case_ids: cases.map((c) => c.id),
        available_hospital_ids: hospitals.map((h) => h.id),
        available_ambulance_ids: ambulances.map((a) => a.id),
      },
    }

    try {
      // P1.1 – Standardised response
      const res = await api.sendChatMessage(payload)

      appendMsg({
        role: 'assistant',
        text: res.message || 'Request processed.',
        toolUsed: res.toolUsed,
        toolArgs: res.toolArgs,
        results: res.results,
        reasoning: res.reasoning,
        error: res.success === false ? (res.raw?.error || 'Agent execution failed') : null,
      })

      // P2.3 – If the AI triggered a mutating action, execute it
      if (isMutatingTool(res.toolUsed)) {
        try {
          await executeChatAction(res.toolUsed, res.toolArgs, role)
          // Refresh relevant data after mutation
          refreshCases()
          refreshHospitals()
          refreshAmbulances()
          appendMsg({
            role: 'system',
            text: `✅ Action '${res.toolUsed}' applied successfully. Data refreshed.`,
          })
        } catch (actionErr) {
          appendMsg({
            role: 'system',
            text: `⚠ Action '${res.toolUsed}' could not be applied: ${actionErr.message}`,
            error: actionErr.message,
          })
        }
      }
    } catch (err) {
      appendMsg({
        role: 'system',
        text: err.message || 'Failed to communicate with chat server.',
        error: err.message,
      })
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const clearHistory = () => {
    if (window.confirm('Clear chat history?')) {
      const reset = [{ id: makeId(), role: 'assistant', text: 'Chat cleared. How can I help you?', time: nowTime() }]
      setMessages(reset)
    }
  }

  const stats = [
    { label: 'Cases', value: cases.length, accent: 'text-rose-400' },
    { label: 'Hospitals', value: hospitals.length, accent: 'text-sky-400' },
    { label: 'Ambulances', value: ambulances.length, accent: 'text-emerald-400' },
  ]

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">

      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-white/10 bg-slate-900/80 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${config.dot} opacity-75`} />
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${config.dot}`} />
            </span>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">PulsePath Emergency</p>
              <h1 className={`text-base font-black tracking-tight bg-gradient-to-r ${config.accent} bg-clip-text text-transparent`}>
                {config.title}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Live stats */}
            {stats.map((s) => (
              <div key={s.label} className="hidden rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 sm:block">
                <p className={`text-[9px] font-black uppercase tracking-widest ${s.accent}`}>{s.label}</p>
                <p className="text-sm font-black text-white">{s.value}</p>
              </div>
            ))}
            <span className="hidden rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-300 sm:block">
              {currentUser?.email || 'guest'}
            </span>
            <button
              onClick={() => navigate(getDashboardRoute(role))}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
            >
              ← Dashboard
            </button>
            <button
              onClick={() => { logout(); navigate('/login', { replace: true }) }}
              className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────── */}
      <div className="mx-auto flex w-full max-w-5xl flex-1 overflow-hidden px-4 py-4 lg:px-6">

        {/* Chat panel */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-3xl border border-white/10 bg-slate-900/60 shadow-2xl backdrop-blur">

          {/* Chat header */}
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
            <div>
              <p className={`text-[9px] font-black uppercase tracking-[0.25em] bg-gradient-to-r ${config.accent} bg-clip-text text-transparent`}>Conversation</p>
              <p className="text-xs font-semibold text-slate-400">{config.subtitle}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Live
              </span>
              <button
                onClick={clearHistory}
                className="rounded-xl border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-slate-400 transition hover:bg-white/10 hover:text-white"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Messages feed */}
          <div
            ref={feedRef}
            className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5"
            style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}
          >
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                isUser={msg.role === 'user'}
                accentGradient={config.accent}
              />
            ))}
            {sending && <TypingIndicator />}
            <div ref={feedRef} />
          </div>

          {/* Example chips */}
          {config.examples && (
            <div className="flex gap-2 overflow-x-auto border-t border-white/10 bg-slate-900/40 px-4 py-2.5">
              {config.examples.map((ex) => (
                <button
                  key={ex.label}
                  onClick={() => { setDraft(ex.text); inputRef.current?.focus() }}
                  className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white"
                >
                  {ex.label}
                </button>
              ))}
            </div>
          )}

          {/* Input bar */}
          <div className="shrink-0 border-t border-white/10 px-4 py-3">
            <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 transition focus-within:border-sky-500/50 focus-within:ring-2 focus-within:ring-sky-500/20">
              <input
                ref={inputRef}
                type="text"
                placeholder="Ask me anything…"
                value={draft}
                disabled={sending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendMessage()
                  }
                }}
                className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none disabled:opacity-50"
              />
              <button
                onClick={sendMessage}
                disabled={sending || !draft.trim()}
                className={`flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br ${config.accent} text-white shadow transition active:scale-95 disabled:opacity-40`}
              >
                {sending ? (
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31" strokeDashoffset="10" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                    <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
                  </svg>
                )}
              </button>
            </div>
            <p className="mt-1.5 text-center text-[10px] text-slate-600">
              Enter to send · AI-powered dispatch assistant · History persisted locally
            </p>
          </div>
        </div>

      </div>
    </div>
  )
}