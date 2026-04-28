from flask import Blueprint, jsonify, request
from ..models import Case, db, Hospital, User, Ambulance

setup = Blueprint('setup', __name__)

@setup.route('/hospital/setup', methods=['POST'])
def setup_hospital():
    data = request.get_json()
    if not data:
        return jsonify({"message": "No data provided"}), 400
    must = ["name", "location", "icu_available", "ventilators_available", "beds_available", "capacity"]
    for field in must:
        if field not in data:
            return jsonify({"message": f"Missing required field: {field}"}), 400
    new_hospital = Hospital(
        name=data.get('name'),
        location=data.get('location'),
        icu_available=data.get('icu_available'),
        ventilators_available=data.get('ventilators_available'),
        beds_available=data.get('beds_available'),
        capacity=data.get('capacity'),
        created_at=data.get('created_at')
    )

    db.session.add(new_hospital)
    db.session.commit()
    return jsonify({"message": "Hospital setup successfully", "hospital_id": new_hospital.id}), 201

@setup.route('/ambulance/setup', methods=['POST'])
def setup_ambulance():
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