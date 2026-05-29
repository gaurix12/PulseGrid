from datetime import datetime
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import json


@dataclass
class EmergencyState:
    """Issue #25: Add versioning for replayability; ensure JSON-safe serialization"""
    __version__ = 1  # Schema version for future evolution
    
    case_id: Optional[int] = None
    case_status: Optional[str] = "created"
    patient_name: str = ""
    patient_details: str = ""

    # triage
    severity: Optional[str] = None
    condition: Optional[str] = None
    # dispatch / selection
    ambulance_id: Optional[int] = None
    hospital_id: Optional[int] = None
    hospital_name: Optional[str] = None
    dispatch_reasoning: Optional[str] = None
    hospital_selection_reasoning: Optional[str] = None
    # resource allocation
    allocation_plan: List[Dict[str, Any]] = field(default_factory=list)
    allocated_resources: List[Dict[str, Any]] = field(default_factory=list)
    failed_resources: List[Dict[str, Any]] = field(default_factory=list)
    allocation_success: bool = False
    allocation_reasoning: Optional[str] = None
    llm_rationale: Optional[str] = None
    alternative_strategy: Optional[str] = None
    escalation_needed: Optional[bool] = None
    # alerts
    alerts_sent: List[Dict[str, Any]] = field(default_factory=list)
    failed_alerts: List[Dict[str, Any]] = field(default_factory=list)
    alerts_count: int = 0
    llm_priority: Optional[str] = None
    # location / timing
    location: str = ""
    created_at: Optional[datetime] = None
    eta: Optional[int] = None
    # chat interaction
    user_message: Optional[str] = None
    user_id: Optional[int] = None
    user_role: Optional[str] = None
    hospital_user_id: Optional[int] = None
    ambulance_user_id: Optional[int] = None
    chat_intent: Optional[str] = None
    chat_response: str = ""
    # workflow
    workflow_status: str = "started"
    error_message: Optional[str] = None
    # logging
    logs: List[Dict[str, Any]] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Issue #25: Ensure all fields are JSON-safe (convert datetime to ISO string)"""
        return {
            "__version__": self.__version__,  # Include schema version
            "case_id": self.case_id,
            "case_status": self.case_status,
            "patient_name": self.patient_name,
            "patient_details": self.patient_details,
            "severity": self.severity,
            "condition": self.condition,
            "ambulance_id": self.ambulance_id,
            "hospital_id": self.hospital_id,
            "hospital_name": self.hospital_name,
            "dispatch_reasoning": self.dispatch_reasoning,
            "hospital_selection_reasoning": self.hospital_selection_reasoning,
            "allocation_plan": self.allocation_plan,
            "allocated_resources": self.allocated_resources,
            "failed_resources": self.failed_resources,
            "allocation_success": self.allocation_success,
            "allocation_reasoning": self.allocation_reasoning,
            "llm_rationale": self.llm_rationale,
            "alternative_strategy": self.alternative_strategy,
            "escalation_needed": self.escalation_needed,
            "alerts_sent": self.alerts_sent,
            "failed_alerts": self.failed_alerts,
            "alerts_count": self.alerts_count,
            "llm_priority": self.llm_priority,
            "location": self.location,
            "created_at": self.created_at.isoformat() if self.created_at else None,  # Convert datetime to ISO string
            "eta": self.eta,
            "user_message": self.user_message,
            "user_id": self.user_id,
            "user_role": self.user_role,
            "hospital_user_id": self.hospital_user_id,
            "ambulance_user_id": self.ambulance_user_id,
            "chat_intent": self.chat_intent,
            "chat_response": self.chat_response,
            "workflow_status": self.workflow_status,
            "error_message": self.error_message,
            "logs": self.logs,
            "metadata": self.metadata,
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "EmergencyState":
        """Issue #25: Deserialize from stored snapshot (supports schema versioning for replay)"""
        version = data.get("__version__", 1)
        if version != cls.__version__:
            raise ValueError(f"Schema version mismatch: {version} != {cls.__version__}")
        
        # Parse ISO datetime back to datetime object
        created_at = None
        if data.get("created_at") and isinstance(data.get("created_at"), str):
            created_at = datetime.fromisoformat(data["created_at"])
        elif data.get("created_at") and isinstance(data.get("created_at"), datetime):
            created_at = data["created_at"]
        
        return cls(
            case_id=data.get("case_id"),
            case_status=data.get("case_status", "created"),
            patient_name=data.get("patient_name", ""),
            patient_details=data.get("patient_details", ""),
            severity=data.get("severity"),
            condition=data.get("condition"),
            ambulance_id=data.get("ambulance_id"),
            hospital_id=data.get("hospital_id"),
            hospital_name=data.get("hospital_name"),
            dispatch_reasoning=data.get("dispatch_reasoning"),
            hospital_selection_reasoning=data.get("hospital_selection_reasoning"),
            allocation_plan=data.get("allocation_plan", []),
            allocated_resources=data.get("allocated_resources", []),
            failed_resources=data.get("failed_resources", []),
            allocation_success=data.get("allocation_success", False),
            allocation_reasoning=data.get("allocation_reasoning"),
            llm_rationale=data.get("llm_rationale"),
            alternative_strategy=data.get("alternative_strategy"),
            escalation_needed=data.get("escalation_needed"),
            alerts_sent=data.get("alerts_sent", []),
            failed_alerts=data.get("failed_alerts", []),
            alerts_count=data.get("alerts_count", 0),
            llm_priority=data.get("llm_priority"),
            location=data.get("location", ""),
            created_at=created_at,
            eta=data.get("eta"),
            user_message=data.get("user_message"),
            user_id=data.get("user_id"),
            user_role=data.get("user_role"),
            hospital_user_id=data.get("hospital_user_id"),
            ambulance_user_id=data.get("ambulance_user_id"),
            chat_intent=data.get("chat_intent"),
            chat_response=data.get("chat_response", ""),
            workflow_status=data.get("workflow_status", "started"),
            error_message=data.get("error_message"),
            logs=data.get("logs", []),
            metadata=data.get("metadata", {}),
        )