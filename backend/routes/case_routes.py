from flask import Blueprint, jsonify, request
from ..models import db
from ..langgraph.graph import EmergencyDispatchGraph
from ..langgraph.state import EmergencyState

case = Blueprint('case', __name__)

# create emergency case
@case.route('/create', methods=['POST'])
def create_case():
    data = request.get_json(silent=True) or {}
    if not data:
        return jsonify({"message": "No data provided"}), 400
    must = ["patient_name", "condition", "severity", "location"]
    for field in must:
        if field not in data:
            return jsonify({"message": f"Missing required field: {field}"}), 400

    graph_runner = EmergencyDispatchGraph()
    compiled_graph = graph_runner.build_graph()
    initial_state = EmergencyState(
        patient_name=data.get('patient_name'),
        patient_details=data.get('condition') or data.get('patient_details') or data.get('message') or data.get('condition'),
        condition=data.get('condition'),
        severity=data.get('severity'),
        location=data.get('location'),
        user_message=data.get('message') or data.get('condition'),
        metadata=data.get('metadata') if isinstance(data.get('metadata'), dict) else {"value": data.get('metadata')},
    )
    
    # Issue #12: Wrap workflow in transaction boundary with rollback on error
    try:
        result = compiled_graph.invoke(initial_state)
        response_data = result.to_dict() if hasattr(result, 'to_dict') else result
        
        # Check if workflow failed; if so, rollback
        if response_data.get("error_message"):
            db.session.rollback()
            return jsonify({
                "message": "Case workflow failed",
                "case_id": response_data.get("case_id"),
                "status": response_data.get("case_status"),
                "error": response_data.get("error_message"),
                "data": response_data,
            }), 500
        
        # Commit the transaction on success
        db.session.commit()
        return jsonify({
            "message": "Case workflow executed",
            "case_id": response_data.get("case_id"),
            "status": response_data.get("case_status"),
            "data": response_data,
        }), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({
            "message": "Case workflow encountered an error",
            "error": str(e),
        }), 500