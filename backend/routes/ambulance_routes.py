from flask import Blueprint, jsonify, request, session
from ..models import Case, db, Ambulance, Hospital, User

ambulance = Blueprint('ambulance', __name__)

# setup
@ambulance.route('/profile', methods=['POST'])
def create_ambulance_profile():
    role = session.get('role')
    user_id = session.get('user_id')
    if role != 'ambulance' or not user_id:
        return jsonify({'success': False, 'message': 'Only ambulance users can create an ambulance profile'}), 403

    user = User.query.get(user_id)
    if not user:
        return jsonify({'success': False, 'message': 'User not found'}), 404
    if user.ambulance_id:
        return jsonify({'success': False, 'message': 'You already have an ambulance profile'}), 400

    data = request.get_json(silent=True) or {}
    driver_name = data.get('driver_name', '').strip()
    if not driver_name:
        return jsonify({'success': False, 'message': 'driver_name is required'}), 400

    try:
        new_ambulance = Ambulance(
            driver_name=driver_name,
            status='idle',
            current_latitude=float(data['current_latitude']) if data.get('current_latitude') else None,
            current_longitude=float(data['current_longitude']) if data.get('current_longitude') else None,
        )
        db.session.add(new_ambulance)
        db.session.flush()

        user.ambulance_id = new_ambulance.id
        db.session.commit()

        session['ambulance_id'] = new_ambulance.id

        return jsonify({
            'success': True,
            'message': 'Ambulance profile created',
            'ambulance': new_ambulance.to_dict(),
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

# all ambulances
@ambulance.route('', methods=['GET'])
def list_ambulances():
    role = session.get('role')
    if not role:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401
    if role == 'ambulance':
        amb_id = session.get('ambulance_id')
        ambulances = Ambulance.query.filter_by(id=amb_id).all() if amb_id else []
    elif role == 'hospital':
        hosp_id = session.get('hospital_id')
        if hosp_id:
            cases = Case.query.filter_by(hospital_id=hosp_id).all()
            amb_ids = {c.ambulance_id for c in cases if c.ambulance_id is not None}
            ambulances = Ambulance.query.filter(Ambulance.id.in_(amb_ids)).all() if amb_ids else []
        else:
            ambulances = []
    elif role == 'admin':
        ambulances = Ambulance.query.order_by(Ambulance.id).all()
    else:
        return jsonify({'success': False, 'message': 'Unauthorized'}), 403
    return jsonify({
        'success': True,
        'data': [a.to_dict() for a in ambulances]
    }), 200

# single ambulance details
@ambulance.route('/<int:ambulance_id>', methods=['GET'])
def get_ambulance(ambulance_id):
    role = session.get('role')
    if not role:
        return jsonify({'success': False, 'message': 'Authentication required'}), 401
    if role == 'ambulance':
        user_ambulance_id = session.get('ambulance_id')
        if user_ambulance_id != ambulance_id:
            return jsonify({'success': False, 'message': 'Unauthorized'}), 403

    amb = Ambulance.query.get(ambulance_id)
    if not amb:
        return jsonify({'success': False, 'message': 'Ambulance not found'}), 404
    return jsonify({'success': True, 'data': amb.to_dict()}), 200

# get cases assigned to an ambulance
@ambulance.route('/get-assigned-cases/<ambulance_id>', methods=['GET'])
def get_cases(ambulance_id):
    if not ambulance_id:
        return jsonify({"message": "ambulance_id is required"}), 400
    role = session.get('role')
    if role not in ['ambulance', 'admin']:
        return jsonify({"message": "Unauthorized"}), 403
    if role == 'ambulance' and session.get('ambulance_id') != int(ambulance_id):
        return jsonify({"message": "Unauthorized"}), 403
    cases = Case.query.filter_by(ambulance_id=ambulance_id).all()
    res = []
    for c in cases:
        h = c.hospital
        res.append({
            "id": c.id,
            "patient_name": c.patient_name,
            "condition": c.condition,
            "severity": c.severity,
            "location": c.location,
            "ambulance_id": c.ambulance_id,
            "hospital_id": c.hospital_id,
            "hospital_name": h.name if h else None,
            "hospital_phone": h.phone_number if h else None,
            "hospital_latitude": h.latitude if h else None,
            "hospital_longitude": h.longitude if h else None,
            "status": c.status,
            "eta": c.eta,
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "delay": c.delay
        })
    return jsonify(res), 200


@ambulance.route('/update-status/<ambulance_id>', methods=['POST'])
def update_status(ambulance_id):
    role = session.get('role')
    if role not in ['ambulance', 'admin']:
        return jsonify({"message": "Unauthorized"}), 403
    if role == 'ambulance' and session.get('ambulance_id') != int(ambulance_id):
        return jsonify({"message": "Unauthorized"}), 403

    data = request.get_json()
    amb = Ambulance.query.get(ambulance_id)
    if not amb:
        return jsonify({"message": "Ambulance not found"}), 404
    if "status" in data:
        status_val = data["status"]
        if status_val not in ['idle', 'assigned', 'en_route', 'at_hospital', 'on_scene', 'transporting', 'delivered']:
            return jsonify({"message": "Invalid status value. Must be one of: idle, assigned, en_route, on_scene, transporting, at_hospital, delivered"}), 400
        
        if status_val == 'delivered':
            case_id = amb.current_case_id
            case = None
            if case_id:
                case = Case.query.get(case_id)
            if not case:
                case = Case.query.filter_by(ambulance_id=amb.id).filter(
                    Case.status.in_(['created', 'triaged', 'dispatched'])
                ).first()
            if case:
                case.status = 'arrived'
                db.session.add(case)
            amb.status = 'idle'
            amb.current_case_id = None
        else:
            amb.status = status_val
            if status_val == 'at_hospital':
                case_id = amb.current_case_id
                case = None
                if case_id:
                    case = Case.query.get(case_id)
                if not case:
                    case = Case.query.filter_by(ambulance_id=amb.id).filter(
                        Case.status.in_(['created', 'triaged', 'dispatched'])
                    ).first()
                if case:
                    case.status = 'arrived'
                    db.session.add(case)
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating status"}), 500
    return jsonify({"message": "Status updated successfully", "ambulance_id": amb.id, "status": amb.status}), 200


@ambulance.route('/update-location/<ambulance_id>', methods=['POST'])
def update_location(ambulance_id):
    role = session.get('role')
    if role not in ['ambulance', 'admin']:
        return jsonify({"message": "Unauthorized"}), 403
    if role == 'ambulance' and session.get('ambulance_id') != int(ambulance_id):
        return jsonify({"message": "Unauthorized"}), 403

    data = request.get_json(silent=True) or {}
    amb = Ambulance.query.get(ambulance_id)
    if not amb:
        return jsonify({"message": "Ambulance not found"}), 404
    if "current_latitude" in data and "current_longitude" in data:
        amb.current_latitude = float(data["current_latitude"])
        amb.current_longitude = float(data["current_longitude"])
        
        # Check coordinates match for auto-delivery
        case_id = amb.current_case_id
        case = None
        if case_id:
            case = Case.query.get(case_id)
        if not case:
            case = Case.query.filter_by(ambulance_id=amb.id).filter(
                Case.status.in_(['created', 'triaged', 'dispatched'])
            ).first()
        
        if case and case.hospital_id:
            hosp = Hospital.query.get(case.hospital_id)
            if hosp and hosp.latitude is not None and hosp.longitude is not None:
                lat_diff = abs(float(amb.current_latitude) - float(hosp.latitude))
                lon_diff = abs(float(amb.current_longitude) - float(hosp.longitude))
                if lat_diff < 0.001 and lon_diff < 0.001:
                    case.status = 'arrived'
                    amb.status = 'idle'
                    amb.current_case_id = None
                    db.session.add(case)
    else:
        return jsonify({"message": "current_latitude and current_longitude are required"}), 400
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"message": "Error updating location"}), 500
    return jsonify({
        "message": "Location updated successfully",
        "ambulance_id": amb.id,
        "current_latitude": amb.current_latitude,
        "current_longitude": amb.current_longitude
    }), 200