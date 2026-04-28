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

class Ambulance(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    driver_name = db.Column(db.String(120), nullable=False)
    status = db.Column(db.String(20), nullable=False, default='idle')
    current_case_id = db.Column(db.Integer, db.ForeignKey('case.id'), nullable=True)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())

class Case(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    patient_name = db.Column(db.String(120), nullable=False)
    condition = db.Column(db.String(200), nullable=False)
    severity = db.Column(db.Integer, nullable=False)  
    location = db.Column(db.String(200), nullable=False)
    ambulance_id = db.Column(db.Integer, db.ForeignKey('ambulance.id'), nullable=True)
    hospital_id = db.Column(db.Integer, db.ForeignKey('hospital.id'), nullable=True)
    eta = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    delay = db.Column(db.Boolean, default=False)

class Logs(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    case_id = db.Column(db.Integer, db.ForeignKey('case.id'), nullable=False)
    agent_name = db.Column(db.String(120), nullable=False)
    message = db.Column(db.Text, nullable=False)
    metadata = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=db.func.current_timestamp())
    
    
    def __repr__(self):
        return f'<Hospital {self.name}>'