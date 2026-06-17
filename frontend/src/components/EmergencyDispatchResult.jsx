import PropTypes from 'prop-types'

const severityColors = {
  P0: 'severity-pill severity-pill-red',
  P1: 'severity-pill severity-pill-orange',
  P2: 'severity-pill severity-pill-yellow',
  P3: 'severity-pill severity-pill-green',
}

function EmergencyDispatchResult({ dispatchResult, onClose }) {
  const data = dispatchResult || {}
  const severity = data.severity || data.case_status || 'P2'
  const severityClass = severityColors[severity] || 'severity-pill severity-pill-gray'

  return (
    <div className="dispatch-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dispatch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dispatch-result-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dispatch-modal-head">
          <div>
            <p className="eyebrow">Emergency workflow</p>
            <h3 id="dispatch-result-title">Case dispatched</h3>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="dispatch-result-grid">
          <div className="dispatch-result-card">
            <span>Case ID</span>
            <strong>{data.case_id ?? data.id ?? 'N/A'}</strong>
          </div>
          <div className="dispatch-result-card">
            <span>Severity</span>
            <strong className={severityClass}>{severity}</strong>
          </div>
          <div className="dispatch-result-card">
            <span>Status</span>
            <strong>{data.case_status || data.workflow_status || 'created'}</strong>
          </div>
          <div className="dispatch-result-card">
            <span>Ambulance</span>
            <strong>{data.ambulance_id ?? 'Pending'}</strong>
          </div>
          <div className="dispatch-result-card">
            <span>Hospital</span>
            <strong>{data.hospital_id ?? 'Pending'}</strong>
          </div>
          <div className="dispatch-result-card">
            <span>ETA</span>
            <strong>{data.eta ?? 'N/A'}</strong>
          </div>
        </div>

        <div className="dispatch-result-summary">
          <span>Condition</span>
          <p>{data.condition || data.message || 'No condition returned.'}</p>
        </div>

        {data.chat_response ? (
          <div className="dispatch-result-summary">
            <span>Workflow note</span>
            <p>{data.chat_response}</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

EmergencyDispatchResult.propTypes = {
  dispatchResult: PropTypes.shape({
    case_id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    severity: PropTypes.string,
    case_status: PropTypes.string,
    workflow_status: PropTypes.string,
    ambulance_id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    hospital_id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    eta: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    condition: PropTypes.string,
    message: PropTypes.string,
    chat_response: PropTypes.string,
  }),
  onClose: PropTypes.func.isRequired,
}

export default EmergencyDispatchResult
