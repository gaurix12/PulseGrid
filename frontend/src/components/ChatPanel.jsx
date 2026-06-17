import PropTypes from 'prop-types'
import { useState } from 'react'

function ChatPanel({ title, messages, placeholder, onSend, isSending }) {
  const [draft, setDraft] = useState('')

  const handleSend = async () => {
    const trimmed = draft.trim()
    if (!trimmed || !onSend) return
    setDraft('')
    await onSend(trimmed)
  }

  return (
    <div className="chat-panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <button className="chip">Live</button>
      </div>
      <div className="chat-feed">
        {messages.length === 0 ? (
          <p style={{ color: 'var(--ink-500)', fontSize: '13px' }}>No messages yet.</p>
        ) : (
          messages.map((msg) => (
            <div key={`${msg.time}-${msg.from}`} className="chat-row">
              <div>
                <p className="chat-from">{msg.from}</p>
                <p className="chat-text">{msg.text}</p>
              </div>
              <span className="time">{msg.time}</span>
            </div>
          ))
        )}
      </div>
      <div className="chat-input">
        <input
          type="text"
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              handleSend()
            }
          }}
          disabled={isSending}
        />
        <button className="ghost" onClick={handleSend} disabled={isSending}>
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  )
}

ChatPanel.propTypes = {
  title: PropTypes.string.isRequired,
  messages: PropTypes.arrayOf(
    PropTypes.shape({
      from: PropTypes.string.isRequired,
      time: PropTypes.string.isRequired,
      text: PropTypes.string.isRequired,
    }),
  ).isRequired,
  placeholder: PropTypes.string.isRequired,
  onSend: PropTypes.func,
  isSending: PropTypes.bool,
}

ChatPanel.defaultProps = {
  onSend: null,
  isSending: false,
}

export default ChatPanel
