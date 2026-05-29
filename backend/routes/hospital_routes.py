import json
from datetime import datetime

from flask import Blueprint, jsonify, request, session
from ..models import Case, db, Hospital, Logs
hospital = Blueprint('hospital', __name__)

#get
@hospital.route('/get-cases/<hospital_id>', methods=['GET'])
def get_cases(hospital_id):

    if not hospital_id:
        return jsonify({"message": "hospital_id is required"}), 400
    role = session.get('role')
    if role not in ['hospital', 'admin']:
        return jsonify({"message": "Unauthorized"}), 403
    cases = Case.query.filter_by(hospital_id=hospital_id).all()
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
            "created_at":
            c.created_at.strftime(
                "%Y-%m-%d %H:%M:%S"
            ) if c.created_at else None,

            "delay": c.delay
        })
    return jsonify(res), 200

# post resources
@hospital.route('/resources/<hospital_id>', methods=['POST'])
def update_resources(hospital_id):
    route_hospital_id = int(hospital_id)
    role = session.get('role')
    user_id = session.get('user_id')
    user_hospital_id = session.get('hospital_id')

    if role not in ['hospital', 'admin']:
        return jsonify({"message": "Unauthorized"}), 403
    if role == 'hospital' and user_hospital_id != route_hospital_id:
        return jsonify({"message": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    hospital = Hospital.query.get(route_hospital_id)
    if not hospital:
        return jsonify({"message": "Hospital not found"}), 404

    old_values = {
        "icu_available": hospital.icu_available,
        "ventilators_available": hospital.ventilators_available,
        "beds_available": hospital.beds_available,
    }

    fields_changed = []
    if "icu_available" in data:
        hospital.icu_available = data["icu_available"]
        fields_changed.append("icu_available")
    if "ventilators_available" in data:
        hospital.ventilators_available = data["ventilators_available"]
        fields_changed.append("ventilators_available")
    if "beds_available" in data:
        hospital.beds_available = data["beds_available"]
        fields_changed.append("beds_available")
    
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating resources"}), 500

    new_values = {
        "icu_available": hospital.icu_available,
        "ventilators_available": hospital.ventilators_available,
        "beds_available": hospital.beds_available,
    }

    logs = Logs(
        case_id=None,
        agent_name="hospital_routes.update_resources",
        message=f"Hospital {route_hospital_id} resources updated",
        metadata=json.dumps({
            "user_id": user_id,
            "user_role": role,
            "hospital_id": route_hospital_id,
            "fields_changed": fields_changed,
            "old_values": old_values,
            "new_values": new_values,
            "timestamp": datetime.utcnow().isoformat(),
        }),
    )
    db.session.add(logs)
    db.session.commit()
    return jsonify({"message": "Resources updated successfully",
                    "hospital_id": hospital.id,
                    "icu_available": hospital.icu_available,
                    "ventilators_available": hospital.ventilators_available,
                    "beds_available": hospital.beds_available
                    }), 200


