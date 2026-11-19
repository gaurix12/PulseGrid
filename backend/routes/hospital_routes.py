import json
from datetime import datetime

from flask import Blueprint, jsonify, request, session
from ..models import Ambulance, Case, db, Hospital, Logs, Reserved, Resource, User

hospital = Blueprint('hospital', __name__)

#hospital setup
@hospital.route('/profile', methods=['POST'])
def create_hospital_profile():
    role = session.get('role')
    user_id = session.get('user_id')
    if role != 'hospital' or not user_id:
        return jsonify({'success': False, 'message': 'Only hospital users can create a hospital profile'}), 403

    user = User.query.get(user_id)
    if not user:
        return jsonify({'success': False, 'message': 'User not found'}), 404
    if user.hospital_id:
        return jsonify({'success': False, 'message': 'You already have a hospital profile'}), 400

    data = request.get_json(silent=True) or {}
    required = ['name', 'location', 'capacity', 'beds_available', 'beds_total',
                'icu_available', 'icu_total', 'ventilators_available', 'ventilators_total']
    for field in required:
        if field not in data or data[field] is None:
            return jsonify({'success': False, 'message': f'Missing required field: {field}'}), 400

    try:
        new_hospital = Hospital(
            name=data['name'],
            location=data['location'],
            capacity=int(data['capacity']),
            current_patients=int(data.get('current_patients', 0)),
            beds_available=int(data['beds_available']),
            beds_total=int(data['beds_total']),
            icu_available=int(data['icu_available']),
            icu_total=int(data['icu_total']),
            ventilators_available=int(data['ventilators_available']),
            ventilators_total=int(data['ventilators_total']),
            has_cardiology=bool(data.get('has_cardiology', False)),
            has_trauma_care=bool(data.get('has_trauma_care', False)),
            latitude=float(data['latitude']) if data.get('latitude') else None,
            longitude=float(data['longitude']) if data.get('longitude') else None,
            phone_number=data.get('phone_number'),
            contact_email=data.get('contact_email'),
        )
        db.session.add(new_hospital)
        db.session.flush()  

        for rtype, total_key, avail_key in [
            ('icu', 'icu_total', 'icu_available'),
            ('ventilator', 'ventilators_total', 'ventilators_available'),
            ('bed', 'beds_total', 'beds_available'),
        ]:
            db.session.add(Resource(
                hospital_id=new_hospital.id,
                resource_type=rtype,
                total=int(data[total_key]),
                available=int(data[avail_key]),
                status='available',
            ))
        # user->hosp id
        user.hospital_id = new_hospital.id
        db.session.commit()

        session['hospital_id'] = new_hospital.id

        return jsonify({
            'success': True,
            'message': 'Hospital profile created',
            'hospital': new_hospital.to_dict(),
            'user': {
                'id': user.id,
                'username': user.username,
                'email': user.email,
                'role': user.role,
                'hospital_id': user.hospital_id,
                'ambulance_id': user.ambulance_id,
            }
        }), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'message': str(e)}), 500


@hospital.route('', methods=['GET'])
def list_hospitals():
    role = session.get('role')
    if not role:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401
    if role == 'hospital':
        hosp_id = session.get('hospital_id')
        hospitals = Hospital.query.filter_by(id=hosp_id).all() if hosp_id else []
    elif role in ('admin',):
        hospitals = Hospital.query.order_by(Hospital.id).all()
    else:
        amb_id = session.get('ambulance_id')
        if amb_id:
            cases = Case.query.filter_by(ambulance_id=amb_id).all()
            hosp_ids = {c.hospital_id for c in cases if c.hospital_id is not None}
            hospitals = Hospital.query.filter(Hospital.id.in_(hosp_ids)).all() if hosp_ids else []
        else:
            hospitals = []
    return jsonify({
        'success': True,
        'data': [h.to_dict() for h in hospitals]
    }), 200


@hospital.route('/<int:hospital_id>', methods=['GET'])
def get_hospital(hospital_id):
    role = session.get('role')
    if not role:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401
    if role == 'hospital':
        user_hospital_id = session.get('hospital_id')
        if user_hospital_id != hospital_id:
            return jsonify({'success': False, 'message': 'Unauthorized'}), 403

    h = Hospital.query.get(hospital_id)
    if not h:
        return jsonify({'success': False, 'message': 'Hospital not found'}), 404
    return jsonify({'success': True, 'data': h.to_dict()}), 200


