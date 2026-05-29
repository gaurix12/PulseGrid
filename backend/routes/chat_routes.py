from flask import Blueprint, jsonify, request

from ..models import User
from ..langgraph.graph import EmergencyDispatchGraph
from ..langgraph.state import EmergencyState

chat = Blueprint('chat', __name__)


@chat.route('', methods=['POST'])
def chat_message():
    data = request.get_json(silent=True) or {}
    message = data.get('message')
    user_id = data.get('user_id')
    case_id = data.get('case_id')
    metadata = data.get('metadata') or {}

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

    if not message or not str(message).strip():
        return jsonify({"success": False, "message": "message is required"}), 400

    graph_runner = EmergencyDispatchGraph()
    compiled_graph = graph_runner.build_chat_graph()

    initial_state = EmergencyState(
        user_message=str(message).strip(),
        user_id=user_id,
        user_role=user_role,
        hospital_user_id=hospital_user_id,
        ambulance_user_id=ambulance_user_id,
        case_id=case_id,
        metadata=metadata if isinstance(metadata, dict) else {"value": metadata},
    )

    result = compiled_graph.invoke(initial_state)
    response_data = result.to_dict() if hasattr(result, 'to_dict') else result

    return jsonify({
        "success": response_data.get("error_message") is None,
        "data": response_data,
        "response": response_data.get("chat_response", ""),
    }), 200