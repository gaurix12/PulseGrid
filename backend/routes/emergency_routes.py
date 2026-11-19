from flask import Blueprint, jsonify, request, session
from ..models import Ambulance, Case, Reserved, Resource, Hospital, User, db
from ..langgraph.graph import EmergencyDispatchGraph
from ..langgraph.state import EmergencyState
emergency = Blueprint('emergency', __name__)

@emergency.route('/dispatch', methods=['POST'])
@emergency.route('', methods=['POST'])
def emergency_flow():
    session_role = session.get('role')
    if not session_role:
        return jsonify({"success": False, "message": "Authentication required"}), 401

    data = request.get_json(silent=True) or {}
    case_id = data.get('case_id')
    message = data.get('message')
    location = data.get('location')
    metadata = data.get('metadata')
    patient_name = data.get('patient_name')

    user_id = session.get('user_id')
    user_role = session_role
    hospital_user_id = session.get('hospital_id')
    ambulance_user_id = session.get('ambulance_id')

    user = None
    if user_id is not None:
        user = User.query.get(user_id)

    existing_case = None
    if case_id is not None:
        existing_case = Case.query.get(case_id)
        if not existing_case:
            return jsonify({"success": False, "message": f"Case {case_id} not found"}), 404
        if session_role == 'hospital' and existing_case.hospital_id != hospital_user_id:
            return jsonify({"success": False, "message": "Hospital users can only dispatch cases assigned to their hospital"}), 403
        if session_role == 'ambulance' and existing_case.ambulance_id != ambulance_user_id:
            return jsonify({"success": False, "message": "Ambulance users can only dispatch cases assigned to their ambulance"}), 403
    elif session_role != 'admin':
        return jsonify({"success": False, "message": "Only admins can create and dispatch a new case"}), 403

    if not existing_case and (not message or not location):
        return jsonify({"success": False, "message": "message and location are required when case_id is not provided"}), 400

    if existing_case:
        patient_name = patient_name or existing_case.patient_name
        location = location or existing_case.location
        message = message or existing_case.condition

    graph_runner = EmergencyDispatchGraph()
    compiled_graph = graph_runner.build_graph()
    initial_state = EmergencyState(
        patient_name=patient_name or "Unknown Patient",
        patient_details=str(message).strip(),
        user_message=message,
        user_id=user_id,
        user_role=user_role,
        hospital_user_id=hospital_user_id,
        ambulance_user_id=ambulance_user_id,
        location=location,
        case_id=existing_case.id if existing_case else None,
        metadata=metadata if isinstance(metadata, dict) else {"value": metadata},
    )
    
    try:
        res = compiled_graph.invoke(initial_state)
        response_data = res.to_dict() if hasattr(res, 'to_dict') else res
        error_message = response_data.get("error_message")
        
        # Check if workflow failed; if so, cleanup resources
        if error_message:
            db.session.rollback()
            final_case = Case.query.get(response_data.get("case_id")) if response_data.get("case_id") else existing_case

            # Cleanup: reset ambulance and release resources on failure
            if final_case:
                if final_case.ambulance_id:
                    amb = Ambulance.query.get(final_case.ambulance_id)
                    if amb and amb.status == 'assigned':
                        amb.status = 'idle'
                        amb.current_case_id = None
                reservations = Reserved.query.filter_by(case_id=final_case.id).filter(
                    Reserved.status != 'cancelled'
                ).all()
                for r in reservations:
                    res = Resource.query.filter_by(hospital_id=r.hospital_id, resource_type=r.type).first()
                    if res:
                        res.available += r.quantity
                        hosp = Hospital.query.get(r.hospital_id)
                        if hosp:
                            if r.type == 'icu': hosp.icu_available = min(hosp.icu_total, res.available)
                            elif r.type == 'bed': hosp.beds_available = min(hosp.beds_total, res.available)
                            elif r.type == 'ventilator': hosp.ventilators_available = min(hosp.ventilators_total, res.available)
                    r.status = 'cancelled'
                db.session.commit()

            return jsonify({
                "success": False,
                "message": "Emergency workflow completed with issues",
                "case_id": response_data.get("case_id"),
                "case_status": final_case.status if final_case else None,
                "workflow_status": response_data.get("workflow_status"),
                "chat_response": response_data.get("chat_response", ""),
                "error_message": error_message,
                "data": response_data,
            }), 200
        
        db.session.commit()
        final_case = Case.query.get(response_data.get("case_id")) if response_data.get("case_id") else existing_case
        return jsonify({
            "success": True,
            "message": "Emergency workflow executed",
            "case_id": response_data.get("case_id"),
            "case_status": final_case.status if final_case else None,
            "workflow_status": response_data.get("workflow_status"),
            "chat_response": response_data.get("chat_response", ""),
            "error_message": error_message,
            "data": response_data,
        }), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({
            "success": False,
            "message": "Emergency workflow encountered an error",
            "error_message": str(e),
        }), 500


