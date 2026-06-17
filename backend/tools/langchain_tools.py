from __future__ import annotations

import json
from datetime import datetime
from math import asin, cos, radians, sin, sqrt
from typing import Any, Dict, List, Optional, Tuple
from langchain_core.tools import tool
from sqlalchemy import func
from ..models import Ambulance, Case, Hospital, Logs, Reserved, Resource, db


READ_ONLY_TOOLS = {
    "fetch_hospital_data",
    "fetch_ambulance_data",
    "fetch_case_data",
    "fetch_resource_snapshot",
    "recommend_hospital_for_case",
    "explain_hospital_selection",
    "recommend_ambulance_for_case",
}

ALL_TOOLS = READ_ONLY_TOOLS | {
    "update_hospital_resources",
    "reserve_resources",
    "confirm_reservation",
    "release_resources",
    "update_ambulance_status",
    "update_ambulance_location",
    "assign_ambulance_to_case",
    "log_decision",
    "update_case_status",
    "update_case_data",
}

ROLE_TOOL_ALLOWLIST = {
    "admin": ALL_TOOLS,
    "hospital": READ_ONLY_TOOLS | {
        "update_hospital_resources",
        "reserve_resources",
        "confirm_reservation",
        "release_resources",
        "log_decision",
        "update_case_status",
        "update_case_data",
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
        metadata_json=json.dumps(metadata, default=str),
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

    if kwargs is None:
        kwargs = {}

    # ── Auto-scope read-only tools to the user's own entity ──────────────
    # When a hospital/ambulance user calls a read tool without specifying
    # a specific ID, inject their own entity ID so they only see their own data.
    if role == "hospital" and user_hospital_id is not None:
        if tool_name in {"fetch_hospital_data", "fetch_resource_snapshot"}:
            if kwargs.get("hospital_id") is None:
                kwargs["hospital_id"] = user_hospital_id
        if tool_name == "fetch_case_data":
            if kwargs.get("case_id") is None and kwargs.get("hospital_id") is None:
                kwargs["hospital_id"] = user_hospital_id

    if role == "ambulance" and user_ambulance_id is not None:
        if tool_name == "fetch_ambulance_data":
            if kwargs.get("ambulance_id") is None:
                kwargs["ambulance_id"] = user_ambulance_id
        if tool_name == "fetch_case_data":
            if kwargs.get("case_id") is None and kwargs.get("ambulance_id") is None:
                kwargs["ambulance_id"] = user_ambulance_id

    # ── Mutation ownership checks ────────────────────────────────────────
    if role == "hospital" and tool_name in {"update_hospital_resources", "reserve_resources"}:
        hospital_id = _safe_int(kwargs.get("hospital_id"))
        if user_hospital_id is not None and hospital_id is not None and user_hospital_id != hospital_id:
            return {"success": False, "error": "Hospital users can only act on their own hospital"}

    # confirm_reservation / release_resources only take case_id, so we must
    # look up the case's hospital_id to verify ownership.
    if role == "hospital" and tool_name in {"confirm_reservation", "release_resources", "update_case_status", "update_case_data"}:
        case_id = _safe_int(kwargs.get("case_id"))
        if case_id is not None and user_hospital_id is not None:
            case_obj = Case.query.get(case_id)
            if case_obj and case_obj.hospital_id != user_hospital_id:
                return {"success": False, "error": "Hospital users can only act on cases assigned to their hospital"}

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
    """Fetch hospital(s) data from the database."""
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
    """Fetch ambulance(s) data from the database."""
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
    """Fetch case(s) data from the database."""
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
    """Build a resource snapshot for hospital(s)."""
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
    quantity_change: Optional[int] = None,
    absolute_value: Optional[int] = None,
    total_value: Optional[int] = None,
) -> Dict[str, Any]:
    """Update resource counts for a hospital. Supports relative changes, or setting absolute available/total counts."""
    try:
        hospital = Hospital.query.get(hospital_id)
        if not hospital:
            return {"success": False, "error": f"Hospital {hospital_id} not found"}

        resource_type = resource_type.strip().lower()

        # Normalize resource_type for consistent Resource table lookups
        canonical_type = resource_type
        if resource_type in {"bed", "beds"}:
            canonical_type = "bed"
            if absolute_value is not None:
                hospital.beds_available = max(0, int(absolute_value))
            elif quantity_change is not None:
                hospital.beds_available = max(0, (hospital.beds_available or 0) + int(quantity_change))
            
            if total_value is not None:
                hospital.beds_total = max(hospital.beds_available, int(total_value))
            else:
                hospital.beds_total = max(hospital.beds_available, hospital.beds_total or 0)

        elif resource_type == "icu":
            canonical_type = "icu"
            if absolute_value is not None:
                hospital.icu_available = max(0, int(absolute_value))
            elif quantity_change is not None:
                hospital.icu_available = max(0, (hospital.icu_available or 0) + int(quantity_change))
            
            if total_value is not None:
                hospital.icu_total = max(hospital.icu_available, int(total_value))
            else:
                hospital.icu_total = max(hospital.icu_available, hospital.icu_total or 0)

        elif resource_type in {"ventilator", "ventilators"}:
            canonical_type = "ventilator"
            if absolute_value is not None:
                hospital.ventilators_available = max(0, int(absolute_value))
            elif quantity_change is not None:
                hospital.ventilators_available = max(0, (hospital.ventilators_available or 0) + int(quantity_change))
            
            if total_value is not None:
                hospital.ventilators_total = max(hospital.ventilators_available, int(total_value))
            else:
                hospital.ventilators_total = max(hospital.ventilators_available, hospital.ventilators_total or 0)
        else:
            return {
                "success": False,
                "error": "resource_type must be one of: bed, icu, ventilator",
            }


        # Gap 3 FIX: Keep Resource table in sync with Hospital model
        resource = Resource.query.filter_by(
            hospital_id=hospital.id,
            resource_type=canonical_type,
        ).first()
        if resource:
            # Derive available/total from the Hospital model (source of truth after update)
            if canonical_type == "bed":
                resource.available = hospital.beds_available
                resource.total = hospital.beds_total
            elif canonical_type == "icu":
                resource.available = hospital.icu_available
                resource.total = hospital.icu_total
            elif canonical_type == "ventilator":
                resource.available = hospital.ventilators_available
                resource.total = hospital.ventilators_total
        else:
            # Create the Resource row if it doesn't exist yet
            avail = total = 0
            if canonical_type == "bed":
                avail, total = hospital.beds_available, hospital.beds_total
            elif canonical_type == "icu":
                avail, total = hospital.icu_available, hospital.icu_total
            elif canonical_type == "ventilator":
                avail, total = hospital.ventilators_available, hospital.ventilators_total
            db.session.add(Resource(
                hospital_id=hospital.id,
                resource_type=canonical_type,
                available=avail,
                total=total,
                status="available",
            ))

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
    """Update an ambulance's status."""
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
    """Update an ambulance's current GPS location."""
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
    """Assign an ambulance to a case and synchronize previous assignments."""
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
    """Reserve resources (bed/icu/ventilator) for a case at a hospital."""
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
    """Confirm any pending reservations for a case."""
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
    """Release reserved/confirmed resources for a case, restoring availability."""
    try:
        # Release both 'reserved' and 'confirmed' reservations
        reservations = Reserved.query.filter_by(case_id=case_id).filter(
            Reserved.status.in_(['reserved', 'confirmed'])
        ).all()

        released = []
        for reservation in reservations:
            # Restore availability in the Resource table
            resource = Resource.query.filter_by(
                hospital_id=reservation.hospital_id,
                resource_type=reservation.type,
            ).first()
            if resource:
                resource.available += reservation.quantity
                # Sync Hospital model fields
                hospital = Hospital.query.get(reservation.hospital_id)
                if hospital:
                    if reservation.type == 'icu':
                        hospital.icu_available = min(hospital.icu_total, resource.available)
                    elif reservation.type == 'bed':
                        hospital.beds_available = min(hospital.beds_total, resource.available)
                    elif reservation.type == 'ventilator':
                        hospital.ventilators_available = min(hospital.ventilators_total, resource.available)

            released.append({
                'resource_type': reservation.type,
                'quantity': reservation.quantity,
                'hospital_id': reservation.hospital_id,
            })
            reservation.status = 'cancelled'

        db.session.commit()
        return {
            "success": True,
            "case_id": case_id,
            "released_count": len(released),
            "released": released,
            "message": f"Released {len(released)} reservation(s) for case {case_id}",
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


@tool
def recommend_hospital_for_case(case_id: int, top_k: int = 3) -> Dict[str, Any]:
    """Recommend suitable hospitals for a case based on resources and specialty."""
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
    """Provide an explanation for a hospital selection recommendation."""
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
    """Recommend ambulances for a case, ranking by proximity and availability."""
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
    """Log a decision or event related to a case."""
    try:
        log = Logs(
            case_id=case_id,
            agent_name=agent_name,
            message=message,
            metadata_json=metadata or "",
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


def update_case_status(case_id: int, status: str) -> Dict[str, Any]:
    """Update a case's status.
    
    If the status changes to closed ('discharged', 'failed_escalation', 'resolved'), 
    it will automatically release resources and free the ambulance.
    """
    case = Case.query.get(case_id)
    if not case:
        return {"success": False, "error": f"Case {case_id} not found"}
        
    try:
        old_status = case.status
        case.status = status
        
        # Resource cleanup if case is closed
        CLOSED_STATUSES = ('discharged', 'failed_escalation', 'resolved')
        if status in CLOSED_STATUSES and old_status not in CLOSED_STATUSES:
            # 1. Reset ambulance
            if case.ambulance_id:
                ambulance = Ambulance.query.get(case.ambulance_id)
                if ambulance and ambulance.status == 'assigned':
                    ambulance.status = 'idle'
                    ambulance.current_case_id = None
            
            # 2. Release resources
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
        
        db.session.add(case)
        db.session.commit()
        return {
            "success": True,
            "message": f"Case {case_id} status updated to {status}",
            "case_id": case_id,
            "status": status,
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


def transfer_case_to_another_hospital(case: Case) -> Dict[str, Any]:
    """Transfers a case from its current hospital to the next best available hospital.
    
    Excludes the current hospital from the candidates list.
    Releases resources at the old hospital and reserves them at the new hospital.
    """
    old_hospital_id = case.hospital_id
    if old_hospital_id is None:
        return {"success": False, "error": "Case does not have a hospital assigned to transfer from"}

    # 1. Release resources at the old hospital
    reservations = Reserved.query.filter_by(case_id=case.id, hospital_id=old_hospital_id).filter(
        Reserved.status.in_(['reserved', 'confirmed'])
    ).all()
    for res in reservations:
        resource = Resource.query.filter_by(
            hospital_id=old_hospital_id,
            resource_type=res.type
        ).first()
        if resource:
            resource.available += res.quantity
            hosp = Hospital.query.get(old_hospital_id)
            if hosp:
                if res.type == 'icu':
                    hosp.icu_available = min(hosp.icu_total, resource.available)
                elif res.type == 'bed':
                    hosp.beds_available = min(hosp.beds_total, resource.available)
                elif res.type == 'ventilator':
                    hosp.ventilators_available = min(hosp.ventilators_total, resource.available)
        res.status = 'cancelled'

    # 2. Select the new hospital (excluding the old one)
    hospitals = Hospital.query.filter(Hospital.id != old_hospital_id).all()
    if not hospitals:
        return {"success": False, "error": "No other hospitals available for transfer"}

    required_specialty = _required_specialty_for_condition(case.condition)
    candidate_hospitals = []
    for hosp in hospitals:
        if required_specialty == "cardiology" and not hosp.has_cardiology:
            continue
        if required_specialty == "trauma_care" and not hosp.has_trauma_care:
            continue
        candidate_hospitals.append(hosp)

    if not candidate_hospitals:
        return {
            "success": False,
            "error": f"No other hospital with required {required_specialty or 'specialty'} is available"
        }

    suitable_hospitals = []
    for hosp in candidate_hospitals:
        lat1, lon1 = _parse_coordinates(case.location)
        lat2, lon2 = hosp.latitude, hosp.longitude
        distance = 9999.0
        if lat1 is not None and lon1 is not None and lat2 is not None and lon2 is not None:
            distance = _haversine_km(lat1, lon1, lat2, lon2)

        if case.severity in ('P0', 'P1'):
            if hosp.icu_available > 0 and hosp.beds_available > 0:
                suitable_hospitals.append((hosp, distance))
        else:
            if hosp.beds_available > 0:
                suitable_hospitals.append((hosp, distance))

    if not suitable_hospitals:
        for hosp in candidate_hospitals:
            if hosp.beds_available > 0:
                lat1, lon1 = _parse_coordinates(case.location)
                lat2, lon2 = hosp.latitude, hosp.longitude
                distance = 9999.0
                if lat1 is not None and lon1 is not None and lat2 is not None and lon2 is not None:
                    distance = _haversine_km(lat1, lon1, lat2, lon2)
                suitable_hospitals.append((hosp, distance))

    if not suitable_hospitals:
        return {"success": False, "error": "No other hospitals have available beds for transfer"}

    suitable_hospitals.sort(key=lambda x: (x[1], -x[0].icu_available, -x[0].beds_available))
    new_hospital, distance = suitable_hospitals[0]

    # 3. Reserve resources at the new hospital
    needs = []
    if case.severity in ('P0', 'P1'):
        needs.append({'type': 'icu', 'quantity': 1})
        if 'respiratory' in (case.condition or '').lower() or 'asthma' in (case.condition or '').lower():
            needs.append({'type': 'ventilator', 'quantity': 1})
        elif case.severity == 'P0':
            needs.append({'type': 'ventilator', 'quantity': 1})
        needs.append({'type': 'bed', 'quantity': 1})
    else:
        needs.append({'type': 'bed', 'quantity': 1})

    allocated_resources = []
    for need in needs:
        rtype = need['type']
        qty = need['quantity']
        res_avail = Resource.query.filter_by(hospital_id=new_hospital.id, resource_type=rtype).first()
        if res_avail and res_avail.available >= qty:
            new_res = Reserved(case_id=case.id, hospital_id=new_hospital.id, type=rtype, quantity=qty, status='confirmed')
            db.session.add(new_res)
            res_avail.available -= qty
            if rtype == 'icu':
                new_hospital.icu_available = res_avail.available
            elif rtype == 'bed':
                new_hospital.beds_available = res_avail.available
            elif rtype == 'ventilator':
                new_hospital.ventilators_available = res_avail.available
            allocated_resources.append(f"{qty} {rtype}")
        else:
            if rtype == 'icu':
                bed_res = Resource.query.filter_by(hospital_id=new_hospital.id, resource_type='bed').first()
                if bed_res and bed_res.available >= qty:
                    new_res = Reserved(case_id=case.id, hospital_id=new_hospital.id, type='bed', quantity=qty, status='confirmed')
                    db.session.add(new_res)
                    bed_res.available -= qty
                    new_hospital.beds_available = bed_res.available
                    allocated_resources.append(f"{qty} bed (fallback for icu)")

    case.hospital_id = new_hospital.id
    case.status = 'resolved'

    transfer_log = Logs(
        case_id=case.id,
        agent_name='case_transfer',
        message=f"Case transferred from hospital {old_hospital_id} to {new_hospital.id} ({new_hospital.name})",
        metadata_json=json.dumps({
            "old_hospital_id": old_hospital_id,
            "new_hospital_id": new_hospital.id,
            "allocated_resources": allocated_resources,
            "distance_km": round(distance, 2) if distance != 9999 else None,
            "timestamp": datetime.utcnow().isoformat()
        }, default=str)
    )
    db.session.add(transfer_log)

    return {
        "success": True,
        "message": f"Case transferred to hospital {new_hospital.name} successfully",
        "hospital_id": new_hospital.id,
        "hospital_name": new_hospital.name,
        "status": case.status
    }


@tool
def update_case_data(
    case_id: int,
    status: Optional[str] = None,
    hospital_id: Optional[int] = None,
    ambulance_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Update case details including status, hospital_id (transfer), or ambulance_id."""
    case = Case.query.get(case_id)
    if not case:
        return {"success": False, "error": f"Case {case_id} not found"}

    try:
        changes = []
        old_status = case.status

        # 1. Update Hospital (Transfer Case)
        if hospital_id is not None and case.hospital_id != hospital_id:
            old_hosp_id = case.hospital_id
            new_hospital = Hospital.query.get(hospital_id)
            if not new_hospital:
                return {"success": False, "error": f"Hospital {hospital_id} not found"}

            required_speciality = _required_specialty_for_condition(case.condition)
            if required_speciality == "cardiology" and not new_hospital.has_cardiology:
                return {"success": False, "error": f"Hospital {new_hospital.name} does not have cardiology specialty required for this case"}
            if required_speciality == "trauma_care" and not new_hospital.has_trauma_care:
                return {"success": False, "error": f"Hospital {new_hospital.name} does not have trauma care specialty required for this case"}

            # Release resources at old hospital
            if old_hosp_id is not None:
                reservations = Reserved.query.filter_by(case_id=case.id, hospital_id=old_hosp_id).filter(
                    Reserved.status.in_(['reserved', 'confirmed'])
                ).all()
                for res in reservations:
                    resource = Resource.query.filter_by(
                        hospital_id=old_hosp_id,
                        resource_type=res.type
                    ).first()
                    if resource:
                        resource.available += res.quantity
                        hosp = Hospital.query.get(old_hosp_id)
                        if hosp:
                            if res.type == 'icu':
                                hosp.icu_available = min(hosp.icu_total, resource.available)
                            elif res.type == 'bed':
                                hosp.beds_available = min(hosp.beds_total, resource.available)
                            elif res.type == 'ventilator':
                                hosp.ventilators_available = min(hosp.ventilators_total, resource.available)
                    res.status = 'cancelled'

            # Allocate resources at new hospital
            needs = []
            if case.severity in ('P0', 'P1'):
                needs.append({'type': 'icu', 'quantity': 1})
                if 'respiratory' in (case.condition or '').lower() or 'asthma' in (case.condition or '').lower():
                    needs.append({'type': 'ventilator', 'quantity': 1})
                elif case.severity == 'P0':
                    needs.append({'type': 'ventilator', 'quantity': 1})
                needs.append({'type': 'bed', 'quantity': 1})
            else:
                needs.append({'type': 'bed', 'quantity': 1})

            for need in needs:
                rtype = need['type']
                qty = need['quantity']
                res_avail = Resource.query.filter_by(hospital_id=hospital_id, resource_type=rtype).first()
                if res_avail and res_avail.available >= qty:
                    new_res = Reserved(case_id=case.id, hospital_id=hospital_id, type=rtype, quantity=qty, status='confirmed')
                    db.session.add(new_res)
                    res_avail.available -= qty
                    if rtype == 'icu':
                        new_hospital.icu_available = res_avail.available
                    elif rtype == 'bed':
                        new_hospital.beds_available = res_avail.available
                    elif rtype == 'ventilator':
                        new_hospital.ventilators_available = res_avail.available
                else:
                    if rtype == 'icu':
                        bed_res = Resource.query.filter_by(hospital_id=hospital_id, resource_type='bed').first()
                        if bed_res and bed_res.available >= qty:
                            new_res = Reserved(case_id=case.id, hospital_id=hospital_id, type='bed', quantity=qty, status='confirmed')
                            db.session.add(new_res)
                            bed_res.available -= qty
                            new_hospital.beds_available = bed_res.available
                        else:
                            return {"success": False, "error": f"Hospital {new_hospital.name} does not have sufficient beds/ICU resources available"}
                    elif rtype == 'ventilator':
                        if case.severity == 'P0' or 'respiratory' in (case.condition or '').lower():
                            return {"success": False, "error": f"Hospital {new_hospital.name} does not have sufficient ventilator resources available"}
                    else:
                        return {"success": False, "error": f"Hospital {new_hospital.name} does not have sufficient {rtype} resources available"}

            case.hospital_id = hospital_id
            changes.append(f"hospital changed from {old_hosp_id} to {hospital_id}")

            if case.status == 'failed_escalation':
                case.status = 'resolved'
                changes.append("status changed from failed_escalation to resolved")

            log = Logs(
                case_id=case.id,
                agent_name='update_case_data',
                message=f"Hospital assignment changed from {old_hosp_id} to {hospital_id}",
                metadata_json=json.dumps({
                    "old_hospital_id": old_hosp_id,
                    "new_hospital_id": hospital_id,
                    "timestamp": datetime.utcnow().isoformat()
                }, default=str)
            )
            db.session.add(log)

        # 2. Update Ambulance assignment
        if ambulance_id is not None and case.ambulance_id != ambulance_id:
            assign_res = assign_ambulance_to_case.__wrapped__(ambulance_id=ambulance_id, case_id=case.id)
            if not assign_res.get('success'):
                return assign_res
            changes.append(f"ambulance assigned to {ambulance_id}")

        # 3. Update Status
        if status is not None and case.status != status:
            case.status = status
            changes.append(f"status updated to {status}")

            CLOSED_STATUSES = ('discharged', 'failed_escalation', 'resolved')
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

        if not changes:
            return {"success": True, "message": "No changes requested for case", "case_id": case.id}

        db.session.add(case)
        db.session.commit()
        return {
            "success": True,
            "message": f"Case {case.id} updated successfully: {', '.join(changes)}",
            "case_id": case.id,
            "status": case.status,
            "hospital_id": case.hospital_id,
            "ambulance_id": case.ambulance_id,
        }
    except Exception as e:
        db.session.rollback()
        return {"success": False, "error": str(e)}


TOOL_REGISTRY = {
    "update_case_status": update_case_status,
    "update_case_data": update_case_data,  # Map to new robust case data update tool
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
        # Handle both @tool-decorated functions (.invoke) and plain functions
        if hasattr(tool_obj, 'invoke'):
            result = tool_obj.invoke(kwargs)
        else:
            result = tool_obj(**kwargs)
        
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
