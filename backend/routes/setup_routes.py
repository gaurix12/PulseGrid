from flask import Blueprint, jsonify, request, session
from ..models import Case, db, Hospital, User, Ambulance, Resource

setup = Blueprint('setup', __name__)


def _require_admin():
    role = session.get('role')
    if not role:
        return jsonify({"message": "Authentication required"}), 401
    if role != 'admin':
        return jsonify({"message": "Admin access required"}), 403
    return None


@setup.route('/hospital/setup', methods=['POST'])
def setup_hospital():
    auth_error = _require_admin()
    if auth_error:
        return auth_error
    data = request.get_json()
    if not data:
        return jsonify({"message": "No data provided"}), 400
    must = ["name", "location", "icu_available", "ventilators_available", "beds_available", "capacity", "has_cardiology", "has_trauma_care", "longitude"]
    for field in must:
        if field not in data:
            return jsonify({"message": f"Missing required field: {field}"}), 400
    if "latitude" not in data and "lattitude" not in data:
        return jsonify({"message": "Missing required field: latitude"}), 400

    new_hospital = Hospital(
        name=data.get('name'),
        location=data.get('location'),
        icu_available=data.get('icu_available'),
        icu_total=data.get('icu_total', data.get('icu_available')),
        ventilators_available=data.get('ventilators_available'),
        ventilators_total=data.get('ventilators_total', data.get('ventilators_available')),
        beds_available=data.get('beds_available'),
        beds_total=data.get('beds_total', data.get('beds_available')),
        capacity=data.get('capacity'),
        current_patients=data.get('current_patients', 0),
        created_at=data.get('created_at'),
        has_cardiology = data.get('has_cardiology'),
        has_trauma_care = data.get('has_trauma_care'),
        latitude = data.get('latitude') if 'latitude' in data else data.get('lattitude'),
        longitude = data.get('longitude')
    )

    db.session.add(new_hospital)
    db.session.commit()

    for rtype, count in [('bed', new_hospital.beds_available), ('icu', new_hospital.icu_available), ('ventilator', new_hospital.ventilators_available)]:
        res = Resource(
            hospital_id=new_hospital.id,
            resource_type=rtype,
            total=count,
            available=count,
            status='available'
        )
        db.session.add(res)
    db.session.commit()

    return jsonify({"message": "Hospital setup successfully", "hospital_id": new_hospital.id}), 201

@setup.route('/ambulance/setup', methods=['POST'])
def setup_ambulance():
    auth_error = _require_admin()
    if auth_error:
        return auth_error
    data = request.get_json()
    if not data:
        return jsonify({"message": "No data provided"}), 400
    must = ["driver_name", "status"]
    for field in must:
        if field not in data:
            return jsonify({"message": f"Missing required field: {field}"}), 400
        if data.get('status') not in ['idle', 'en_route', 'at_hospital']:
            return jsonify({"message": "Invalid status value. Must be one of: idle, en_route, at_hospital"}), 400
    new_ambulance = Ambulance(
        driver_name=data.get('driver_name'),
        status=data.get('status'),
        created_at=data.get('created_at')
    )
    db.session.add(new_ambulance)
    db.session.commit()
    return jsonify ({"message": "Ambulance setup successfully", "ambulance_id": new_ambulance.id}), 201