from datetime import datetime
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class EmergencyState:
    case_id: Optional[int] = None
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
    chat_intent: Optional[str] = None
    chat_response: str = ""
    # workflow
    workflow_status: str = "started"
    error_message: Optional[str] = None
    # logging
    logs: List[Dict[str, Any]] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "case_id": self.case_id,
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
            "created_at": self.created_at,
            "eta": self.eta,
            "user_message": self.user_message,
            "user_id": self.user_id,
            "chat_intent": self.chat_intent,
            "chat_response": self.chat_response,
            "workflow_status": self.workflow_status,
            "error_message": self.error_message,
            "logs": self.logs,
            "metadata": self.metadata,
        }