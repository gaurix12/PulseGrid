from flask import Blueprint, jsonify, request
from ..models import Case, db, Hospital
hospital = Blueprint('hospital', __name__)

#get
@hospital.route('/get-cases/<hospital_id>', methods=['GET'])
def get_cases(hospital_id):
    if not hospital_id:
        return jsonify({"message": "hospital_id is required"}), 400
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
            "eta": c.eta,
            "created_at": c.created_at,
            "delay": c.delay
        })
    return jsonify(res), 200

# post resources
@hospital.route('/resources/<hospital_id>', methods=['POST'])
def update_resources(hospital_id):
    data = request.get_json()
    hospital = Hospital.query.get(hospital_id)
    if not hospital:
        return jsonify({"message": "Hospital not found"}), 404
    if "icu_available" in data:
        hospital.icu_available = data["icu_available"]
    if "ventilators_available" in data:
        hospital.ventilators_available = data["ventilators_available"]
    if "beds_available" in data:
        hospital.beds_available = data["beds_available"]
    
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating resources"}), 500
    
    return jsonify({"message": "Resources updated successfully",
                    "hospital_id": hospital.id,
                    "icu_available": hospital.icu_available,
                    "ventilators_available": hospital.ventilators_available,
                    "beds_available": hospital.beds_available
                    }), 200


