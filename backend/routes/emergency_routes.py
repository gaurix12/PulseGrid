from flask import Blueprint, jsonify, request

from ..models import Case, User, db
from ..langgraph.graph import EmergencyDispatchGraph
from ..langgraph.state import EmergencyState
emergency = Blueprint('emergency', __name__)

@emergency.route('/dispatch', methods=['POST'])
@emergency.route('', methods=['POST'])
def emergency_flow():
    data = request.get_json(silent=True) or {}
    case_id = data.get('case_id')
    message = data.get('message')
    location = data.get('location')
    user_id = data.get('user_id')
    metadata = data.get('metadata')
    patient_name = data.get('patient_name')
    user_role = data.get('user_role')
    hospital_user_id = data.get('hospital_user_id')
    ambulance_user_id = data.get('ambulance_user_id')

    user = None
    if user_id is not None:
        user = User.query.get(user_id)
        if user:
            user_role = user.role
            hospital_user_id = user.hospital_id
            ambulance_user_id = user.ambulance_id

    existing_case = None
    if case_id is not None:
        existing_case = Case.query.get(case_id)
        if not existing_case:
            return jsonify({"success": False, "message": f"Case {case_id} not found"}), 404

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
    
    # Issue #12: Wrap workflow in transaction boundary with rollback on error
    try:
        res = compiled_graph.invoke(initial_state)
        response_data = res.to_dict() if hasattr(res, 'to_dict') else res
        error_message = response_data.get("error_message")
        
        # Check if workflow failed; if so, rollback
        if error_message:
            db.session.rollback()
            final_case = Case.query.get(response_data.get("case_id")) if response_data.get("case_id") else existing_case
            return jsonify({
                "success": False,
                "message": "Emergency workflow failed",
                "case_id": response_data.get("case_id"),
                "case_status": final_case.status if final_case else None,
                "workflow_status": response_data.get("workflow_status"),
                "chat_response": response_data.get("chat_response", ""),
                "error_message": error_message,
                "data": response_data,
            }), 500
        
        # Commit the transaction on success
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



