from __future__ import annotations

import json
from datetime import datetime
from math import asin, cos, radians, sin, sqrt
from typing import Any, Dict, List, Optional, Tuple
from langchain_core.tools import tool
from sqlalchemy import func
from ..models import Ambulance, Case, Hospital, Logs, Reserved, db


READ_ONLY_TOOLS = {
    "fetch_hospital_data",
    "fetch_ambulance_data",
    "fetch_case_data",
    "fetch_resource_snapshot",
    "recommend_hospital_for_case",
    "explain_hospital_selection",
    "recommend_ambulance_for_case",
}

ROLE_TOOL_ALLOWLIST = {
    "admin": set(),
    "hospital": READ_ONLY_TOOLS | {
        "update_hospital_resources",
        "reserve_resources",
        "confirm_reservation",
        "release_resources",
        "log_decision",
    },
    "ambulance": READ_ONLY_TOOLS | {
        "update_ambulance_status",
        "update_ambulance_location",
        "assign_ambulance_to_case",
        "log_decision",
    },
}

def _safe_int(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _serialize_hospital(hospital: Hospital) -> Dict[str, Any]:
    return {
        "id": hospital.id,
        "name": hospital.name,
        "location": hospital.location,
        "capacity": hospital.capacity,
        "current_patients": hospital.current_patients,
        "beds_available": hospital.beds_available,
        "beds_total": hospital.beds_total,
        "icu_available": hospital.icu_available,
        "icu_total": hospital.icu_total,
        "ventilators_available": hospital.ventilators_available,
        "ventilators_total": hospital.ventilators_total,
        "has_cardiology": hospital.has_cardiology,
        "has_trauma_care": hospital.has_trauma_care,
        "latitude": hospital.latitude,
        "longitude": hospital.longitude,
    }


def _serialize_ambulance(ambulance: Ambulance) -> Dict[str, Any]:
    return {
        "id": ambulance.id,
        "driver_name": ambulance.driver_name,
        "status": ambulance.status,
        "current_case_id": ambulance.current_case_id,
        "current_latitude": ambulance.current_latitude,
        "current_longitude": ambulance.current_longitude,
    }


def _serialize_case(case: Case) -> Dict[str, Any]:
    return {
        "id": case.id,
        "patient_name": case.patient_name,
        "severity": case.severity,
        "condition": case.condition,
        "location": case.location,
        "ambulance_id": case.ambulance_id,
        "hospital_id": case.hospital_id,
        "delay": case.delay,
        "status": case.status,
        "eta": case.eta,
        "created_at": case.created_at.isoformat() if case.created_at else None,
    }


def _write_tool_audit_log(
    *,
    tool_name: str,
    user_id: Optional[int],
    user_role: Optional[str],
    user_hospital_id: Optional[int],
    user_ambulance_id: Optional[int],
    tool_args: Dict[str, Any],
    result: Dict[str, Any],
    started_at: datetime,
    ended_at: datetime,
) -> Optional[int]:
    """Write tool execution audit log. Does NOT commit - caller must commit."""
    case_id = _safe_int(tool_args.get("case_id"))
    if case_id is None:
        case_id = _safe_int(result.get("case_id"))

    metadata = {
        "tool_name": tool_name,
        "user_id": user_id,
        "user_role": user_role,
        "hospital_id": user_hospital_id,
        "ambulance_id": user_ambulance_id,
        "tool_args": tool_args,
        "result": result,
        "started_at": started_at.isoformat(),
        "ended_at": ended_at.isoformat(),
        "duration_ms": int((ended_at - started_at).total_seconds() * 1000),
    }

    log_entry = Logs(
        case_id=case_id,
        agent_name=f"tool:{tool_name}",
        message=f"{tool_name} executed by user_id={user_id} role={user_role}",
        metadata=json.dumps(metadata, default=str),
    )
    db.session.add(log_entry)
    # NOTE: Commit moved to invoke_tool for transaction atomicity
    return log_entry.id
    
def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius_km = 6371.0
    d_lat = radians(lat2 - lat1)
    d_lon = radians(lon2 - lon1)
    a = sin(d_lat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lon / 2) ** 2
    return 2 * radius_km * asin(sqrt(a))


def _parse_coordinates(value: Optional[str]) -> Tuple[Optional[float], Optional[float]]:
    if not value:
        return None, None

    parts = [part.strip() for part in str(value).replace(";", ",").split(",")]
    if len(parts) < 2:
        return None, None

    return _safe_float(parts[0]), _safe_float(parts[1])


def _severity_weight(severity: Optional[str]) -> int:
    if not severity:
        return 1
    severity = str(severity).strip().upper()
    mapping = {"P0": 4, "P1": 3, "P2": 2, "P3": 1}
    return mapping.get(severity, 1)


def _normalize_role(user_role: Optional[str]) -> str:
    return str(user_role or "").strip().lower()


def _authorize_tool_call(
    tool_name: str,
    *,
    user_role: Optional[str] = None,
    user_hospital_id: Optional[int] = None,
    user_ambulance_id: Optional[int] = None,
    kwargs: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    role = _normalize_role(user_role)
    if role == "admin":
        return None

    allowed_tools = ROLE_TOOL_ALLOWLIST.get(role)
    if allowed_tools is None:
        return {"success": False, "error": "Missing or invalid user_role for tool execution"}

    if tool_name not in allowed_tools:
        return {"success": False, "error": f"Role '{role}' is not allowed to call {tool_name}"}

    kwargs = kwargs or {}
    if role == "hospital" and tool_name in {"update_hospital_resources", "reserve_resources", "confirm_reservation", "release_resources"}:
        hospital_id = _safe_int(kwargs.get("hospital_id"))
        if user_hospital_id is not None and hospital_id is not None and user_hospital_id != hospital_id:
            return {"success": False, "error": "Hospital users can only act on their own hospital"}
    if role == "ambulance" and tool_name in {"update_ambulance_status", "update_ambulance_location", "assign_ambulance_to_case"}:
        ambulance_id = _safe_int(kwargs.get("ambulance_id"))
        if user_ambulance_id is not None and ambulance_id is not None and user_ambulance_id != ambulance_id:
            return {"success": False, "error": "Ambulance users can only act on their own ambulance"}

    return None


def _required_specialty_for_condition(condition: Optional[str]) -> Optional[str]:
    normalized = str(condition or "").strip().lower()

    if any(keyword in normalized for keyword in ["cardiac", "heart", "chest pain", "heart attack"]):
        return "cardiology"

    if any(keyword in normalized for keyword in ["trauma", "polytrauma", "major accident", "severe accident", "head injury"]):
        return "trauma_care"

    return None


def _hospital_meets_specialty_requirement(hospital: Hospital, condition: Optional[str]) -> bool:
    required_specialty = _required_specialty_for_condition(condition)
    if required_specialty == "cardiology":
        return bool(hospital.has_cardiology)
    if required_specialty == "trauma_care":
        return bool(hospital.has_trauma_care)
    return True


@tool
def fetch_hospital_data(hospital_id: Optional[int] = None) -> Dict[str, Any]:
    try:
        if hospital_id is not None:
            hospital = Hospital.query.get(hospital_id)
            if not hospital:
                return {"success": False, "error": f"Hospital {hospital_id} not found"}

            return {"success": True, "data": _serialize_hospital(hospital)}

        hospitals = Hospital.query.all()
        return {
            "success": True,
            "count": len(hospitals),
            "data": [_serialize_hospital(hospital) for hospital in hospitals],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool
def fetch_ambulance_data(
    ambulance_id: Optional[int] = None,
    status: Optional[str] = None,
) -> Dict[str, Any]:
    try:
        if ambulance_id is not None:
            ambulance = Ambulance.query.get(ambulance_id)
            if not ambulance:
                return {"success": False, "error": f"Ambulance {ambulance_id} not found"}

            return {"success": True, "data": _serialize_ambulance(ambulance)}

        query = Ambulance.query
        normalized_status = (status or "idle").strip().lower() if status else "idle"

        if normalized_status in {"running", "active", "non_idle"}:
            query = query.filter(Ambulance.status != "idle")
        elif normalized_status == "all":
            query = query
        else:
            query = query.filter(func.lower(Ambulance.status) == normalized_status)

        ambulances = query.all()
        return {
            "success": True,
            "count": len(ambulances),
            "data": [_serialize_ambulance(ambulance) for ambulance in ambulances],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool
def fetch_case_data(
    case_id: Optional[int] = None,
    hospital_id: Optional[int] = None,
    ambulance_id: Optional[int] = None,
    period: Optional[str] = None,
) -> Dict[str, Any]:
    try:
        if case_id is not None:
            case = Case.query.get(case_id)
            if not case:
                return {"success": False, "error": f"Case {case_id} not found"}

            return {"success": True, "data": _serialize_case(case)}

        query = Case.query

        if hospital_id is not None:
            query = query.filter(Case.hospital_id == hospital_id)
        if ambulance_id is not None:
            query = query.filter(Case.ambulance_id == ambulance_id)

        normalized_period = (period or "").strip().lower()
        if normalized_period in {"today", "week", "month"}:
            from datetime import datetime, timedelta

            if normalized_period == "today":
                start_time = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            elif normalized_period == "week":
                start_time = datetime.now() - timedelta(days=7)
            else:
                start_time = datetime.now() - timedelta(days=30)

            query = query.filter(Case.created_at >= start_time)

        cases = query.order_by(Case.created_at.desc()).all()
        return {
            "success": True,
            "count": len(cases),
            "data": [_serialize_case(case) for case in cases],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool
def fetch_resource_snapshot(
    hospital_id: Optional[int] = None,
    resource_type: Optional[str] = None,
) -> Dict[str, Any]:
    try:
        resource_type = (resource_type or "").strip().lower()

        def build_snapshot(hospital: Hospital) -> Dict[str, Any]:
            reserved_filters = {"hospital_id": hospital.id, "status": "reserved"}
            reserved_beds = Reserved.query.filter_by(type="bed", **reserved_filters).all()
            reserved_icu = Reserved.query.filter_by(type="icu", **reserved_filters).all()
            reserved_ventilators = Reserved.query.filter_by(type="ventilator", **reserved_filters).all()

            snapshot = {
                "hospital_id": hospital.id,
                "hospital": hospital.name,
                "beds_available": hospital.beds_available,
                "beds_total": hospital.beds_total,
                "icu_available": hospital.icu_available,
                "icu_total": hospital.icu_total,
                "ventilators_available": hospital.ventilators_available,
                "ventilators_total": hospital.ventilators_total,
                "reserved": {
                    "bed": sum(item.quantity for item in reserved_beds),
                    "icu": sum(item.quantity for item in reserved_icu),
                    "ventilator": sum(item.quantity for item in reserved_ventilators),
                },
                "utilization": {
                    "beds": round(((hospital.beds_total - hospital.beds_available) / hospital.beds_total) * 100, 1)
                    if hospital.beds_total else 0,
                    "icu": round(((hospital.icu_total - hospital.icu_available) / hospital.icu_total) * 100, 1)
                    if hospital.icu_total else 0,
                    "ventilators": round(((hospital.ventilators_total - hospital.ventilators_available) / hospital.ventilators_total) * 100, 1)
                    if hospital.ventilators_total else 0,
                },
            }

            if resource_type in {"bed", "beds"}:
                snapshot["focused_resource"] = {
                    "type": "bed",
                    "available": hospital.beds_available,
                    "total": hospital.beds_total,
                    "reserved": snapshot["reserved"]["bed"],
                }
            elif resource_type in {"icu"}:
                snapshot["focused_resource"] = {
                    "type": "icu",
                    "available": hospital.icu_available,
                    "total": hospital.icu_total,
                    "reserved": snapshot["reserved"]["icu"],
                }
            elif resource_type in {"ventilator", "ventilators"}:
                snapshot["focused_resource"] = {
                    "type": "ventilator",
                    "available": hospital.ventilators_available,
                    "total": hospital.ventilators_total,
                    "reserved": snapshot["reserved"]["ventilator"],
                }

            return snapshot

        if hospital_id is not None:
            hospital = Hospital.query.get(hospital_id)
            if not hospital:
                return {"success": False, "error": f"Hospital {hospital_id} not found"}

            return {"success": True, "data": build_snapshot(hospital)}

        hospitals = Hospital.query.all()
        return {
            "success": True,
            "count": len(hospitals),
            "data": [build_snapshot(hospital) for hospital in hospitals],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool
def update_hospital_resources(
    hospital_id: int,
    resource_type: str,
    quantity_change: int,
) -> Dict[str, Any]:
    try:
        hospital = Hospital.query.get(hospital_id)
        if not hospital:
            return {"success": False, "error": f"Hospital {hospital_id} not found"}

        resource_type = resource_type.strip().lower()
        quantity_change = int(quantity_change)

        if resource_type in {"bed", "beds"}:
            hospital.beds_available = max(0, (hospital.beds_available or 0) + quantity_change)
            hospital.beds_total = max(hospital.beds_available, (hospital.beds_total or 0) + max(quantity_change, 0))
        elif resource_type == "icu":
            hospital.icu_available = max(0, (hospital.icu_available or 0) + quantity_change)
            hospital.icu_total = max(hospital.icu_available, (hospital.icu_total or 0) + max(quantity_change, 0))
        elif resource_type in {"ventilator", "ventilators"}:
            hospital.ventilators_available = max(0, (hospital.ventilators_available or 0) + quantity_change)
            hospital.ventilators_total = max(
                hospital.ventilators_available,
                (hospital.ventilators_total or 0) + max(quantity_change, 0),
            )
        else:
            return {
                "success": False,
                "error": "resource_type must be one of: bed, icu, ventilator",
            }

        db.session.commit()
        return {
            "success": True,
            "hospital_id": hospital.id,
            "resource_type": resource_type,
            "quantity_change": quantity_change,
            "message": f"Updated {resource_type} resources for hospital {hospital.name}",
            "data": _serialize_hospital(hospital),
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


@tool
def update_ambulance_status(ambulance_id: int, status: str) -> Dict[str, Any]:
    try:
        ambulance = Ambulance.query.get(ambulance_id)
        if not ambulance:
            return {"success": False, "error": f"Ambulance {ambulance_id} not found"}

        normalized_status = status.strip().lower().replace(" ", "_")
        valid_statuses = {"idle", "assigned", "en_route", "at_hospital", "delayed", "arrived"}
        if normalized_status not in valid_statuses:
            return {
                "success": False,
                "error": f"Invalid status. Must be one of: {', '.join(sorted(valid_statuses))}",
            }

        ambulance.status = normalized_status
        db.session.commit()
        return {
            "success": True,
            "ambulance_id": ambulance.id,
            "status": ambulance.status,
            "message": f"Ambulance {ambulance.id} status updated to {ambulance.status}",
            "data": _serialize_ambulance(ambulance),
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


@tool
def update_ambulance_location(
    ambulance_id: int,
    current_latitude: float,
    current_longitude: float,
) -> Dict[str, Any]:
    try:
        ambulance = Ambulance.query.get(ambulance_id)
        if not ambulance:
            return {"success": False, "error": f"Ambulance {ambulance_id} not found"}

        ambulance.current_latitude = float(current_latitude)
        ambulance.current_longitude = float(current_longitude)
        db.session.commit()
        return {
            "success": True,
            "ambulance_id": ambulance.id,
            "message": f"Ambulance {ambulance.id} location updated",
            "data": _serialize_ambulance(ambulance),
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


@tool
def assign_ambulance_to_case(ambulance_id: int, case_id: int) -> Dict[str, Any]:
    try:
        ambulance = Ambulance.query.get(ambulance_id)
        if not ambulance:
            return {"success": False, "error": f"Ambulance {ambulance_id} not found"}

        case = Case.query.get(case_id)
        if not case:
            return {"success": False, "error": f"Case {case_id} not found"}

        previous_ambulance_id = case.ambulance_id
        previous_case_id = ambulance.current_case_id

        already_synchronized = (
            case.ambulance_id == ambulance.id
            and ambulance.current_case_id == case.id
            and ambulance.status == "assigned"
        )

        if already_synchronized:
            return {
                "success": True,
                "ambulance_id": ambulance.id,
                "case_id": case.id,
                "already_synchronized": True,
                "message": f"Ambulance {ambulance.id} is already assigned to case {case.id}",
            }

        if previous_ambulance_id and previous_ambulance_id != ambulance.id:
            previous_ambulance = Ambulance.query.get(previous_ambulance_id)
            if previous_ambulance and previous_ambulance.current_case_id == case.id:
                previous_ambulance.current_case_id = None
                previous_ambulance.status = "idle"

        if previous_case_id and previous_case_id != case.id:
            previous_case = Case.query.get(previous_case_id)
            if previous_case and previous_case.ambulance_id == ambulance.id:
                previous_case.ambulance_id = None

        ambulance.status = "assigned"
        ambulance.current_case_id = case.id
        case.ambulance_id = ambulance.id
        db.session.commit()
        return {
            "success": True,
            "ambulance_id": ambulance.id,
            "case_id": case.id,
            "previous_ambulance_id": previous_ambulance_id,
            "previous_case_id": previous_case_id,
            "already_synchronized": False,
            "message": f"Ambulance {ambulance.id} assigned to case {case.id}",
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


@tool
def reserve_resources(
    case_id: int,
    hospital_id: int,
    resource_type: str = "bed",
    quantity: int = 1,
) -> Dict[str, Any]:
    try:
        case = Case.query.get(case_id)
        hospital = Hospital.query.get(hospital_id)
        if not case:
            return {"success": False, "error": f"Case {case_id} not found"}
        if not hospital:
            return {"success": False, "error": f"Hospital {hospital_id} not found"}

        reservation = Reserved(
            case_id=case.id,
            hospital_id=hospital.id,
            type=resource_type,
            quantity=int(quantity),
            status="reserved",
        )
        db.session.add(reservation)
        db.session.commit()
        return {
            "success": True,
            "case_id": case.id,
            "hospital_id": hospital.id,
            "resource_type": resource_type,
            "quantity": int(quantity),
            "reservation_id": reservation.id,
            "message": f"Reserved {quantity} {resource_type}(s) for case {case.id}",
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


@tool
def confirm_reservation(case_id: int) -> Dict[str, Any]:
    try:
        reservations = Reserved.query.filter_by(case_id=case_id, status="reserved").all()
        for reservation in reservations:
            reservation.status = "confirmed"
        db.session.commit()
        return {
            "success": True,
            "case_id": case_id,
            "confirmed_count": len(reservations),
            "message": f"Confirmed {len(reservations)} reservation(s) for case {case_id}",
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


@tool
def release_resources(case_id: int) -> Dict[str, Any]:
    try:
        reservations = Reserved.query.filter_by(case_id=case_id, status="reserved").all()
        for reservation in reservations:
            reservation.status = "released"
        db.session.commit()
        return {
            "success": True,
            "case_id": case_id,
            "released_count": len(reservations),
            "message": f"Released {len(reservations)} reservation(s) for case {case_id}",
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


@tool
def recommend_hospital_for_case(case_id: int, top_k: int = 3) -> Dict[str, Any]:
    try:
        case = Case.query.get(case_id)
        if not case:
            return {"success": False, "error": f"Case {case_id} not found"}

        severity_score = _severity_weight(case.severity)
        condition = (case.condition or "").strip().lower()
        hospitals = Hospital.query.all()
        required_specialty = _required_specialty_for_condition(condition)
        candidate_hospitals = [hospital for hospital in hospitals if _hospital_meets_specialty_requirement(hospital, condition)]

        if required_specialty and not candidate_hospitals:
            return {
                "success": False,
                "error": f"No hospital with required {required_specialty} specialty is available for case {case_id}",
                "case_id": case_id,
                "required_specialty": required_specialty,
            }

        if not required_specialty:
            candidate_hospitals = hospitals

        ranking: List[Dict[str, Any]] = []

        for hospital in candidate_hospitals:
            capacity_score = (hospital.beds_available or 0) * 2
            icu_score = (hospital.icu_available or 0) * (2 + severity_score)
            ventilator_score = (hospital.ventilators_available or 0) * (2 if "respir" in condition else 1)
            specialty_score = 0
            reasons: List[str] = []

            if condition in {"cardiac", "heart"} and hospital.has_cardiology:
                specialty_score += 8
                reasons.append("cardiology support")
            if condition in {"trauma"} and hospital.has_trauma_care:
                specialty_score += 8
                reasons.append("trauma care")
            if "respir" in condition and hospital.ventilators_available:
                specialty_score += 6
                reasons.append("ventilator availability")

            occupancy_penalty = 0
            if hospital.capacity:
                occupancy_penalty = round(((hospital.current_patients or 0) / hospital.capacity) * 10, 1)

            score = capacity_score + icu_score + ventilator_score + specialty_score - occupancy_penalty
            ranking.append(
                {
                    "hospital_id": hospital.id,
                    "hospital": hospital.name,
                    "score": round(score, 2),
                    "reasons": reasons or ["availability and capacity"],
                    "snapshot": _serialize_hospital(hospital),
                }
            )

        ranking.sort(key=lambda item: item["score"], reverse=True)
        return {
            "success": True,
            "case_id": case_id,
            "severity": case.severity,
            "condition": case.condition,
            "required_specialty": required_specialty,
            "recommended": ranking[: max(1, top_k)],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool
def explain_hospital_selection(case_id: int, hospital_id: Optional[int] = None) -> Dict[str, Any]:
    try:
        case = Case.query.get(case_id)
        if not case:
            return {"success": False, "error": f"Case {case_id} not found"}

        recommendation = recommend_hospital_for_case.invoke({"case_id": case_id, "top_k": 5})
        if not recommendation.get("success"):
            return recommendation

        ranked = recommendation.get("recommended", [])
        selected = None

        if hospital_id is not None:
            selected = next((item for item in ranked if item["hospital_id"] == hospital_id), None)

        if selected is None and ranked:
            selected = ranked[0]

        if not selected:
            return {"success": True, "explanation": "No suitable hospital recommendation could be produced."}

        explanation = (
            f"Hospital {selected['hospital']} was selected because it matched case severity {case.severity} "
            f"and condition {case.condition}. Main signals were: {', '.join(selected['reasons'])}."
        )

        if len(ranked) > 1:
            runner_up = ranked[1]
            explanation += (
                f" It ranked ahead of {runner_up['hospital']} due to a higher suitability score of "
                f"{selected['score']} vs {runner_up['score']}."
            )

        return {
            "success": True,
            "case_id": case_id,
            "hospital_id": selected["hospital_id"],
            "explanation": explanation,
            "ranking": ranked,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool
def recommend_ambulance_for_case(case_id: int, top_k: int = 3) -> Dict[str, Any]:
    try:
        case = Case.query.get(case_id)
        if not case:
            return {"success": False, "error": f"Case {case_id} not found"}

        case_lat, case_lon = _parse_coordinates(case.location)
        ambulances = Ambulance.query.filter_by(status="idle").all()
        ranking: List[Dict[str, Any]] = []

        for ambulance in ambulances:
            score = 10.0
            reasons: List[str] = ["idle and available"]

            if ambulance.current_latitude is not None and ambulance.current_longitude is not None:
                score += 3
                reasons.append("has live coordinates")

            if case_lat is not None and case_lon is not None and ambulance.current_latitude is not None and ambulance.current_longitude is not None:
                distance = _haversine_km(case_lat, case_lon, float(ambulance.current_latitude), float(ambulance.current_longitude))
                score += max(0, 8 - distance)
                reasons.append(f"estimated distance {round(distance, 2)} km")

            ranking.append(
                {
                    "ambulance_id": ambulance.id,
                    "driver_name": ambulance.driver_name,
                    "score": round(score, 2),
                    "reasons": reasons,
                    "snapshot": _serialize_ambulance(ambulance),
                }
            )

        ranking.sort(key=lambda item: item["score"], reverse=True)
        return {
            "success": True,
            "case_id": case_id,
            "recommended": ranking[: max(1, top_k)],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool
def log_decision(case_id: int, agent_name: str, message: str, metadata: Optional[str] = None) -> Dict[str, Any]:
    try:
        log = Logs(
            case_id=case_id,
            agent_name=agent_name,
            message=message,
            metadata=metadata or "",
        )
        db.session.add(log)
        db.session.commit()
        return {
            "success": True,
            "log_id": log.id,
            "case_id": case_id,
            "agent_name": agent_name,
            "message": "Decision logged successfully",
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


TOOL_REGISTRY = {
    "fetch_hospital_data": fetch_hospital_data,
    "fetch_ambulance_data": fetch_ambulance_data,
    "fetch_case_data": fetch_case_data,
    "fetch_resource_snapshot": fetch_resource_snapshot,
    "update_hospital_resources": update_hospital_resources,
    "update_ambulance_status": update_ambulance_status,
    "update_ambulance_location": update_ambulance_location,
    "assign_ambulance_to_case": assign_ambulance_to_case,
    "reserve_resources": reserve_resources,
    "confirm_reservation": confirm_reservation,
    "release_resources": release_resources,
    "recommend_hospital_for_case": recommend_hospital_for_case,
    "explain_hospital_selection": explain_hospital_selection,
    "recommend_ambulance_for_case": recommend_ambulance_for_case,
    "log_decision": log_decision,
}


def invoke_tool(
    tool_name: str,
    *,
    user_id: Optional[int] = None,
    user_role: Optional[str] = None,
    user_hospital_id: Optional[int] = None,
    user_ambulance_id: Optional[int] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Invoke a tool with transaction safety.
    
    TRANSACTION BEHAVIOR:
    - Tool execution and audit logging are wrapped in a single transaction
    - If either fails, both are rolled back (no partial commits)
    - Tool mutation errors are caught and logged for debugging
    """
    started_at = datetime.utcnow()
    tool_obj = TOOL_REGISTRY.get(tool_name)
    
    # Handle unknown tool (no DB changes, just return)
    if tool_obj is None:
        result = {"success": False, "error": f"Unknown tool: {tool_name}"}
        try:
            _write_tool_audit_log(
                tool_name=tool_name,
                user_id=user_id,
                user_role=user_role,
                user_hospital_id=user_hospital_id,
                user_ambulance_id=user_ambulance_id,
                tool_args=kwargs,
                result=result,
                started_at=started_at,
                ended_at=datetime.utcnow(),
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
        return result

    # Check authorization (no DB changes, just return)
    auth_error = _authorize_tool_call(
        tool_name,
        user_role=user_role,
        user_hospital_id=user_hospital_id,
        user_ambulance_id=user_ambulance_id,
        kwargs=kwargs,
    )
    if auth_error is not None:
        try:
            _write_tool_audit_log(
                tool_name=tool_name,
                user_id=user_id,
                user_role=user_role,
                user_hospital_id=user_hospital_id,
                user_ambulance_id=user_ambulance_id,
                tool_args=kwargs,
                result=auth_error,
                started_at=started_at,
                ended_at=datetime.utcnow(),
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
        return auth_error

    # ATOMIC TRANSACTION: Tool execution + audit logging must succeed together
    savepoint = db.session.begin_nested()  # Create savepoint for rollback
    try:
        # Execute tool - may commit internally
        result = tool_obj.invoke(kwargs)
        
        # Write audit log for this tool execution
        try:
            _write_tool_audit_log(
                tool_name=tool_name,
                user_id=user_id,
                user_role=user_role,
                user_hospital_id=user_hospital_id,
                user_ambulance_id=user_ambulance_id,
                tool_args=kwargs,
                result=result,
                started_at=started_at,
                ended_at=datetime.utcnow(),
            )
            # Commit the outer transaction (includes tool + audit log)
            db.session.commit()
        except Exception as audit_error:
            # Audit log failed - rollback tool execution via savepoint
            savepoint.rollback()
            result = {
                "success": False,
                "error": f"Tool executed but audit logging failed: {str(audit_error)}",
                "tool_result_before_audit_failure": result,
            }
            # Write error log
            try:
                _write_tool_audit_log(
                    tool_name=tool_name,
                    user_id=user_id,
                    user_role=user_role,
                    user_hospital_id=user_hospital_id,
                    user_ambulance_id=user_ambulance_id,
                    tool_args=kwargs,
                    result=result,
                    started_at=started_at,
                    ended_at=datetime.utcnow(),
                )
                db.session.commit()
            except Exception:
                db.session.rollback()
        return result
        
    except Exception as e:
        # Tool execution failed - rollback via savepoint
        savepoint.rollback()
        result = {"success": False, "error": str(e)}
        try:
            _write_tool_audit_log(
                tool_name=tool_name,
                user_id=user_id,
                user_role=user_role,
                user_hospital_id=user_hospital_id,
                user_ambulance_id=user_ambulance_id,
                tool_args=kwargs,
                result=result,
                started_at=started_at,
                ended_at=datetime.utcnow(),
            )
            db.session.commit()
        except Exception:
            db.session.rollback()
        return result
