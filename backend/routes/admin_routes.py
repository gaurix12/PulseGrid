from flask import Blueprint, jsonify, request, session
from ..tools.langchain_tools import invoke_tool
from ..tools.langchain_tools import _required_specialty_for_condition
from ..models import Case, db, Hospital, Ambulance, Logs, Reserved
from datetime import datetime
import json

admin = Blueprint('admin', __name__)

#get all cases
@admin.route('/get-all-cases', methods=['GET'])
def get_all_cases():
    role = session.get('role')
    if not role:
        return jsonify({"message": "Authentication required"}), 401
    if role == 'hospital':
        hosp_id = session.get('hospital_id')
        cases = Case.query.filter_by(hospital_id=hosp_id).all() if hosp_id else []
    elif role == 'ambulance':
        amb_id = session.get('ambulance_id')
        cases = Case.query.filter_by(ambulance_id=amb_id).all() if amb_id else []
    elif role == 'admin':
        cases = Case.query.all()
    else:
        return jsonify({"message": "Unauthorized"}), 403

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
    role = session.get('role')
    if role != 'admin':
        return jsonify({"message": "Admin access required"}), 403
    data = request.get_json(silent=True) or {}
    
    if "hospital_id" not in data:
        return jsonify({"message": "hospital_id is required"}), 400
    
    try:
        # Re-use the transaction-safe invoke_tool pattern to guarantee atomic resource migration
        result = invoke_tool(
            "update_case_data",
            user_role="admin",
            case_id=int(case_id),
            hospital_id=int(data["hospital_id"])
        )
        if not result.get('success'):
            return jsonify({"message": result.get('error', 'Failed to change hospital')}), 400
        
        return jsonify({
            "message": "Hospital changed successfully",
            "case_id": int(case_id),
            "hospital_id": int(data["hospital_id"])
        }), 200
    except Exception as e:
        return jsonify({"message": f"Error changing hospital: {str(e)}"}), 500

#change case allocation to different ambulance
@admin.route('/change-ambulance/<case_id>', methods=['POST'])
def change_ambulance(case_id):
    role = session.get('role')
    if role != 'admin':
        return jsonify({"message": "Admin access required"}), 403
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
    
    user_id = session.get('user_id')
    log = Logs(
        case_id=case.id,
        agent_name='admin_override',
        message=f"Ambulance assignment changed from {old_ambulance_id} to {data['ambulance_id']}",
        metadata_json=json.dumps({
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

# clear failed cases
@admin.route('/clear-failed-cases', methods=['POST', 'DELETE'])
def clear_failed_cases():
    role = session.get('role')
    if role != 'admin':
        return jsonify({"message": "Admin access required"}), 403
    
    try:
        failed_cases = Case.query.filter_by(status='failed_escalation').all()
        failed_case_ids = [c.id for c in failed_cases]
        
        if not failed_cases:
            return jsonify({"message": "No failed cases found to clear", "cleared_count": 0}), 200
        
        for case_obj in failed_cases:
            if case_obj.ambulance_id:
                amb = Ambulance.query.get(case_obj.ambulance_id)
                if amb and (amb.current_case_id == case_obj.id or amb.status == 'assigned'):
                    amb.status = 'idle'
                    amb.current_case_id = None
        # delete logs and reserved resources
        Reserved.query.filter(Reserved.case_id.in_(failed_case_ids)).delete(synchronize_session=False)
        
        Logs.query.filter(Logs.case_id.in_(failed_case_ids)).delete(synchronize_session=False)
        
        deleted_count = Case.query.filter(Case.id.in_(failed_case_ids)).delete(synchronize_session=False)
        
        db.session.commit()
        return jsonify({
            "message": f"Successfully cleared {deleted_count} failed cases and associated records.",
            "cleared_count": deleted_count
        }), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": f"Error clearing failed cases: {str(e)}"}), 500