@hospital.route('/get-cases/<hospital_id>', methods=['GET'])
def get_cases(hospital_id):
    try:
        route_hospital_id = int(hospital_id)
    except (TypeError, ValueError):
        return jsonify({"message": "hospital_id must be an integer"}), 400

    role = session.get('role')
    if role not in ['hospital', 'admin']:
        return jsonify({"message": "Unauthorized"}), 403
    if role == 'hospital' and session.get('hospital_id') != route_hospital_id:
        return jsonify({"message": "Unauthorized"}), 403
    cases = Case.query.filter_by(hospital_id=route_hospital_id).all()
    res = []
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
            "created_at": c.created_at.strftime("%Y-%m-%d %H:%M:%S") if c.created_at else None,
            "delay": c.delay
        })
    return jsonify(res), 200


@hospital.route('/resources/<hospital_id>', methods=['GET', 'POST', 'PUT'])
def update_resources(hospital_id):
    route_hospital_id = int(hospital_id)
    role = session.get('role')
    user_id = session.get('user_id')
    user_hospital_id = session.get('hospital_id')

    if role not in ['hospital', 'admin']:
        return jsonify({"message": "Unauthorized"}), 403
    if role == 'hospital' and user_hospital_id != route_hospital_id:
        return jsonify({"message": "Unauthorized"}), 403

    hospital_entry = Hospital.query.get(route_hospital_id)
    if not hospital_entry:
        return jsonify({"message": "Hospital not found"}), 404

    if request.method == 'GET':
        return jsonify({
            "success": True,
            "hospital_id": hospital_entry.id,
            "name": hospital_entry.name,
            "beds_available": hospital_entry.beds_available,
            "beds_total": hospital_entry.beds_total,
            "icu_available": hospital_entry.icu_available,
            "icu_total": hospital_entry.icu_total,
            "ventilators_available": hospital_entry.ventilators_available,
            "ventilators_total": hospital_entry.ventilators_total
        }), 200

    data = request.get_json(silent=True) or {}
    old_values = {
        "icu_available": hospital_entry.icu_available,
        "ventilators_available": hospital_entry.ventilators_available,
        "beds_available": hospital_entry.beds_available,
    }

    fields_changed = []
    
    resource_type = data.get('resource_type')
    quantity_change = data.get('quantity_change')
    absolute_value = data.get('absolute_value')
    total_value = data.get('total_value')
    
    if resource_type and (quantity_change is not None or absolute_value is not None or total_value is not None):
        try:
            r_type = resource_type.strip().lower()
            if r_type in {'bed', 'beds'}:
                if absolute_value is not None:
                    hospital_entry.beds_available = max(0, int(absolute_value))
                elif quantity_change is not None:
                    hospital_entry.beds_available = max(0, (hospital_entry.beds_available or 0) + int(quantity_change))
                
                if total_value is not None:
                    hospital_entry.beds_total = max(hospital_entry.beds_available, int(total_value))
                else:
                    hospital_entry.beds_total = max(hospital_entry.beds_available, hospital_entry.beds_total or 0)
                    
                fields_changed.append("beds_available")

            elif r_type == 'icu':
                if absolute_value is not None:
                    hospital_entry.icu_available = max(0, int(absolute_value))
                elif quantity_change is not None:
                    hospital_entry.icu_available = max(0, (hospital_entry.icu_available or 0) + int(quantity_change))
                
                if total_value is not None:
                    hospital_entry.icu_total = max(hospital_entry.icu_available, int(total_value))
                else:
                    hospital_entry.icu_total = max(hospital_entry.icu_available, hospital_entry.icu_total or 0)
                    
                fields_changed.append("icu_available")

            elif r_type in {'ventilator', 'ventilators'}:
                if absolute_value is not None:
                    hospital_entry.ventilators_available = max(0, int(absolute_value))
                elif quantity_change is not None:
                    hospital_entry.ventilators_available = max(0, (hospital_entry.ventilators_available or 0) + int(quantity_change))
                
                if total_value is not None:
                    hospital_entry.ventilators_total = max(hospital_entry.ventilators_available, int(total_value))
                else:
                    hospital_entry.ventilators_total = max(hospital_entry.ventilators_available, hospital_entry.ventilators_total or 0)
                    
                fields_changed.append("ventilators_available")
        except ValueError:
            pass
    else:
        if "icu_available" in data:
            hospital_entry.icu_available = data["icu_available"]
            fields_changed.append("icu_available")
        if "ventilators_available" in data:
            hospital_entry.ventilators_available = data["ventilators_available"]
            fields_changed.append("ventilators_available")
        if "beds_available" in data:
            hospital_entry.beds_available = data["beds_available"]
            fields_changed.append("beds_available")


    try:
        # Sync with Resource table
        from ..models import Resource
        for field in fields_changed:
            raw_type = field.replace('_available', '')
            val = getattr(hospital_entry, field)
            total_val = getattr(hospital_entry, f"{raw_type}_total", val)
            
            # Map raw_type to singular resource_type for Resource table
            resource_type = raw_type
            if raw_type == 'beds':
                resource_type = 'bed'
            elif raw_type == 'ventilators':
                resource_type = 'ventilator'
            
            resource = Resource.query.filter_by(
                hospital_id=hospital_entry.id,
                resource_type=resource_type
            ).first()
            if resource:
                resource.available = val
                resource.total = total_val
            else:
                new_res = Resource(
                    hospital_id=hospital_entry.id,
                    resource_type=resource_type,
                    available=val,
                    total=total_val,
                    status='available'
                )
                db.session.add(new_res)

        
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating resources"}), 500

    new_values = {
        "icu_available": hospital_entry.icu_available,
        "ventilators_available": hospital_entry.ventilators_available,
        "beds_available": hospital_entry.beds_available,
    }

    logs = Logs(
        case_id=None,
        agent_name="hospital_routes.update_resources",
        message=f"Hospital {route_hospital_id} resources updated",
        metadata_json=json.dumps({
            "user_id": user_id,
            "user_role": role,
            "hospital_id": route_hospital_id,
            "fields_changed": fields_changed,
            "old_values": old_values,
            "new_values": new_values,
            "timestamp": datetime.utcnow().isoformat(),
        }),
    )
    db.session.add(logs)
    db.session.commit()
    return jsonify({
        "message": "Resources updated successfully",
        "hospital_id": hospital_entry.id,
        "icu_available": hospital_entry.icu_available,
        "ventilators_available": hospital_entry.ventilators_available,
        "beds_available": hospital_entry.beds_available
    }), 200


