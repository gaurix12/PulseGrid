from dotenv import load_dotenv
load_dotenv()
from flask import Flask, jsonify, request, session
from flask_cors import CORS
from flask_socketio import SocketIO

from .config import Config
from .models import db, User
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
    db.create_all()

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

    auth_header = request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        token = auth_header.split(' ')[1]
        parts = token.split('_')
        if len(parts) >= 2 and parts[0] == 'session':
            try:
                user_id = int(parts[1])
                user = User.query.get(user_id)
                if user:
                    session['user_id'] = user.id
                    session['username'] = user.username
                    session['role'] = user.role
                    session['hospital_id'] = user.hospital_id
                    session['ambulance_id'] = user.ambulance_id
            except Exception:
                pass

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