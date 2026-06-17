from flask import Blueprint, jsonify, request, session
from ..models import db, Case, Ambulance, Reserved, Resource, Hospital, Logs
from ..langgraph.graph import EmergencyDispatchGraph
from ..langgraph.state import EmergencyState
import json

case = Blueprint('case', __name__)


@case.route('/<int:case_id>/status', methods=['POST'])
def update_case_status(case_id):
    role = session.get('role')
    if role not in ['admin', 'hospital']:
        return jsonify({'success': False, 'message': 'Unauthorized'}), 403

    data = request.get_json(silent=True) or {}
    status = data.get('status')
    if not status:
        return jsonify({'success': False, 'message': 'status field is required'}), 400

    c = Case.query.get(case_id)
    if not c:
        return jsonify({'success': False, 'message': f'Case {case_id} not found'}), 404
    if role == 'hospital':
        user_hospital_id = session.get('hospital_id')
        if c.hospital_id != user_hospital_id:
            return jsonify({'success': False, 'message': 'Unauthorized – case belongs to a different hospital'}), 403

    try:
        old_status = c.status

        # If user requests transfer
        if status == 'failed_escalation' and old_status != 'failed_escalation':
            from ..tools.langchain_tools import transfer_case_to_another_hospital
            transfer_res = transfer_case_to_another_hospital(c)
            if not transfer_res.get('success'):
                c.status = 'failed_escalation'
                if c.ambulance_id:
                    ambulance = Ambulance.query.get(c.ambulance_id)
                    if ambulance and ambulance.status == 'assigned':
                        ambulance.status = 'idle'
                        ambulance.current_case_id = None

                reservations = Reserved.query.filter_by(case_id=c.id).filter(
                    Reserved.status != 'cancelled'
                ).all()
                for res in reservations:
                    resource = Resource.query.filter_by(
                        hospital_id=res.hospital_id,
                        resource_type=res.type
                    ).first()
                    if resource:
                        resource.available += res.quantity
                        hosp = Hospital.query.get(res.hospital_id)
                        if hosp:
                            if res.type == 'icu':
                                hosp.icu_available = min(hosp.icu_total, resource.available)
                            elif res.type == 'bed':
                                hosp.beds_available = min(hosp.beds_total, resource.available)
                            elif res.type == 'ventilator':
                                hosp.ventilators_available = min(hosp.ventilators_total, resource.available)
                    res.status = 'cancelled'

                cleanup_log = Logs(
                    case_id=c.id,
                    agent_name='case_status_update',
                    message=f"Case closed (failed_escalation - fallback): ambulance reset, {len(reservations)} reservations released",
                    metadata_json=json.dumps({
                        'old_status': old_status,
                        'new_status': 'failed_escalation',
                        'ambulance_id': c.ambulance_id,
                        'reservations_released': len(reservations),
                    })
                )
                db.session.add(cleanup_log)
        else:
            c.status = status
            CLOSED_STATUSES = ('discharged', 'resolved')
            if status in CLOSED_STATUSES and old_status not in CLOSED_STATUSES:
                if c.ambulance_id:
                    ambulance = Ambulance.query.get(c.ambulance_id)
                    if ambulance and ambulance.status == 'assigned':
                        ambulance.status = 'idle'
                        ambulance.current_case_id = None

                reservations = Reserved.query.filter_by(case_id=c.id).filter(
                    Reserved.status != 'cancelled'
                ).all()
                for res in reservations:
                    resource = Resource.query.filter_by(
                        hospital_id=res.hospital_id,
                        resource_type=res.type
                    ).first()
                    if resource:
                        resource.available += res.quantity
                        hosp = Hospital.query.get(res.hospital_id)
                        if hosp:
                            if res.type == 'icu':
                                hosp.icu_available = min(hosp.icu_total, resource.available)
                            elif res.type == 'bed':
                                hosp.beds_available = min(hosp.beds_total, resource.available)
                            elif res.type == 'ventilator':
                                hosp.ventilators_available = min(hosp.ventilators_total, resource.available)
                    res.status = 'cancelled'

                cleanup_log = Logs(
                    case_id=c.id,
                    agent_name='case_status_update',
                    message=f"Case closed ({status}): ambulance reset, {len(reservations)} reservations released",
                    metadata_json=json.dumps({
                        'old_status': old_status,
                        'new_status': status,
                        'ambulance_id': c.ambulance_id,
                        'reservations_released': len(reservations),
                    })
                )
                db.session.add(cleanup_log)

        db.session.commit()
    except ValueError as ve:
        db.session.rollback()
        return jsonify({'success': False, 'message': str(ve)}), 400
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'message': f'Error updating status: {str(e)}'}), 500

    return jsonify({
        'success': True,
        'message': f'Case {case_id} status updated to {status}',
        'data': c.to_dict()
    }), 200


@case.route('/create', methods=['POST'])
def create_case():
    role = session.get('role')
    if not role:
        return jsonify({"message": "Authentication required"}), 401
    if role != 'admin':
        return jsonify({"message": "Admin access required to create cases"}), 403
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

    try:
        result = compiled_graph.invoke(initial_state)
        response_data = result.to_dict() if hasattr(result, 'to_dict') else result

        if response_data.get("error_message"):
            db.session.rollback()
            return jsonify({
                "message": "Case workflow failed",
                "case_id": response_data.get("case_id"),
                "status": response_data.get("case_status"),
                "error": response_data.get("error_message"),
                "data": response_data,
            }), 500

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