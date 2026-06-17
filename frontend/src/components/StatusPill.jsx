import PropTypes from 'prop-types'

function StatusPill({ text, tone }) {
  return <span className={`status ${tone}`}>{text}</span>
}

StatusPill.propTypes = {
  text: PropTypes.string.isRequired,
  tone: PropTypes.string.isRequired,
}

export default StatusPill
