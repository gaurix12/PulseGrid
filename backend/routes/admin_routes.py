from flask import Blueprint, jsonify, request
from ..models import Case, db, Hospital, User, Ambulance

admin = Blueprint('admin', __name__)

#get all cases
@admin.route('/get-all-cases', methods=['GET'])
def get_all_cases():
    cases = Case.query.all()
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
            "eta": c.eta,
            "created_at": c.created_at,
            "delay": c.delay
        })
    return jsonify(res), 200

#change case allocation to different hospital
@admin.route('/change-hosp/<case_id>', methods=['POST'])
def change_hospital(case_id):
    data = request.json()
    case = Case.query.get(case_id)
    if not case:
        return jsonify({"message": "Case not found"}), 404
    if "hospital_id" not in data:
        return jsonify({"message": "hospital_id is required"}), 400
    hospital = Hospital.query.get(data["hospital_id"])
    if not hospital:
        return jsonify({"message": "Hospital not found"}), 404
    case.hospital_id = data["hospital_id"]
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error changing hospital"}), 500
    return jsonify({"message": "Hospital changed successfully", "case_id": case.id, "hospital_id": case.hospital_id}), 200

#change case allocation to different ambulance
@admin.route('/change-ambulance/<case_id>', methods=['POST'])
def change_ambulance(case_id):
    data = request.json()
    case = Case.query.get(case_id)
    if not case:
        return jsonify({"message": "Case not found"}), 404
    if "ambulance_id" not in data:
        return jsonify({"message": "ambulance_id is required"}), 400
    ambulance = Ambulance.query.get(data["ambulance_id"])
    if not ambulance:
        return jsonify({"message": "Ambulance not found"}), 404
    case.ambulance_id = data["ambulance_id"]
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error changing ambulance"}), 500
    return jsonify({"message": "Ambulance changed successfully", "case_id": case.id, "ambulance_id": case.ambulance_id}), 200