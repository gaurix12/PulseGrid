from flask import Blueprint, jsonify, request, session
from backend.tools.langchain_tools import _required_specialty_for_condition
from ..tools.langchain_tools import invoke_tool
from ..models import Case, db, Hospital, User, Ambulance, Logs
from datetime import datetime
import json

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
            "status": c.status,
            "eta": c.eta,
            "created_at": c.created_at,
            "delay": c.delay
        })
    return jsonify(res), 200

#change case allocation to different hospital
@admin.route('/change-hosp/<case_id>', methods=['POST'])
def change_hospital(case_id):
    data = request.get_json(silent=True) or {}
    case = Case.query.get(case_id)

    if not case:
        return jsonify({"message": "Case not found"}), 404
    if "hospital_id" not in data:
        return jsonify({"message": "hospital_id is required"}), 400
    
    hospital = Hospital.query.get(data["hospital_id"])
    if not hospital:
        return jsonify({"message": "Hospital not found"}), 404
    
    required_speciality = _required_specialty_for_condition(case.condition)
    if required_speciality == "cardiology" and not hospital.has_cardiology:
        return jsonify({"message": "Hospital does not have required cardiology specialty for this case"}), 400
    if required_speciality == "trauma_care" and not hospital.has_trauma_care:
        return jsonify({"message": "Hospital does not have required trauma care specialty for this case"}), 400
    
    old_hospital_id = case.hospital_id
    
    case.hospital_id = data["hospital_id"]
    try:
        db.session.commit()
        user_id = session.get('user_id')
        log = Logs(
            case_id=case.id,
            agent_name='admin_override',
            message=f"Hospital assignment changed from {old_hospital_id} to {data['hospital_id']}",
            metadata=json.dumps({
                "old_hospital_id": old_hospital_id,
                "new_hospital_id": data["hospital_id"],
                "admin_user_id": user_id,
                "timestamp": datetime.utcnow().isoformat(),
                "required_specialty": required_speciality
            }, default=str),
        )
        db.session.add(log)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": f"Error changing hospital: {str(e)}"}), 500
    
    return jsonify({
        "message": "Hospital changed successfully",
        "case_id": case.id,
        "hospital_id": case.hospital_id
    }), 200

#change case allocation to different ambulance
@admin.route('/change-ambulance/<case_id>', methods=['POST'])
def change_ambulance(case_id):
    data = request.get_json(silent=True) or {}
    case = Case.query.get(case_id)
    if not case:
        return jsonify({"message": "Case not found"}), 404
    if "ambulance_id" not in data:
        return jsonify({"message": "ambulance_id is required"}), 400
    
    ambulance = Ambulance.query.get(data["ambulance_id"])
    if not ambulance:
        return jsonify({"message": "Ambulance not found"}), 404
    
    # Store old ambulance ID for audit log
    old_ambulance_id = case.ambulance_id
    
    # Use idempotent assign_ambulance_to_case tool to maintain referential integrity
    assignment_result = invoke_tool(
        "assign_ambulance_to_case",
        user_role="admin",
        ambulance_id=data["ambulance_id"],
        case_id=case.id,
    )
    
    if not assignment_result.get('success'):
        db.session.rollback()
        return jsonify({
            "message": "Failed to assign ambulance to case",
            "error": assignment_result.get('error', 'Unknown error')
        }), 400
    
    # Log the admin change with audit trail
    user_id = session.get('user_id')
    log = Logs(
        case_id=case.id,
        agent_name='admin_override',
        message=f"Ambulance assignment changed from {old_ambulance_id} to {data['ambulance_id']}",
        metadata=json.dumps({
            "old_ambulance_id": old_ambulance_id,
            "new_ambulance_id": data["ambulance_id"],
            "admin_user_id": user_id,
            "timestamp": datetime.utcnow().isoformat(),
            "assignment_result": assignment_result
        }, default=str),
    )
    db.session.add(log)
    db.session.commit()
    
    return jsonify({
        "message": "Ambulance changed successfully",
        "case_id": case.id,
        "ambulance_id": data["ambulance_id"]
    }), 200