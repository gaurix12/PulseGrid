from flask import Blueprint, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from ..models import User, db

auth = Blueprint('auth', __name__)

@auth.route('/register', methods=['POST'])
def register():
    data = request.get_json(silent=True) or {}
    username = data.get('username')
    email = data.get('email')
    password = data.get('password')
    role = data.get('role')
    hospital_id = data.get('hospital_id')
    ambulance_id = data.get('ambulance_id')

    if not username or not email or not password or not role:
        return jsonify({"message": "username, email, password, and role are required"}), 400

    allowed_roles = {'hospital', 'ambulance', 'admin'}
    if role not in allowed_roles:
        return jsonify({"message": "role must be one of: hospital, ambulance, admin"}), 400

    if User.query.filter_by(username=username).first():
        return jsonify({"message": "Username already exists"}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({"message": "Email already exists"}), 400

    new_user = User(
        username=username,
        email=email,
        password_hash=generate_password_hash(password),
        role=role,
        hospital_id=hospital_id,
        ambulance_id=ambulance_id,
    )
    db.session.add(new_user)
    db.session.commit()

    return jsonify({
        "message": "User registered successfully",
        "user": {
            "id": new_user.id,
            "username": new_user.username,
            "email": new_user.email,
            "role": new_user.role,
            "hospital_id": new_user.hospital_id,
            "ambulance_id": new_user.ambulance_id,
        },
    }), 201

@auth.route('/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    username = data.get('username')
    email = data.get('email')
    password = data.get('password')

    if not password or (not username and not email):
        return jsonify({"message": "Provide password and either username or email"}), 400

    user = None
    if username:
        user = User.query.filter_by(username=username).first()
    elif email:
        user = User.query.filter_by(email=email).first()

    if not user or not check_password_hash(user.password_hash, password):
        return jsonify({"message": "Invalid credentials"}), 401
    session['user_id'] = user.id
    session['username'] = user.username
    session['role']=user.role
    session['hospital_id']=user.hospital_id
    session['ambulance_id']=user.ambulance_id
    return jsonify({
        "message": "Login successful",
        "user": {
            "id": user.id,
            "username": user.username,
            "email": user.email,
            "role": user.role,
            "hospital_id": user.hospital_id,
            "ambulance_id": user.ambulance_id,
        },
    }), 200

@auth.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({"message": "Logout successful"}), 200