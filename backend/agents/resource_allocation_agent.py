from typing import Any, Dict, List, Tuple
from langchain_core.prompts import PromptTemplate
try:
    from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
except Exception:
    from ..utils.langchain_compat import StructuredOutputParser, ResponseSchema
from ..models import Case, Hospital, Reserved, Resource, Logs, db

# severity->calc needs->check availability->reserve->confirm with hospital->release after case closed
RESOURCE_ALLOCATION_GUARDRAILS = """You are an emergency resource allocation agent. Your role is to allocate hospital resources optimally.

## STRICT RULES:
1. **Never double-allocate or exceed capacity.**
2. **P0/P1 Priority:** Prioritize ICU beds and ventilators for P0/P1 cases. If unavailable, recommend an alternative (downgrade to general bed or recommend immediate transfer/escalation).
3. **Accurate Counts:** Only allocate resources that are confirmed available in the provided inventory list.
"""

class ResourceAllocationAgent:
    def __init__(self, llm: Any = None):
        self.llm = llm
        
        self.response_schemas = [
            ResponseSchema(name='allocation_plan', description='List of resources to allocate: [{"type": "icu"/"ventilator"/"bed", "quantity": N}]'),
            ResponseSchema(name='rationale', description='Brief explanation of allocation decision'),
            ResponseSchema(name='alternative_strategy', description='Alternative allocation if primary fails (e.g., waitlist or downgrade)'),
            ResponseSchema(name='escalation_needed', description='True if case needs priority escalation, False otherwise')
        ]
        self.output_parser = StructuredOutputParser.from_response_schemas(self.response_schemas)
        self.format_instructions = self.output_parser.get_format_instructions()
        
        self.prompt = PromptTemplate(
            input_variables=['severity_level', 'condition', 'available_resources', 'resource_needs', 'hospital_name'],
            template=RESOURCE_ALLOCATION_GUARDRAILS+"\n\n"+
                """You are an expert emergency resource allocation system. Allocate hospital resources optimally.

Case Severity: {severity_level}
Patient Condition: {condition}
Hospital: {hospital_name}

Required Resources (ideal):
{resource_needs}

Currently Available:
{available_resources}

Your task:
1. Allocate as many required resources as possible
2. If any required resource is unavailable, suggest alternatives (e.g., waitlist for ICU but confirm bed reservation)
3. Recommend escalation if critical resources (ICU/ventilator) are unavailable for P0/P1 cases
4. Provide clear reasoning for your decision

{format_instructions}"""
        )

    def allocate_resources(self, case: Case, hospital: Hospital) -> Dict[str, Any]:
        if not hospital:
            return {
                "success": False,
                "reason": "No hospital selected",
                "reserved": []
            }

        if not getattr(case, "severity", None):
            return {
                "success": False,
                "reason": "Case severity is missing. Triaging must complete before resource allocation.",
                "reserved": []
            }

        try:
            severity_level = case.severity
            resource_needs = self._get_resource_needs(severity_level, case.condition)

            available_resources = Resource.query.filter_by(
                hospital_id=hospital.id,
                status='available'
            ).all()

            resource_needs_str = "\n".join(
                [f"- {need['quantity']} {need['type']}" for need in resource_needs]
            )
            available_resources_str = "\n".join(
                [f"- {r.resource_type}: {r.available} available" for r in available_resources]
            ) if available_resources else "No resources listed"

            llm_decision = None
            if self.llm:
                try:
                    llm_input = self.prompt.format(
                        severity_level=severity_level,
                        condition=case.condition,
                        available_resources=available_resources_str,
                        resource_needs=resource_needs_str,
                        hospital_name=hospital.name
                    )
                    llm_output = self.llm.invoke(llm_input)
                    llm_decision = self.output_parser.parse(llm_output.content)
                except Exception:
                    llm_decision = None

            if llm_decision:
                result = self._execute_llm_allocation(
                    case, hospital, llm_decision, available_resources, severity_level
                )
            else:
                result = self._execute_deterministic_allocation(
                    case, hospital, resource_needs, available_resources, severity_level
                )

            if result.get("failed"):
                db.session.rollback()
                return {
                    "success": False,
                    "severity_level": severity_level,
                    "allocated": [],
                    "failed": result.get("failed", []),
                    "case_id": case.id,
                    "hospital_id": hospital.id,
                    "reasoning": result.get("reasoning", "Allocation failed"),
                    "alternative_strategy": result.get("alternative_strategy"),
                    "escalation_needed": result.get("escalation_needed", False),
                    "note": result.get("note"),
                }

            db.session.commit()
            return result
        except Exception as e:
            db.session.rollback()
            return {
                "success": False,
                "reason": str(e),
                "reserved": []
            }

    def _execute_llm_allocation(self, case: Case, hospital: Hospital, llm_decision: Dict, 
                               available_resources: List[Resource], severity_level: str) -> Dict[str, Any]:
        allocated = []
        failed = []
        
        allocation_plan = llm_decision.get('allocation_plan', [])
        if isinstance(allocation_plan, str):
            import json
            try:
                allocation_plan = json.loads(allocation_plan)
            except:
                allocation_plan = []
        
        for need in allocation_plan:
            resource_type = need.get('type')
            quantity_needed = need.get('quantity', 0)
            
            resource = next(
                (r for r in available_resources if r.resource_type == resource_type),
                None
            )
            
            if resource and resource.available >= quantity_needed:
                reserved_record = self._create_reservation(
                    case, hospital, resource_type, quantity_needed
                )
                self._decrement_resource_availability(resource, quantity_needed)
                self._confirm_reservation_record(reserved_record)
                allocated.append({
                    "resource_type": resource_type,
                    "quantity": quantity_needed,
                    "reserved_id": reserved_record.id,
                    "reservation_status": reserved_record.status,
                })
            else:
                failed.append({
                    "resource_type": resource_type,
                    "quantity_needed": quantity_needed,
                    "available": resource.available if resource else 0
                })
        
        # Log the resource allocation
        allocated_str = ", ".join([f"{a['quantity']} {a['resource_type']}" for a in allocated])
        log = Logs(
            case_id=case.id,
            agent_name='resource_allocation_agent',
            message=f"LLM-based allocation: {allocated_str if allocated else 'no resources allocated'}",
            metadata_json=llm_decision.get('rationale', '')
        )
        db.session.add(log)
        
        return {
            "success": len(failed) == 0,
            "severity_level": severity_level,
            "allocated": allocated,
            "failed": failed,
            "case_id": case.id,
            "hospital_id": hospital.id,
            "llm_rationale": llm_decision.get('rationale', ''),
            "alternative_strategy": llm_decision.get('alternative_strategy'),
            "escalation_needed": llm_decision.get('escalation_needed', False),
            "reasoning": self._summarize_allocation(severity_level, allocated, failed)
        }

    def _execute_deterministic_allocation(self, case: Case, hospital: Hospital, 
                                         resource_needs: List[Dict], available_resources: List[Resource],
                                         severity_level: str) -> Dict[str, Any]:
        allocated = []
        failed = []

        for need in resource_needs:
            resource_type = need['type']
            quantity_needed = need['quantity']

            resource = next(
                (r for r in available_resources if r.resource_type == resource_type),
                None
            )

            if resource and resource.available >= quantity_needed:
                reserved_record = self._create_reservation(
                    case, hospital, resource_type, quantity_needed
                )
                self._decrement_resource_availability(resource, quantity_needed)
                self._confirm_reservation_record(reserved_record)
                allocated.append({
                    "resource_type": resource_type,
                    "quantity": quantity_needed,
                    "reserved_id": reserved_record.id,
                    "reservation_status": reserved_record.status,
                })
            else:
                failed.append({
                    "resource_type": resource_type,
                    "quantity_needed": quantity_needed,
                    "available": resource.available if resource else 0
                })

        # Log the deterministic resource allocation
        allocated_str = ", ".join([f"{a['quantity']} {a['resource_type']}" for a in allocated])
        log = Logs(
            case_id=case.id,
            agent_name='resource_allocation_agent',
            message=f"Deterministic allocation: {allocated_str if allocated else 'no resources allocated'}",
            metadata_json=f"Severity {severity_level}, fallback allocation"
        )
        db.session.add(log)

        return {
            "success": len(failed) == 0,
            "severity_level": severity_level,
            "allocated": allocated,
            "failed": failed,
            "case_id": case.id,
            "hospital_id": hospital.id,
            "reasoning": self._summarize_allocation(severity_level, allocated, failed),
            "note": "Deterministic allocation (LLM unavailable)"
        }

    def release_resources(self, case_id: int) -> Dict[str, Any]:
        reservations = Reserved.query.filter_by(case_id=case_id).all()

        if not reservations:
            return {"success": False, "reason": "No reservations found for this case"}

        released = []
        for res in reservations:
            if res.status != 'cancelled':
                resource = Resource.query.filter_by(
                    hospital_id=res.hospital_id,
                    resource_type=res.type
                ).first()

                if resource:
                    resource.available += res.quantity
                    hospital = Hospital.query.get(res.hospital_id)
                    if hospital:
                        if res.type == 'icu':
                            hospital.icu_available = min(hospital.icu_total, resource.available)
                        elif res.type == 'bed':
                            hospital.beds_available = min(hospital.beds_total, resource.available)
                        elif res.type == 'ventilator':
                            hospital.ventilators_available = min(hospital.ventilators_total, resource.available)
                    released.append({
                        "resource_type": res.type,
                        "quantity": res.quantity,
                        "hospital_id": res.hospital_id
                    })

                res.status = 'cancelled'

        db.session.commit()
        return {
            "success": True,
            "case_id": case_id,
            "released": released,
            "count": len(released)
        }

    def confirm_reservation(self, case_id: int) -> Dict[str, Any]:
        try:
            reservations = Reserved.query.filter_by(case_id=case_id, status='reserved').all()

            if not reservations:
                return {"success": False, "reason": "No pending reservations"}

            for res in reservations:
                self._confirm_reservation_record(res)

            db.session.commit()
            return {
                "success": True,
                "case_id": case_id,
                "confirmed_count": len(reservations)
            }
        except Exception as e:
            db.session.rollback()
            return {"success": False, "error": str(e)}

    def check_resource_availability(self, hospital: Hospital, needs: List[Dict[str, Any]]) -> Tuple[bool, Dict[str, Any]]:
        availability = {}
        all_available = True

        for need in needs:
            resource_type = need['type']
            quantity_needed = need['quantity']

            resource = Resource.query.filter_by(
                hospital_id=hospital.id,
                resource_type=resource_type
            ).first()

            available_count = resource.available if resource else 0
            has_enough = available_count >= quantity_needed

            availability[resource_type] = {
                "needed": quantity_needed,
                "available": available_count,
                "sufficient": has_enough
            }

            if not has_enough:
                all_available = False

        return all_available, availability

    

    def _get_resource_needs(self, severity_level: str, condition: str) -> List[Dict[str, Any]]:
        condition_lower = condition.lower()

        base_needs = {
            'P0': [
                {'type': 'icu', 'quantity': 1},
                {'type': 'ventilator', 'quantity': 1},
                {'type': 'bed', 'quantity': 1}
            ],
            'P1': [
                {'type': 'icu', 'quantity': 1},
                {'type': 'bed', 'quantity': 1}
            ],
            'P2': [
                {'type': 'bed', 'quantity': 1}
            ],
            'P3': [
                {'type': 'bed', 'quantity': 1}
            ]
        }

        needs = base_needs.get(severity_level, [])

        if 'respiratory' in condition_lower or 'asthma' in condition_lower:
            if severity_level in ['P0', 'P1']:
                ventilators = next((n for n in needs if n['type'] == 'ventilator'), None)
                if ventilators:
                    ventilators['quantity'] += 1
                elif severity_level == 'P1':
                    needs.append({'type': 'ventilator', 'quantity': 1})

        return needs

    def _create_reservation(self, case: Case, hospital: Hospital, resource_type: str, quantity: int) -> Reserved:
        reservation = Reserved(
            case_id=case.id,
            hospital_id=hospital.id,
            type=resource_type,
            quantity=quantity,
            status='reserved'
        )
        db.session.add(reservation)
        return reservation

    def _confirm_reservation_record(self, reservation: Reserved) -> None:
        reservation.status = 'confirmed'

    def _decrement_resource_availability(self, resource: Resource, quantity: int) -> None:
        # Atomic decrement with availability check to prevent race conditions
        rows_updated = db.session.query(Resource).filter(
            Resource.id == resource.id,
            Resource.available >= quantity
        ).update(
            {Resource.available: Resource.available - quantity},
            synchronize_session='fetch'
        )
        if rows_updated == 0:
            raise ValueError(f"Insufficient availability for resource {resource.resource_type}")

        # Keep Hospital model in sync with Resource table
        hospital = Hospital.query.get(resource.hospital_id)
        if hospital:
            if resource.resource_type == 'icu':
                hospital.icu_available = resource.available
            elif resource.resource_type == 'bed':
                hospital.beds_available = resource.available
            elif resource.resource_type == 'ventilator':
                hospital.ventilators_available = resource.available

    def _summarize_allocation(self, severity_level: str, allocated: List[Dict], failed: List[Dict]) -> str:
        if not allocated and not failed:
            return "No resources allocated."

        allocated_str = ", ".join([f"{a['quantity']} {a['resource_type']}" for a in allocated])
        if allocated and not failed:
            return f"Allocated {allocated_str} for {severity_level} case."

        failed_str = ", ".join([f"{f['quantity_needed']} {f['resource_type']}" for f in failed])
        if failed and not allocated:
            return f"Failed to allocate {failed_str}. May require escalation."

        return f"Partial allocation: got {allocated_str}, but lacked {failed_str}."
