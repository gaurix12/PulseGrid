"""
Alert routing rules:
- P0 (Critical): Alert hospital staff + ambulance crew + admins
- P1 (High): Alert hospital staff + ambulance crew
- P2 (Medium): Alert ambulance crew only
- P3 (Low): Log only, no active alerts
"""

from typing import Any, Dict, List
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
from ..models import User, Case, Ambulance, Hospital, Logs, db


class AlertAgent:
    def __init__(self, llm: Any = None):
        self.llm = llm
        
        self.response_schemas = [
            ResponseSchema(name='alerts', description='List of alert objects: [{"user_id": N, "recipient_type": "hospital"/"ambulance"/"admin", "message": "..."}]'),
            ResponseSchema(name='priority', description='Alert priority level: high/medium/low'),
            ResponseSchema(name='requires_escalation', description='True if case needs escalation, False otherwise')
        ]
        self.output_parser = StructuredOutputParser.from_response_schemas(self.response_schemas)
        self.format_instructions = self.output_parser.get_format_instructions()
        
        self.prompt = PromptTemplate(
            input_variables=['case_id', 'severity', 'condition', 'location', 'ambulance_name', 'hospital_name', 'resource_status'],
            template="""You are an emergency alert routing system for a medical dispatch platform.

Case ID: {case_id}
Severity Level: {severity}
Patient Condition: {condition}
Patient Location: {location}
Assigned Ambulance: {ambulance_name}
Assigned Hospital: {hospital_name}
Resource Status: {resource_status}

Alert Routing Rules:
- P0 (Critical): Alert hospital staff + ambulance crew + system admins with full case details
- P1 (High): Alert hospital staff + ambulance crew with condition and resource info
- P2 (Medium): Alert ambulance crew with patient condition and location
- P3 (Low): No alerts needed, log only

Determine who needs to be alerted and compose concise, actionable alert messages for each recipient type.

{format_instructions}"""
        )

    def send_alerts(self, case: Case) -> Dict[str, Any]:
        """Route and send alerts based on case severity and status."""
        if not case:
            return {
                "success": False,
                "reason": "Case not found",
                "alerts_sent": []
            }

        # Determine alert recipients based on severity
        severity_level = case.severity
        alerts_to_send = self._determine_alert_recipients(severity_level)

        if not alerts_to_send:
            return {
                "success": True,
                "reason": f"No alerts required for {severity_level}",
                "alerts_sent": []
            }

        # Get case context for LLM
        ambulance_name = f"Ambulance {case.ambulance.id}" if case.ambulance else "Unknown"
        hospital_name = case.hospital.name if case.hospital else "TBD"
        resource_status = self._get_resource_status(case)

        # Get LLM decision on alert messaging if available
        llm_decision = None
        if self.llm:
            try:
                llm_input = self.prompt.format(
                    case_id=case.id,
                    severity=severity_level,
                    condition=case.condition,
                    location=case.location,
                    ambulance_name=ambulance_name,
                    hospital_name=hospital_name,
                    resource_status=resource_status
                )
                llm_output = self.llm.invoke(llm_input)
                llm_decision = self.output_parser.parse(llm_output.content)
            except Exception as e:
                llm_decision = None

        if llm_decision:
            result = self._execute_llm_alerts(case, llm_decision, alerts_to_send)
        else:
            result = self._execute_deterministic_alerts(case, alerts_to_send)

        db.session.commit()
        return result

    def _determine_alert_recipients(self, severity_level: str) -> List[str]:
        recipients = {
            'P0': ['hospital', 'ambulance', 'admin'],
            'P1': ['hospital', 'ambulance'],
            'P2': ['ambulance'],
            'P3': []  # No alerts, log only
        }
        return recipients.get(severity_level, [])

    def _execute_llm_alerts(self, case: Case, llm_decision: Dict, recipient_types: List[str]) -> Dict[str, Any]:
        alerts = llm_decision.get('alerts', [])
        if isinstance(alerts, str):
            import json
            try:
                alerts = json.loads(alerts)
            except:
                alerts = []

        sent_alerts = []
        failed_alerts = []

        for alert in alerts:
            user_id = alert.get('user_id')
            recipient_type = alert.get('recipient_type')
            message = alert.get('message')

            if user_id and recipient_type and message:
                user = User.query.get(user_id)
                if user and user.role in self._role_for_recipient_type(recipient_type):
                    sent_alerts.append({
                        "user_id": user_id,
                        "recipient_type": recipient_type,
                        "message": message,
                        "case_id": case.id
                    })
                else:
                    failed_alerts.append({
                        "user_id": user_id,
                        "reason": "Invalid user or role mismatch"
                    })

        log = Logs(
            case_id=case.id,
            agent_name='alert_agent',
            message=f"LLM-based alerts sent to {len(sent_alerts)} users",
            metadata=f"Priority: {llm_decision.get('priority', 'medium')}, Escalation: {llm_decision.get('requires_escalation', False)}"
        )
        db.session.add(log)

        return {
            "success": len(failed_alerts) == 0,
            "case_id": case.id,
            "severity": case.severity,
            "alerts_sent": sent_alerts,
            "failed_alerts": failed_alerts,
            "llm_priority": llm_decision.get('priority', 'medium'),
            "escalation_needed": llm_decision.get('requires_escalation', False),
            "count": len(sent_alerts)
        }

    def _execute_deterministic_alerts(self, case: Case, recipient_types: List[str]) -> Dict[str, Any]:
        """Execute alerts using deterministic rule-based messages."""
        sent_alerts = []

        for recipient_type in recipient_types:
            if recipient_type == 'hospital' and case.hospital:
                # Alert all hospital staff at assigned hospital
                hospital_staff = User.query.filter_by(
                    hospital_id=case.hospital.id,
                    role='hospital'
                ).all()
                message = self._generate_hospital_message(case)
                for staff in hospital_staff:
                    sent_alerts.append({
                        "user_id": staff.id,
                        "recipient_type": "hospital",
                        "message": message,
                        "case_id": case.id
                    })

            elif recipient_type == 'ambulance' and case.ambulance:
                ambulance_crew = User.query.filter_by(
                    ambulance_id=case.ambulance.id,
                    role='ambulance'
                ).all()
                message = self._generate_ambulance_message(case)
                for crew in ambulance_crew:
                    sent_alerts.append({
                        "user_id": crew.id,
                        "recipient_type": "ambulance",
                        "message": message,
                        "case_id": case.id
                    })

            elif recipient_type == 'admin':
                # Alert all admins
                admins = User.query.filter_by(role='admin').all()
                message = self._generate_admin_message(case)
                for admin in admins:
                    sent_alerts.append({
                        "user_id": admin.id,
                        "recipient_type": "admin",
                        "message": message,
                        "case_id": case.id
                    })

        log = Logs(
            case_id=case.id,
            agent_name='alert_agent',
            message=f"Deterministic alerts sent to {len(sent_alerts)} users",
            metadata=f"Severity: {case.severity}"
        )
        db.session.add(log)

        return {
            "success": True,
            "case_id": case.id,
            "severity": case.severity,
            "alerts_sent": sent_alerts,
            "count": len(sent_alerts),
            "note": "Deterministic alerts (LLM unavailable)"
        }

    def _generate_hospital_message(self, case: Case) -> str:
        resource_status = self._get_resource_status(case)
        return f"ALERT: {case.severity} case received. Patient condition: {case.condition}. Location: {case.location}. Resources needed: {resource_status}"

    def _generate_ambulance_message(self, case: Case) -> str:
        return f"DISPATCH: Case {case.id} - {case.condition}. Patient at {case.location}. Severity: {case.severity}. Hospital: {case.hospital.name if case.hospital else 'TBD'}"

    def _generate_admin_message(self, case: Case) -> str:
        return f"CRITICAL ALERT: Case {case.id} ({case.severity}) - Patient: {case.patient_name}, Condition: {case.condition}, Location: {case.location}. Ambulance: {case.ambulance.id if case.ambulance else 'Unassigned'}, Hospital: {case.hospital.name if case.hospital else 'Unassigned'}"

    def _get_resource_status(self, case: Case) -> str:
        if not case.hospital:
            return "Hospital not yet assigned"

        from ..agents.resource_allocation_agent import ResourceAllocationAgent
        res_agent = ResourceAllocationAgent()
        needs = res_agent._get_resource_needs(case.severity, case.condition)

        return ", ".join([f"{n['quantity']} {n['type']}" for n in needs])

    def _role_for_recipient_type(self, recipient_type: str) -> List[str]:
        mapping = {
            'hospital': ['hospital'],
            'ambulance': ['ambulance'],
            'admin': ['admin']
        }
        return mapping.get(recipient_type, [])
                      