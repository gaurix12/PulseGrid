from flask_socketio import emit
from ..models import Ambulance, db
def register_ambulance_update_events(socketio):
    @socketio.on('update_ambulance')
    def handle_update(data):
        data = data or {}
        ambulance_id = data.get('ambulance_id')
        status = data.get('status')
        current_latitude = data.get('latitude')
        current_longitude = data.get('longitude')
        current_case_id = data.get('current_case_id')

        if not ambulance_id:
            emit('response', {'success': False, 'message': 'ambulance_id is required'})
            return

        ambulance = Ambulance.query.get(ambulance_id)
        if not ambulance:
            emit('response', {'success': False, 'message': 'Ambulance not found'})
            return

        try:
            if status is not None:
                ambulance.status = status
            if current_latitude is not None:
                ambulance.current_latitude = current_latitude
            if current_longitude is not None:
                ambulance.current_longitude = current_longitude
            if current_case_id is not None:
                ambulance.current_case_id = current_case_id

            db.session.commit()
            emit('response', {
                'success': True,
                'message': 'Ambulance updated successfully',
                'ambulance': {
                    'id': ambulance.id,
                    'status': ambulance.status,
                    'current_latitude': ambulance.current_latitude,
                    'current_longitude': ambulance.current_longitude,
                    'current_case_id': ambulance.current_case_id,
                },
            })
        except Exception as e:
            db.session.rollback()
            emit('response', {'success': False, 'message': f'Error updating ambulance: {str(e)}'})
    