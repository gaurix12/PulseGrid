from flask import Blueprint, jsonify, request
from ..models import Case, db, Ambulance, Hospital

ambulance = Blueprint('ambulance', __name__)

#get assigned cases
@ambulance.route('/get-assigned-cases/<ambulance_id>', methods=['GET'])
def get_cases(ambulance_id):
    if not ambulance_id:
        return jsonify({"message": "ambulance_id is required"}), 400
    cases = Case.query.filter_by(ambulance_id=ambulance_id).all()
    res=[]
    for c in cases:
        res.append({
            "id": c.id,
            "patient_name": c.patient_name,
            "condition": c.condition,
            "severity": c.severity,
            "location": c.location,
            "ambulance_id": c.ambulance_id,
            "hospital_id": c.hospital_id,
            "status": c.status,
            "eta": c.eta,
            "created_at": c.created_at,
            "delay": c.delay
        })
    return jsonify(res), 200

# update status
@ambulance.route('/update-status/<ambulance_id>', methods=['POST'])
def update_status(ambulance_id):
    data= request.get_json()
    ambulance = Ambulance.query.get(ambulance_id)
    if not ambulance:
        return jsonify({"message": "Ambulance not found"}), 404
    if "status" in data:
        if data["status"] not in ['idle', 'en_route', 'at_hospital']:
            return jsonify({"message": "Invalid status value. Must be one of: idle, en_route, at_hospital"}), 400
        ambulance.status = data["status"]
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating status"}), 500
    return jsonify({"message": "Status updated successfully", "ambulance_id": ambulance.id,"status":ambulance.status}), 200

#update location
@ambulance.route('/update-location/<ambulance_id>', methods=['POST'])
def update_location(ambulance_id):
    data = request.get_json(silent=True) or {}
    ambulance = Ambulance.query.get(ambulance_id)
    if not ambulance:
        return jsonify({"message": "Ambulance not found"}), 404
    if "current_latitude" in data and "current_longitude" in data:
        ambulance.current_latitude = data["current_latitude"]
        ambulance.current_longitude = data["current_longitude"]
    else:
        return jsonify({"message": "current_latitude and current_longitude are required"}), 400
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating location"}), 500
    return jsonify({"message": "Location updated successfully", "ambulance_id": ambulance.id,"current_latitude":ambulance.current_latitude, "current_longitude":ambulance.current_longitude}), 200