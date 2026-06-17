import PropTypes from 'prop-types'

function StatCard({ label, value, helper }) {
  return (
    <div className="stat-card">
      <p className="metric-label">{label}</p>
      <p className="metric">{value}</p>
      {helper ? <p className="muted">{helper}</p> : null}
    </div>
  )
}

StatCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  helper: PropTypes.string,
}

export default StatCard
