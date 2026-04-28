from flask import Flask, jsonify, request
from flask_cors import CORS
from config import Config
from models import db
from .routes import hospital, ambulance, admin, auth, case, setup
app = Flask(__name__)
app.config.from_object(Config)

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


if __name__ == '__main__':
    app.run(debug=True)
