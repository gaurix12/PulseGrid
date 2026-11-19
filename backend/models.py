from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import CheckConstraint, UniqueConstraint, event
from sqlalchemy.orm import validates
from datetime import datetime
from .utils.h3 import compute_h3_from_location, compute_h3_index
db = SQLAlchemy()

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.Text, nullable=False)
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
    h3_index = db.Column(db.String(20), nullable=True, index=True)
    phone_number = db.Column(db.String(30), nullable=True)
    contact_email = db.Column(db.String(120), nullable=True)

    __table_args__ = (
        CheckConstraint('current_patients <= capacity', name='check_capacity'),
        CheckConstraint('icu_available <= icu_total', name='check_icu'),
        CheckConstraint('ventilators_available <= ventilators_total', name='check_ventilators'),
        CheckConstraint('beds_available <= beds_total', name='check_beds'),
    )

    def __repr__(self):
        return f'<Hospital {self.name}>'

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'location': self.location,
            'capacity': self.capacity,
            'current_patients': self.current_patients,
            'beds_total': self.beds_total,
            'beds_available': self.beds_available,
            'icu_total': self.icu_total,
            'icu_available': self.icu_available,
            'ventilators_total': self.ventilators_total,
            'ventilators_available': self.ventilators_available,
            'has_cardiology': self.has_cardiology,
            'has_trauma_care': self.has_trauma_care,
            'latitude': self.latitude,
            'longitude': self.longitude,
            'h3_index': self.h3_index,
            'phone_number': self.phone_number,
            'contact_email': self.contact_email,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }

class Ambulance(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    driver_name = db.Column(db.String(120), nullable=False)
    status = db.Column(db.String(20), nullable=False, default='idle')
    current_case_id = db.Column(db.Integer, db.ForeignKey('case.id'), nullable=True)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    current_latitude = db.Column(db.Float, nullable=True)
    current_longitude = db.Column(db.Float, nullable=True)
    h3_index = db.Column(db.String(20), nullable=True, index=True)
    __table_args__ = (
        UniqueConstraint('current_case_id', name='unique_current_case'),
    )

    def __repr__(self):
        return f'<Ambulance {self.id}>'

    def to_dict(self):
        """Canonical serialization used by GET /ambulances."""
        return {
            'id': self.id,
            'driver_name': self.driver_name,
            'status': self.status,
            'current_case_id': self.current_case_id,
            'current_latitude': self.current_latitude,
            'current_longitude': self.current_longitude,
            'h3_index': self.h3_index,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }

class Case(db.Model):
    VALID_STATUSES = {
        "created",           # Initial state
        "triaged",          # After triage assessment
        "dispatched",       # After ambulance dispatch
        "arrived",          # After hospital selection/arrived
        "resolved",         # After resource allocation
        "alerts_sent",      # After alerts sent
        "discharged",       # Final success state
        "failed_escalation", # Final failure state
    }
    
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
    status = db.Column(db.String(20), nullable=False, default='created')  
    h3_index = db.Column(db.String(20), nullable=True, index=True)

    __table_args__ = (
        CheckConstraint("severity IN ('P0', 'P1', 'P2', 'P3')", name='check_case_severity'),
    )

    ambulance = db.relationship('Ambulance', foreign_keys=[ambulance_id], lazy='joined')
    hospital = db.relationship('Hospital', foreign_keys=[hospital_id], lazy='joined')

    @validates('status')
    def validate_status(self, key, status):
        """Enforce valid status transitions via FSM validator."""
        if status not in self.VALID_STATUSES:
            raise ValueError(f"Invalid case status: {status}. Must be one of {self.VALID_STATUSES}")
        
        old_status = getattr(self, 'status', None)
        if old_status and old_status != status:
            allowed = {
                'created': {'triaged', 'dispatched', 'failed_escalation'},
                'triaged': {'dispatched', 'resolved', 'failed_escalation'},
                'dispatched': {'arrived', 'resolved', 'failed_escalation'},
                'arrived': {'resolved', 'failed_escalation'},
                'resolved': {'discharged', 'failed_escalation', 'alerts_sent'},
                'alerts_sent': {'discharged', 'resolved', 'failed_escalation', 'arrived'},
                'discharged': set(), # Terminus states - no outgoing transitions
                'failed_escalation': {'resolved'}, # Transitions to resolved on successful transfer
            }
            allowed_next = allowed.get(old_status, set())
            if status not in allowed_next:
                raise ValueError(f"Invalid status transition from '{old_status}' to '{status}'")

        return status

    def __repr__(self):
        return f'<Case {self.id} ({self.patient_name})>'

    def to_dict(self):
        return {
            'id': self.id,
            'patient_name': self.patient_name,
            'condition': self.condition,
            'severity': self.severity,
            'location': self.location,
            'h3_index': self.h3_index,
            'ambulance_id': self.ambulance_id,
            'hospital_id': self.hospital_id,
            'status': self.status,
            'eta': self.eta,
            'delay': self.delay,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }

class Logs(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey('case.id'), nullable=True)
    agent_name = db.Column(db.String(120), nullable=False)
    message = db.Column(db.Text, nullable=False)
    # Preserve the existing physical column name for PostgreSQL compatibility.
    metadata_json = db.Column('log_metadata', db.Text, nullable=True)
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

    __table_args__ = (
        CheckConstraint('available >= 0', name='check_resource_available'),
        CheckConstraint('available <= total', name='check_resource_total'),
    )

    def __repr__(self):
        return f'<Resource {self.id} ({self.resource_type})>'

class Reserved(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey('case.id', ondelete='CASCADE'), nullable=False)
    hospital_id = db.Column(db.Integer, db.ForeignKey('hospital.id'), nullable=False)
    type = db.Column(db.String(50), nullable=False)  # 'icu', 'ventilator', 'bed'
    quantity = db.Column(db.Integer, nullable=False)  # how many ICU beds, etc.
    status = db.Column(db.String(20), nullable=False)  # 'reserved', 'confirmed', 'cancelled'
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())


    def __repr__(self):
        return f'<Reserved case={self.case_id} hospital={self.hospital_id} type={self.type}>'


@event.listens_for(Hospital, "before_insert")
@event.listens_for(Hospital, "before_update")
def update_hospital_h3_index(mapper, connection, target):
    target.h3_index = compute_h3_index(target.latitude, target.longitude)


@event.listens_for(Ambulance, "before_insert")
@event.listens_for(Ambulance, "before_update")
def update_ambulance_h3_index(mapper, connection, target):
    target.h3_index = compute_h3_index(
        target.current_latitude,
        target.current_longitude,
    )


@event.listens_for(Case, "before_insert")
@event.listens_for(Case, "before_update")
def update_case_h3_index(mapper, connection, target):
    target.h3_index = compute_h3_from_location(target.location)