@hospital.route('/cases/<int:case_id>/status', methods=['POST'])
def update_case_status(case_id):
    role = session.get('role')
    if role not in ['hospital', 'admin']:
        return jsonify({'success': False, 'message': 'Unauthorized'}), 403

    data = request.get_json(silent=True) or {}
    status = data.get('status')
    if not status:
        return jsonify({'success': False, 'message': 'status is required'}), 400

    case = Case.query.get(case_id)
    if not case:
        return jsonify({'success': False, 'message': 'Case not found'}), 404

    if role == 'hospital':
        user_hospital_id = session.get('hospital_id')
        if case.hospital_id != user_hospital_id:
            return jsonify({'success': False, 'message': 'Unauthorized – case belongs to a different hospital'}), 403

    try:
        old_status = case.status

        if status == 'failed_escalation' and old_status != 'failed_escalation':
            from ..tools.langchain_tools import transfer_case_to_another_hospital
            transfer_res = transfer_case_to_another_hospital(case)
            if not transfer_res.get('success'):
                case.status = 'failed_escalation'
                if case.ambulance_id:
                    ambulance = Ambulance.query.get(case.ambulance_id)
                    if ambulance and ambulance.status == 'assigned':
                        ambulance.status = 'idle'
                        ambulance.current_case_id = None

                reservations = Reserved.query.filter_by(case_id=case.id).filter(
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
                    case_id=case.id,
                    agent_name='case_status_update',
                    message=f"Case closed (failed_escalation - fallback): ambulance reset, {len(reservations)} reservations released",
                    metadata_json=json.dumps({
                        'old_status': old_status,
                        'new_status': 'failed_escalation',
                        'ambulance_id': case.ambulance_id,
                        'reservations_released': len(reservations),
                    })
                )
                db.session.add(cleanup_log)
        else:
            case.status = status
            CLOSED_STATUSES = ('discharged', 'resolved')
            if status in CLOSED_STATUSES and old_status not in CLOSED_STATUSES:
                if case.ambulance_id:
                    ambulance = Ambulance.query.get(case.ambulance_id)
                    if ambulance and ambulance.status == 'assigned':
                        ambulance.status = 'idle'
                        ambulance.current_case_id = None

                reservations = Reserved.query.filter_by(case_id=case.id).filter(
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
                    case_id=case.id,
                    agent_name='case_status_update',
                    message=f"Case closed ({status}): ambulance reset, {len(reservations)} reservations released",
                    metadata_json=json.dumps({
                        'old_status': old_status,
                        'new_status': status,
                        'ambulance_id': case.ambulance_id,
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
        return jsonify({'success': False, 'message': f'Error updating case status: {str(e)}'}), 500

    return jsonify({
        'success': True,
        'message': f'Case {case_id} status updated to {status}',
        'data': case.to_dict()
    }), 200