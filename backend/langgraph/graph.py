import json
from ..models import Case,db, Logs, Hospital, Ambulance
from langgraph.graph import StateGraph, START,END
from langchain.chat_models import init_chat_model
from .state import EmergencyState
from ..agents.alert_agent import AlertAgent
from ..agents.triage_agent import TriageAgent
from ..agents.dispatch_agent import DispatchAgent
from ..agents.hospital_selection_agent import HospitalSelectionAgent
from ..agents.resource_allocation_agent import ResourceAllocationAgent
from ..agents.chat_agent import ChatAgent
from ..tools.langchain_tools import invoke_tool
from typing import Any, Dict, List, Optional
from datetime import datetime
class EmergencyDispatchGraph:
    def __init__(self, llm: Optional[Any] = None):
        self.llm = llm 
        self.triage_agent = TriageAgent(llm)
        self.dispatch_agent = DispatchAgent(llm)
        self.hospital_selection_agent = HospitalSelectionAgent(llm)
        self.resource_allocation_agent = ResourceAllocationAgent(llm)
        self.alert_agent = AlertAgent(llm)
        self.chat_agent = ChatAgent(llm)
    def build_graph(self) -> StateGraph:

        graph_builder = StateGraph(EmergencyState)
        graph_builder.add_node("triage", self.triage_node)
        graph_builder.add_node("create_case", self.create_case_node)
        graph_builder.add_node("dispatch", self.dispatch_node)
        graph_builder.add_node("hospital_selection", self.hospital_selection_node)
        graph_builder.add_node("resource_allocation", self.resource_allocation_node)
        graph_builder.add_node("alert", self.alert_node)
        graph_builder.add_node("chat", self.chat_node)
        graph_builder.add_node("finalise", self.finalise_node)

        graph_builder.add_edge(START, "triage")
        graph_builder.add_edge("triage","create_case")
        graph_builder.add_edge("create_case","dispatch")
        graph_builder.add_edge("dispatch","hospital_selection")
        graph_builder.add_edge("hospital_selection","resource_allocation")
        graph_builder.add_edge("resource_allocation","alert")
        graph_builder.add_edge("alert","finalise")
        graph_builder.add_edge("finalise", END)

        graph = graph_builder.compile()
        return graph

    def build_chat_graph(self) -> StateGraph:
        graph_builder = StateGraph(EmergencyState)
        graph_builder.add_node("chat", self.chat_node)
        graph_builder.add_node("finalise", self.finalise_node)

        graph_builder.add_edge(START, "chat")
        graph_builder.add_edge("chat", "finalise")
        graph_builder.add_edge("finalise", END)

        return graph_builder.compile()

    def _log_state_snapshot(self, state: EmergencyState, stage: str) -> None:
        if not state:
            return

        snapshot = state.to_dict() if hasattr(state, "to_dict") else {}
        log = Logs(
            case_id=state.case_id,
            agent_name="workflow_state_snapshot",
            message=f"EmergencyState snapshot after {stage}",
            metadata_json=json.dumps({
                "stage": stage,
                "workflow_status": state.workflow_status,
                "case_status": state.case_status,
                "snapshot": snapshot,
            }, default=str),
        )
        db.session.add(log)
        db.session.commit()
    
    def triage_node(self, state: EmergencyState) -> EmergencyState:
        
        try:
            if not state or not state.patient_details:
                state.error_message = "No patient details provided for triage"
                return state

            triage_result = self.triage_agent.triage(state.patient_details)
            state.severity = triage_result.get('severity')
            state.condition = triage_result.get('condition')
            state.created_at = datetime.utcnow()
            state.case_status = 'triaged'
            state.workflow_status = 'triaged'

            if not state.case_id:
                patient_name = state.patient_name or "Unknown Patient"
                condition = state.condition or state.metadata.get('condition', 'Unknown')
                severity = state.severity or 'P3'
                location = state.location or state.metadata.get('location', 'Unknown')

                new_case = Case(
                    patient_name=patient_name,
                    condition=condition,
                    severity=severity,
                    location=location,
                    status='triaged'
                )
                db.session.add(new_case)
                db.session.commit()

                state.case_id = new_case.id
                state.patient_name = new_case.patient_name
                state.condition = new_case.condition
                state.severity = new_case.severity
                state.location = new_case.location
                state.case_status = new_case.status

                log = Logs(
                    case_id=new_case.id,
                    agent_name='triage_node',
                    message=f"Case created during triage: severity={state.severity}, condition={state.condition}",
                    metadata_json=''
                )
                db.session.add(log)
                db.session.commit()
                
                state.logs.append({
                    "agent": "triage_node",
                    "message": f"Case created during triage: severity={state.severity}, condition={state.condition}",
                    "metadata": ""
                })
                self._log_state_snapshot(state, "triage")
                return state

            state.logs.append({
                "agent": "triage_agent",
                "message": f"Triage: severity={state.severity}, condition={state.condition}",
                "metadata": ""
            })

            self._log_state_snapshot(state, "triage")

            return state
        except Exception as e:
            state.error_message = str(e)
            self._log_state_snapshot(state, "triage_error")  
            return state

    def create_case_node(self, state: EmergencyState) -> EmergencyState:
        try:
            if state.case_id:
                existing_case = Case.query.get(state.case_id)
                if not existing_case:
                    state.error_message = f'Case {state.case_id} not found'
                    return state

                if state.patient_name:
                    existing_case.patient_name = state.patient_name
                if state.condition:
                    existing_case.condition = state.condition
                if state.severity:
                    existing_case.severity = state.severity
                if state.location:
                    existing_case.location = state.location
                if not existing_case.status or existing_case.status == 'created':
                    existing_case.status = 'triaged'

                db.session.add(existing_case)
                db.session.commit()

                state.patient_name = existing_case.patient_name
                state.condition = existing_case.condition
                state.severity = existing_case.severity
                state.location = existing_case.location
                state.case_status = existing_case.status
                state.workflow_status = 'triaged'
                return state

            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            self._log_state_snapshot(state, "create_case_error")  
            return state

    def dispatch_node(self, state: EmergencyState) -> EmergencyState:
        try:
            if not state.case_id:
                state.error_message = 'No case_id present for dispatch'
                return state

            case = Case.query.with_for_update().get(state.case_id)  
            if not case:
                state.error_message = f'Case {state.case_id} not found'
                return state
            dispatch_result = self.dispatch_agent.dispatch(case, case.location or state.location)
            amb_id = dispatch_result.get('ambulance_id')
            hosp_id = dispatch_result.get('hospital_id')

            if hosp_id:
                case.hospital_id = hosp_id

            assignment_result = None
            if amb_id:
                assignment_result = invoke_tool(
                    "assign_ambulance_to_case",
                    user_role="admin",
                    ambulance_id=amb_id,
                    case_id=case.id,
                )
                if not assignment_result.get('success'):
                    db.session.rollback()
                    state.error_message = assignment_result.get('error', 'Failed to assign ambulance to case')
                    return state

            case.status = 'dispatched'

            db.session.add(case)
            log = Logs(
                case_id=case.id,
                agent_name='dispatch_node',
                message=f"Dispatch result: ambulance={amb_id}, hospital={hosp_id}",
                metadata_json=str({
                    "dispatch_reasoning": dispatch_result.get('reasoning', ''),
                    "assignment_result": assignment_result,
                }),
            )
            db.session.add(log)
            db.session.commit()
            state.ambulance_id = assignment_result.get('ambulance_id', amb_id) if assignment_result else amb_id
            state.hospital_id = hosp_id
            state.dispatch_reasoning = dispatch_result.get('reasoning')
            state.workflow_status = 'dispatched'
            state.case_status = case.status

            self._log_state_snapshot(state, "dispatch")
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            self._log_state_snapshot(state, "dispatch_error")  
            return state

    def hospital_selection_node(self, state: EmergencyState) -> EmergencyState:
        try:
            if not state.case_id:
                state.error_message = 'No case_id present for hospital selection'
                return state

            case = Case.query.get(state.case_id)
            if not case:
                state.error_message = f'Case {state.case_id} not found'
                return state
            
            if state.hospital_id:
                if case.status == 'dispatched':
                    case.status = 'arrived'
                    db.session.add(case)
                    db.session.commit()
                
                log = Logs(
                    case_id=case.id,
                    agent_name='hospital_selection_node',
                    message=f"Hospital selection skipped: already assigned by dispatch node",
                    metadata_json=json.dumps({
                        "hospital_id": state.hospital_id,
                        "hospital_name": state.hospital_name,
                        "source": "dispatch_node",
                        "skipped": True,
                        "stage": "hospital_selection"
                    }, default=str)
                )
                db.session.add(log)
                db.session.commit()
                
                state.workflow_status = 'arrived'
                state.case_status = case.status
                return state
            
            sel_result = self.hospital_selection_agent.select_hospital(case)
            hosp_id = sel_result.get('hospital_id')
            reasoning = sel_result.get('reasoning')

            if hosp_id:
                case.hospital_id = hosp_id
                case.status = 'arrived'
                db.session.add(case)
                db.session.commit()

                hosp = Hospital.query.get(hosp_id)
                state.hospital_id = hosp_id
                state.hospital_name = hosp.name if hosp else None
                state.hospital_selection_reasoning = reasoning
                
                log = Logs(
                    case_id=case.id,
                    agent_name='hospital_selection_node',
                    message=f"Hospital selected: {hosp_id}",
                    metadata_json=reasoning
                )
                db.session.add(log)
                db.session.commit()
            else:
                state.error_message = f"Hospital selection failed: no suitable hospital found. Reasoning: {reasoning}"
                return state

            state.workflow_status = 'arrived'
            state.case_status = case.status
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            self._log_state_snapshot(state, "hospital_selection_error")  
            return state

    def resource_allocation_node(self, state: EmergencyState) -> EmergencyState:
        try:
            if not state.case_id or not state.hospital_id:
                state.error_message = 'Case or hospital missing for allocation'
                return state

            case = Case.query.get(state.case_id)
            hospital = Hospital.query.get(state.hospital_id)
            if not case or not hospital:
                state.error_message = 'Case or Hospital not found for allocation'
                return state

            alloc_result = self.resource_allocation_agent.allocate_resources(case, hospital)
            state.allocated_resources = alloc_result.get('allocated', [])
            state.failed_resources = alloc_result.get('failed', [])
            state.allocation_success = alloc_result.get('success', False)
            state.allocation_reasoning = alloc_result.get('reasoning') or alloc_result.get('note')
            state.llm_rationale = alloc_result.get('llm_rationale')
            state.alternative_strategy = alloc_result.get('alternative_strategy')
            state.escalation_needed = alloc_result.get('escalation_needed', False)
            if not state.allocation_success:
                state.error_message = f"Resource allocation failed: {state.allocation_reasoning}"
                return state
            case.status = 'resolved' if state.allocation_success else 'arrived'

            # log allocation
            log = Logs(case_id=case.id, agent_name='resource_allocation_node', message=f"Allocation: success={state.allocation_success}", metadata_json=state.allocation_reasoning)
            db.session.add(log)
            db.session.commit()

            state.workflow_status = 'resolved' if state.allocation_success else 'arrived'
            state.case_status = case.status

            self._log_state_snapshot(state, "allocation")
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            self._log_state_snapshot(state, "allocation_error")  
            return state

    def alert_node(self, state: EmergencyState) -> EmergencyState:
        try:
            if not state.case_id:
                state.error_message = 'No case for alerting'
                return state

            case = Case.query.get(state.case_id)
            if not case:
                state.error_message = f'Case {state.case_id} not found for alerts'
                return state

            alert_result = self.alert_agent.send_alerts(case)
            state.alerts_sent = alert_result.get('alerts_sent', [])
            state.failed_alerts = alert_result.get('failed_alerts', [])
            state.alerts_count = alert_result.get('count', len(state.alerts_sent))
            state.llm_priority = alert_result.get('llm_priority') or alert_result.get('priority')

            case.status = 'alerts_sent'

            log = Logs(case_id=case.id, agent_name='alert_node', message=f"Alerts sent: {state.alerts_count}", metadata_json=str(state.llm_priority))
            db.session.add(log)
            db.session.commit()

            state.workflow_status = 'alerts_sent'
            state.case_status = case.status
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            self._log_state_snapshot(state, "alert_error") 
            return state

    def chat_node(self, state: EmergencyState) -> EmergencyState:
        try:
            if not state.user_message:
                state.error_message = 'No user message for chat node'
                return state

            chat_result = self.chat_agent.chat(
                state.user_message,
                user_id=state.user_id,
                user_role=state.user_role,
                hospital_user_id=state.hospital_user_id,
                ambulance_user_id=state.ambulance_user_id,
            )
            state.chat_intent = chat_result.get('intent')
            state.chat_response = chat_result.get('response', '')

            if not isinstance(state.metadata, dict):
                state.metadata = {}

            plan = chat_result.get('plan') or {}
            tool_result = chat_result.get('data') or {}
            agent_metadata = chat_result.get('metadata') or {}

            state.metadata['plan'] = plan
            state.metadata['tool_result'] = tool_result
            state.metadata['tool_used'] = agent_metadata.get('tool_used') or plan.get('tool_name')
            state.metadata['tool_args'] = agent_metadata.get('tool_args') or plan.get('tool_args')
            state.metadata['results'] = agent_metadata.get('results') or tool_result
            state.metadata['reasoning'] = agent_metadata.get('reasoning') or plan.get('reason')

            if state.case_id:
                log = Logs(
                    case_id=state.case_id,
                    agent_name='chat_node',
                    message=state.chat_response,
                    metadata_json=str(state.chat_intent),
                )
                db.session.add(log)
                db.session.commit()

            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            self._log_state_snapshot(state, "chat_error")  
            return state


    def finalise_node(self, state: EmergencyState) -> EmergencyState:
        try:

            is_chat_only = bool(state.chat_response) and state.workflow_status in ('started', '')

            if is_chat_only:
                state.workflow_status = 'chat_completed'
                return state

            if state.error_message or state.workflow_status != 'alerts_sent':
                state.workflow_status = 'failed'
                final_case_status = 'failed_escalation'
            else:
                state.workflow_status = 'completed'
                final_case_status = 'alerts_sent'

            if state.case_id:
                case = Case.query.get(state.case_id)
                if case:
                    case.eta = state.eta or case.eta
                    case.status = final_case_status
                    db.session.add(case)
                    db.session.commit()
                    state.case_status = case.status

            self._log_state_snapshot(state, "finalise")  
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            self._log_state_snapshot(state, "finalise_error")  
            return state




