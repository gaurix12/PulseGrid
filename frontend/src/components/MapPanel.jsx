import PropTypes from 'prop-types'

function MapPanel({ title, subtitle, tags }) {
  return (
    <div className="map-surface">
      <div className="map-overlay">
        <p className="map-title">{title}</p>
        <p className="map-subtitle">{subtitle}</p>
        <div className="map-tags">
          {tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      </div>
      <div className="map-blips">
        <span className="blip danger"></span>
        <span className="blip alert"></span>
        <span className="blip calm"></span>
      </div>
    </div>
  )
}

MapPanel.propTypes = {
  title: PropTypes.string.isRequired,
  subtitle: PropTypes.string.isRequired,
  tags: PropTypes.arrayOf(PropTypes.string).isRequired,
}

export default MapPanel
