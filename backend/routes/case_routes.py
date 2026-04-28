from flask import Blueprint, jsonify, request
from ..models import Case, db, Hospital

case = Blueprint('case', __name__)

# create emergency case
@case.route('/create', methods=['POST'])
def create_case():
    data = request.get_json()
    if not data:
        return jsonify({"message": "No data provided"}), 400
    must = ["patient_name", "condition", "severity", "location"]
    for field in must:
        if field not in data:
            return jsonify({"message": f"Missing required field: {field}"}), 400
    new_case = Case(
        patient_name=data.get('patient_name'),
        condition=data.get('condition'),
        severity=data.get('severity'),
        location=data.get('location'),
        created_at=data.get('created_at')
    )
    db.session.add(new_case)
    db.session.commit()
    return jsonify({"message": "Case created successfully", "case_id": new_case.id}), 201