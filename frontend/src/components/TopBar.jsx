import PropTypes from 'prop-types'

function TopBar({ title, subtitle, actions }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="pulse"></div>
        <div>
          <p className="eyebrow">Metro Emergency Network</p>
          <h1>{title}</h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
        </div>
      </div>
      <div className="controls">{actions}</div>
    </header>
  )
}

TopBar.propTypes = {
  title: PropTypes.string.isRequired,
  subtitle: PropTypes.string,
  actions: PropTypes.node,
}

export default TopBar
