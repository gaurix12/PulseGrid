from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().with_name(".env"))
from flask import Flask, jsonify, request, session
from flask_cors import CORS
from flask_socketio import SocketIO
from sqlalchemy import inspect, text

from .config import Config
from .models import Ambulance, Case, Hospital, User, db
from .utils.h3 import compute_h3_from_location, compute_h3_index
from .routes.admin_routes import admin
from .routes.ambulance_routes import ambulance
from .routes.auth_routes import auth
from .routes.case_routes import case
from .routes.chat_routes import chat
from .routes.hospital_routes import hospital
from .routes.setup_routes import setup
from .routes.emergency_routes import emergency
from .sockets.ambulance_update import register_ambulance_update_events
app = Flask(__name__)
app.config.from_object(Config)

CORS(app, supports_credentials=True)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

db.init_app(app)
with app.app_context():
    inspector = inspect(db.engine)
    existing_tables = set(inspector.get_table_names())
    for table_name in ("hospital", "ambulance", "case"):
        if table_name in existing_tables:
            columns = {column["name"] for column in inspector.get_columns(table_name)}
            if "h3_index" not in columns:
                db.session.execute(
                    text(f'ALTER TABLE "{table_name}" ADD COLUMN h3_index VARCHAR(20)')
                )
    db.session.commit()
    db.create_all()
    for table_name in ("hospital", "ambulance", "case"):
        db.session.execute(
            text(
                f'CREATE INDEX IF NOT EXISTS "ix_{table_name}_h3_index" '
                f'ON "{table_name}" (h3_index)'
            )
        )
    db.session.commit()

    for hospital_record in Hospital.query.all():
        hospital_record.h3_index = compute_h3_index(
            hospital_record.latitude,
            hospital_record.longitude,
        )
    for ambulance_record in Ambulance.query.all():
        ambulance_record.h3_index = compute_h3_index(
            ambulance_record.current_latitude,
            ambulance_record.current_longitude,
        )
    for case_record in Case.query.all():
        case_record.h3_index = compute_h3_from_location(case_record.location)
    db.session.commit()

ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}

@app.after_request
def add_cors_headers(response):
    origin = request.headers.get('Origin')
    if origin in ALLOWED_ORIGINS:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Credentials'] = 'true'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'
        response.headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS'
    return response

@app.before_request
def load_session_from_token():
    if request.method == 'OPTIONS':
        origin = request.headers.get('Origin')
        resp = app.make_default_options_response()
        if origin in ALLOWED_ORIGINS:
            resp.headers['Access-Control-Allow-Origin'] = origin
            resp.headers['Access-Control-Allow-Credentials'] = 'true'
            resp.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'
            resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS'
        return resp


@app.route('/')
def index():
    return jsonify({"message": "backend is running"})

@app.route('/home')
def home():
    return jsonify({"message": "hello world "})

@app.route('/api/health')
def health_check():
    return jsonify({"status": "ok"})

app.register_blueprint(hospital, url_prefix='/hospitals')
app.register_blueprint(ambulance, url_prefix='/ambulances')
app.register_blueprint(admin, url_prefix='/admin')
app.register_blueprint(auth, url_prefix='/auth')
app.register_blueprint(case, url_prefix='/cases')
app.register_blueprint(setup, url_prefix='/setup')
app.register_blueprint(chat, url_prefix='/chat')
app.register_blueprint(emergency, url_prefix='/emergency')

register_ambulance_update_events(socketio)

if __name__ == '__main__':
    socketio.run(app, debug=True)