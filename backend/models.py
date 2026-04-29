from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import CheckConstraint

db = SQLAlchemy()

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    role = db.Column(db.String(20), nullable=False)  # hospital, ambulance, admin
    hospital_id = db.Column(db.Integer, db.ForeignKey('hospital.id'), nullable=True)
    ambulance_id = db.Column(db.Integer, db.ForeignKey('ambulance.id'), nullable=True)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    def __repr__(self):
        return f'<User {self.username}>'
    
class Hospital(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), unique=True, nullable=False)
    location = db.Column(db.String(200), nullable=False)
    capacity = db.Column(db.Integer, nullable=False)
    current_patients = db.Column(db.Integer, nullable=False)
    icu_total = db.Column(db.Integer, nullable=False)
    icu_available = db.Column(db.Integer, nullable=False)
    ventilators_total = db.Column(db.Integer, nullable=False)
    ventilators_available = db.Column(db.Integer, nullable=False)
    beds_total = db.Column(db.Integer, nullable=False)
    beds_available = db.Column(db.Integer, nullable=False)
    has_cardiology = db.Column(db.Boolean, default=False)
    has_trauma_care = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    latitude = db.Column(db.Float, nullable=True)
    longitude = db.Column(db.Float, nullable=True)

    __table_args__ = (
        CheckConstraint('current_patients <= capacity', name='check_capacity'),
        CheckConstraint('icu_available <= icu_total', name='check_icu'),
        CheckConstraint('ventilators_available <= ventilators_total', name='check_ventilators'),
        CheckConstraint('beds_available <= beds_total', name='check_beds'),
    )

    def __repr__(self):
        return f'<Hospital {self.name}>'

class Ambulance(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    driver_name = db.Column(db.String(120), nullable=False)
    status = db.Column(db.String(20), nullable=False, default='idle')
    current_case_id = db.Column(db.Integer, db.ForeignKey('case.id'), nullable=True)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    current_latitude = db.Column(db.Float, nullable=True)
    current_longitude = db.Column(db.Float, nullable=True)

    def __repr__(self):
        return f'<Ambulance {self.id}>'

class Case(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    patient_name = db.Column(db.String(120), nullable=False)
    condition = db.Column(db.String(200), nullable=False)
    severity = db.Column(db.String(2), nullable=False)
    location = db.Column(db.String(200), nullable=False)
    ambulance_id = db.Column(db.Integer, db.ForeignKey('ambulance.id'), nullable=True)
    hospital_id = db.Column(db.Integer, db.ForeignKey('hospital.id'), nullable=True)
    eta = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    delay = db.Column(db.Boolean, default=False)

    __table_args__ = (
        CheckConstraint("severity IN ('P0', 'P1', 'P2', 'P3')", name='check_case_severity'),
    )

    ambulance = db.relationship('Ambulance', foreign_keys=[ambulance_id], lazy='joined')
    hospital = db.relationship('Hospital', foreign_keys=[hospital_id], lazy='joined')

    def __repr__(self):
        return f'<Case {self.id} ({self.patient_name})>'

class Logs(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey('case.id'), nullable=False)
    agent_name = db.Column(db.String(120), nullable=False)
    message = db.Column(db.Text, nullable=False)
    metadata = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())

    def __repr__(self):
        return f'<Log {self.id} (case={self.case_id}, agent={self.agent_name})>'
    
class Resource(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    hospital_id = db.Column(db.Integer, db.ForeignKey('hospital.id'), nullable=False)
    resource_type = db.Column(db.String(50), nullable=False)  # 'icu', 'ventilator', 'bed'
    total = db.Column(db.Integer, nullable=False)
    available = db.Column(db.Integer, nullable=False)  # tracks how many are unallocated
    status = db.Column(db.String(20), nullable=False)  # 'available', 'in_use', 'maintenance'
    last_updated = db.Column(db.DateTime, default=db.func.current_timestamp(), onupdate=db.func.current_timestamp())

    def __repr__(self):
        return f'<Resource {self.id} ({self.resource_type})>'

class Reserved(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey('case.id'), nullable=False)
    hospital_id = db.Column(db.Integer, db.ForeignKey('hospital.id'), nullable=False)
    type = db.Column(db.String(50), nullable=False)  # 'icu', 'ventilator', 'bed'
    quantity = db.Column(db.Integer, nullable=False)  # how many ICU beds, etc.
    status = db.Column(db.String(20), nullable=False)  # 'reserved', 'confirmed', 'cancelled'
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())

    def __repr__(self):
        return f'<Reserved case={self.case_id} hospital={self.hospital_id} type={self.type}>'