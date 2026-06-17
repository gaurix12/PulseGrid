import PropTypes from 'prop-types'

function Panel({ title, actions, children, className }) {
  return (
    <section className={`panel ${className || ''}`.trim()}>
      <div className="panel-head">
        <h3>{title}</h3>
        <div className="panel-actions">{actions}</div>
      </div>
      {children}
    </section>
  )
}

Panel.propTypes = {
  title: PropTypes.string.isRequired,
  actions: PropTypes.node,
  children: PropTypes.node.isRequired,
  className: PropTypes.string,
}

export default Panel
