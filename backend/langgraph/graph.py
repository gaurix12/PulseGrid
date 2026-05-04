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
    
    def triage_node(self, state: EmergencyState) -> EmergencyState:
        
        try:
            if not state or not state.patient_details:
                state.error_message = "No patient details provided for triage"
                return state

            triage_result = self.triage_agent.triage(state.patient_details)
            state.severity = triage_result.get('severity')
            state.condition = triage_result.get('condition')
            state.created_at = datetime.utcnow()

            state.logs.append({
                "agent": "triage_agent",
                "message": f"Triage: severity={state.severity}, condition={state.condition}",
                "metadata": ""
            })

            return state
        except Exception as e:
            state.error_message = str(e)
            return state

    def create_case_node(self, state: EmergencyState) -> EmergencyState:
        try:
            patient_name = state.patient_name or "Unknown Patient"
            condition = state.condition or state.metadata.get('condition', 'Unknown')
            severity = state.severity or 'P3'
            location = state.location or state.metadata.get('location', 'Unknown')
            new_case = Case(
                patient_name=patient_name,
                condition=condition,
                severity=severity,
                location=location
            )
            db.session.add(new_case)
            db.session.commit()

            state.case_id = new_case.id
            for l in state.logs:
                log = Logs(case_id=new_case.id, agent_name=l.get('agent', 'system'), message=l.get('message', ''), metadata=l.get('metadata', None))
                db.session.add(log)
            db.session.commit()
            state.workflow_status = 'case_created'
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            return state

    def dispatch_node(self, state: EmergencyState) -> EmergencyState:
        try:
            if not state.case_id:
                state.error_message = 'No case_id present for dispatch'
                return state

            case = Case.query.get(state.case_id)
            if not case:
                state.error_message = f'Case {state.case_id} not found'
                return state
            dispatch_result = self.dispatch_agent.dispatch(case, case.location or state.location)
            amb_id = dispatch_result.get('ambulance_id')
            hosp_id = dispatch_result.get('hospital_id')

            if amb_id:
                case.ambulance_id = amb_id
                # optional: mark ambulance as assigned
                amb = Ambulance.query.get(amb_id)
                if amb:
                    amb.status = 'assigned'
                    amb.current_case_id = case.id
                    db.session.add(amb)

            if hosp_id:
                case.hospital_id = hosp_id

            db.session.add(case)
            log = Logs(case_id=case.id, agent_name='dispatch_node', message=f"Dispatch result: ambulance={amb_id}, hospital={hosp_id}", metadata=dispatch_result.get('reasoning', ''))
            db.session.add(log)
            db.session.commit()
            state.ambulance_id = amb_id
            state.hospital_id = hosp_id
            state.dispatch_reasoning = dispatch_result.get('reasoning')
            state.workflow_status = 'dispatched'
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
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

            sel_result = self.hospital_selection_agent.select_hospital(case)
            hosp_id = sel_result.get('hospital_id')
            reasoning = sel_result.get('reasoning')

            if hosp_id:
                case.hospital_id = hosp_id
                db.session.add(case)
                db.session.commit()

                hosp = Hospital.query.get(hosp_id)
                state.hospital_id = hosp_id
                state.hospital_name = hosp.name if hosp else None
            log = Logs(case_id=case.id, agent_name='hospital_selection_node', message=f"Hospital selected: {hosp_id}", metadata=reasoning)
            db.session.add(log)
            db.session.commit()

            state.hospital_selection_reasoning = reasoning
            state.workflow_status = 'hospital_selected'
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
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

            # log allocation
            log = Logs(case_id=case.id, agent_name='resource_allocation_node', message=f"Allocation: success={state.allocation_success}", metadata=state.allocation_reasoning)
            db.session.add(log)
            db.session.commit()

            state.workflow_status = 'resources_allocated' if state.allocation_success else 'allocation_partial'
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
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

            log = Logs(case_id=case.id, agent_name='alert_node', message=f"Alerts sent: {state.alerts_count}", metadata=str(state.llm_priority))
            db.session.add(log)
            db.session.commit()

            state.workflow_status = 'alerts_sent'
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            return state

    def chat_node(self, state: EmergencyState) -> EmergencyState:
        try:
            if not state.user_message:
                state.error_message = 'No user message for chat node'
                return state

            chat_result = self.chat_agent.chat(state.user_message, state.user_id)
            state.chat_intent = chat_result.get('intent')
            state.chat_response = chat_result.get('response')
            if state.case_id:
                log = Logs(case_id=state.case_id, agent_name='chat_node', message=state.chat_response, metadata=str(state.chat_intent))
                db.session.add(log)
                db.session.commit()

            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            return state

    def finalise_node(self, state: EmergencyState) -> EmergencyState:
        try:
            state.workflow_status = 'completed'
            if state.case_id:
                case = Case.query.get(state.case_id)
                if case:
                    case.eta = state.eta or case.eta
                    db.session.add(case)
                    db.session.commit()
            return state
        except Exception as e:
            db.session.rollback()
            state.error_message = str(e)
            return state



