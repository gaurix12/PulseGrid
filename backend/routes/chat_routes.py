from flask import Blueprint, jsonify, request, session
from ..langgraph.graph import EmergencyDispatchGraph
from ..langgraph.state import EmergencyState

chat = Blueprint('chat', __name__)


@chat.route('', methods=['POST'])
def chat_message():

    data = request.get_json(silent=True) or {}
    message = data.get('message')
    user_id = data.get('user_id')
    case_id = data.get('case_id')

    context = data.get('context') or {}
    metadata = data.get('metadata') or {}

    user_id = session.get('user_id')
    user_role = session.get('role')
    hospital_user_id = session.get('hospital_id')
    ambulance_user_id = session.get('ambulance_id')

    if not user_role:
        return jsonify({"success": False, "response": "Authentication required", "data": None}), 401

    if not hospital_user_id:
        hospital_user_id = context.get('current_hospital_id')
    if not ambulance_user_id:
        ambulance_user_id = context.get('current_ambulance_id')

    if not message or not str(message).strip():
        return jsonify({"success": False, "response": "message is required", "data": None}), 400

    enriched_metadata = {**metadata, **context}

    graph_runner = EmergencyDispatchGraph()
    compiled_graph = graph_runner.build_chat_graph()

    initial_state = EmergencyState(
        user_message=str(message).strip(),
        user_id=user_id,
        user_role=user_role,
        hospital_user_id=hospital_user_id,
        ambulance_user_id=ambulance_user_id,
        case_id=case_id,
        metadata=enriched_metadata if isinstance(enriched_metadata, dict) else {"value": enriched_metadata},
    )

    try:
        result = compiled_graph.invoke(initial_state)
        response_data = result.to_dict() if hasattr(result, 'to_dict') else result
    except Exception as e:
        return jsonify({
            "success": False,
            "response": f"Chat agent encountered an error: {str(e)}",
            "data": {
                "tool_used": None,
                "tool_args": None,
                "results": None,
                "reasoning": None,
                "chat_intent": None,
            }
        }), 500

    success = response_data.get("error_message") is None

    agent_metadata = response_data.get("metadata") or {}
    plan = agent_metadata.get("plan") or {}
    tool_result = agent_metadata.get("tool_result") or {}

    tool_used = plan.get("tool_name") or agent_metadata.get("tool_used")
    tool_args = plan.get("tool_args") or agent_metadata.get("tool_args")
    results = tool_result if tool_result else agent_metadata.get("results")
    reasoning = plan.get("reason") or agent_metadata.get("reasoning")

    return jsonify({
        "success": success,
        "response": response_data.get("chat_response", ""),
        "data": {
            "tool_used": tool_used,
            "tool_args": tool_args,
            "results": results,
            "reasoning": reasoning,
            "chat_intent": response_data.get("chat_intent"),
            "state": response_data if not success else None,
        }
    }), 200