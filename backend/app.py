from flask import Flask, jsonify
from flask_cors import CORS
from flask_socketio import SocketIO

from .config import Config
from .models import db
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
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

db.init_app(app)
with app.app_context():
    db.create_all()
CORS(app)

@app.route('/home')
def home():
    return jsonify({"message": "hello world "})

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
