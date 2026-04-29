from typing import Any, Dict, List, Callable, Optional
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
from sqlalchemy import func, and_, or_
from datetime import datetime, timedelta
import re
from ..models import Case, Hospital, Ambulance, Resource, User, Reserved, Logs, db


class ChatAgent:
    def __init__(self, llm: Any = None):
        self.llm = llm        
        self.intent_schemas = [
            ResponseSchema(name='intent', description='Type of request: query, command, or explanation'),
            ResponseSchema(name='target', description='What the query is about: hospital, ambulance, case, or resource'),
            ResponseSchema(name='action', description='Specific action or query (e.g., "available_icu_beds", "set_ambulance_status")'),
            ResponseSchema(name='parameters', description='Dictionary of parameters needed (e.g., {"hospital_id": 1} or {"count": 2, "resource_type": "icu"})')
        ]
        self.intent_parser = StructuredOutputParser.from_response_schemas(self.intent_schemas)
        self.intent_instructions = self.intent_parser.get_format_instructions()
        
        self.intent_prompt = PromptTemplate(
            input_variables=['user_message', 'intent_instructions'],
            template="""You are an emergency dispatch system chat assistant. Analyze the user's message and determine their intent.

User Message: {user_message}

Classify the message as:
- query: Information request (e.g., "How many beds?", "Status of ambulance?")
- command: System update (e.g., "Add beds", "Mark ambulance delayed")
- explanation: Request for reasoning (e.g., "Why this hospital?", "Explain dispatch")

For each message, extract:
1. Intent type (query/command/explanation)
2. Target (what they're asking about: hospital, ambulance, case, resource)
3. Action (specific operation: available_icu_beds, set_status, explain_dispatch)
4. Parameters needed (as dictionary)

{intent_instructions}"""
        )
        
        self.response_prompt = PromptTemplate(
            input_variables=['intent', 'target', 'action', 'data', 'context'],
            template="""Generate a natural, conversational response to the user's request.

Intent: {intent}
Target: {target}
Action: {action}
Data Retrieved: {data}
Context: {context}

Provide a clear, helpful response that:
1. Answers the question directly if it's a query
2. Confirms the action if it's a command
3. Explains the reasoning if it's an explanation
4. Uses natural language, not JSON or technical jargon

Response:"""
        )

    def chat(self, message: str, user_id: Optional[int] = None) -> Dict[str, Any]:
        if not message or not message.strip():
            return {
                "success": False,
                "response": "Please provide a valid message.",
                "intent": None
            }

        intent_result = self._detect_intent(message)
        if not intent_result:
            return {
                "success": False,
                "response": "I couldn't understand your request. Try asking about hospitals, ambulances, cases, or resources.",
                "intent": None
            }

        intent = intent_result.get('intent')
        target = intent_result.get('target')
        action = intent_result.get('action')
        parameters = intent_result.get('parameters', {})

        # Step 2: Extract parameters from natural language
        parameters = self._extract_parameters(message, intent, target, action, parameters)

        # Step 3: Execute action and get data
        data = self._execute_action(intent, target, action, parameters, user_id)

        # Step 3: Generate natural response
        response = self._generate_response(intent, target, action, data, message)

        return {
            "success": data.get('success', True) if isinstance(data, dict) else True,
            "response": response,
            "intent": intent,
            "target": target,
            "action": action,
            "data": data
        }

    def _extract_parameters(self, message: str, intent: str, target: str, action: str, base_params: Dict) -> Dict:
        """Extract specific parameters from natural language message."""
        params = base_params.copy()
        message_lower = message.lower()
        
        # Extract all numbers from message
        numbers = re.findall(r'\b\d+\b', message)
        
        # Extract resource type
        for res_type in ['bed', 'icu', 'ventilator']:
            if res_type in message_lower:
                params['resource_type'] = res_type
        
        # Extract quantities and IDs based on action
        if action in ['update_resource', 'add_resource']:
            if numbers:
                params['quantity'] = int(numbers[0])
                if len(numbers) > 1:
                    params['hospital_id'] = int(numbers[1])
        
        elif action == 'set_ambulance_status':
            if numbers:
                params['ambulance_id'] = int(numbers[0])
            for status in ['idle', 'assigned', 'en route', 'delayed', 'arrived']:
                if status in message_lower:
                    params['status'] = status
        
        elif action == 'mark_case_delayed':
            if numbers:
                params['case_id'] = int(numbers[0])
        
        elif action == 'create_case':
            if numbers:
                params['patient_id'] = int(numbers[0])
            severity_match = re.search(r'\bp[0-3]\b', message_lower)
            if severity_match:
                params['severity'] = severity_match.group(0).upper()
            if 'respiratory' in message_lower:
                params['condition'] = 'respiratory'
            elif 'trauma' in message_lower:
                params['condition'] = 'trauma'
            elif 'cardiac' in message_lower or 'heart' in message_lower:
                params['condition'] = 'cardiac'
        
        elif action == 'update_ambulance_location':
            if numbers:
                params['ambulance_id'] = int(numbers[0])
            lat_match = re.search(r'lat[a-z]*\s*:?\s*([-\d.]+)', message_lower)
            if lat_match:
                params['latitude'] = float(lat_match.group(1))
            lon_match = re.search(r'lon[a-z]*\s*:?\s*([-\d.]+)', message_lower)
            if lon_match:
                params['longitude'] = float(lon_match.group(1))
        
        elif action == 'allocate_resources':
            if numbers:
                params['case_id'] = int(numbers[0])
                if len(numbers) > 1:
                    params['hospital_id'] = int(numbers[1])
        
        return params

    def _detect_intent(self, message: str) -> Optional[Dict[str, Any]]:
        """Use LLM to detect user intent and extract parameters."""
        if not self.llm:
            return self._detect_intent_fallback(message)

        try:
            llm_input = self.intent_prompt.format(
                user_message=message,
                intent_instructions=self.intent_instructions
            )
            llm_output = self.llm.invoke(llm_input)
            intent_result = self.intent_parser.parse(llm_output.content)
            return intent_result
        except Exception as e:
            return self._detect_intent_fallback(message)

    def _detect_intent_fallback(self, message: str) -> Dict[str, Any]:
        message_lower = message.lower()

        if any(word in message_lower for word in ['how many', 'how much', 'available', 'status', 'check', 'list', 'show', 'count']):
            if 'ventilator' in message_lower and 'free' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'resource',
                    'action': 'free_ventilators',
                    'parameters': {}
                }
            elif 'bed' in message_lower and 'reserved' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'resource',
                    'action': 'reserved_beds',
                    'parameters': {}
                }
            elif 'ambulance' in message_lower and ('running' in message_lower or 'active' in message_lower):
                return {
                    'intent': 'query',
                    'target': 'ambulance',
                    'action': 'running_ambulances',
                    'parameters': {}
                }
            elif ('today' in message_lower or 'this week' in message_lower or 'this month' in message_lower) and ('case' in message_lower or 'ambulance' in message_lower):
                return {
                    'intent': 'query',
                    'target': 'case',
                    'action': 'time_based_query',
                    'parameters': {}
                }
            elif ('utilization' in message_lower or 'load' in message_lower or 'statistics' in message_lower) and 'hospital' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'hospital',
                    'action': 'hospital_utilization',
                    'parameters': {}
                }
            elif ('alert' in message_lower or 'notification' in message_lower) and ('who' in message_lower or 'which' in message_lower):
                return {
                    'intent': 'query',
                    'target': 'alert',
                    'action': 'query_alerts',
                    'parameters': {}
                }
            elif 'location' in message_lower and 'ambulance' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'ambulance',
                    'action': 'ambulance_location',
                    'parameters': {}
                }
            elif 'reserved' in message_lower and 'resource' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'resource',
                    'action': 'query_reservations',
                    'parameters': {}
                }
            elif 'bed' in message_lower or 'icu' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'resource',
                    'action': 'available_resources',
                    'parameters': {}
                }
            elif 'ambulance' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'ambulance',
                    'action': 'list_ambulances',
                    'parameters': {}
                }
            elif 'hospital' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'hospital',
                    'action': 'list_hospitals',
                    'parameters': {}
                }
            elif 'case' in message_lower:
                return {
                    'intent': 'query',
                    'target': 'case',
                    'action': 'list_cases',
                    'parameters': {}
                }

        # Command detection
        if any(word in message_lower for word in ['add', 'set', 'mark', 'update', 'change', 'create']):
            if 'bed' in message_lower or 'icu' in message_lower or 'ventilator' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'resource',
                    'action': 'update_resource',
                    'parameters': {}
                }
            elif 'ambulance' in message_lower and 'status' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'ambulance',
                    'action': 'set_ambulance_status',
                    'parameters': {}
                }
            elif 'case' in message_lower and 'delayed' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'case',
                    'action': 'mark_case_delayed',
                    'parameters': {}
                }
            elif 'create' in message_lower and 'case' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'case',
                    'action': 'create_case',
                    'parameters': {}
                }
            elif 'update' in message_lower and ('location' in message_lower or 'gps' in message_lower):
                return {
                    'intent': 'command',
                    'target': 'ambulance',
                    'action': 'update_ambulance_location',
                    'parameters': {}
                }
            elif 'allocate' in message_lower and 'resource' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'resource',
                    'action': 'allocate_resources',
                    'parameters': {}
                }
            elif 'reserve' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'resource',
                    'action': 'reserve_resources',
                    'parameters': {}
                }
            elif 'confirm' in message_lower and 'reservation' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'resource',
                    'action': 'confirm_reservation',
                    'parameters': {}
                }
            elif 'release' in message_lower and 'resource' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'resource',
                    'action': 'release_resources',
                    'parameters': {}
                }
            elif 'update' in message_lower and ('hospital' in message_lower or 'ambulance' in message_lower):
                return {
                    'intent': 'command',
                    'target': 'hospital' if 'hospital' in message_lower else 'ambulance',
                    'action': 'update_details',
                    'parameters': {}
                }
            elif 'trigger' in message_lower and 'alert' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'alert',
                    'action': 'trigger_alert',
                    'parameters': {}
                }
            elif 'batch' in message_lower and 'update' in message_lower:
                return {
                    'intent': 'command',
                    'target': 'ambulance' if 'ambulance' in message_lower else 'resource',
                    'action': 'batch_update',
                    'parameters': {}
                }

        # Explanation detection
        if any(word in message_lower for word in ['why', 'explain', 'reason', 'how', 'what is']):
            if 'hospital' in message_lower:
                return {
                    'intent': 'explanation',
                    'target': 'case',
                    'action': 'explain_hospital_selection',
                    'parameters': {}
                }
            elif 'ambulance' in message_lower:
                return {
                    'intent': 'explanation',
                    'target': 'case',
                    'action': 'explain_ambulance_dispatch',
                    'parameters': {}
                }

        return {
            'intent': 'query',
            'target': 'general',
            'action': 'help',
            'parameters': {}
        }

    def _execute_action(self, intent: str, target: str, action: str, parameters: Dict, user_id: Optional[int]) -> Any:
        """Execute the appropriate action based on intent and target."""
        try:
            if intent == 'query':
                return self._execute_query(target, action, parameters)
            elif intent == 'command':
                return self._execute_command(target, action, parameters, user_id)
            elif intent == 'explanation':
                return self._execute_explanation(target, action, parameters)
            else:
                return {"error": "Unknown intent"}
        except Exception as e:
            return {"error": str(e), "success": False}

    def _execute_query(self, target: str, action: str, parameters: Dict) -> Dict[str, Any]:
        """Execute query actions."""
        if target == 'hospital':
            if action == 'list_hospitals':
                hospitals = Hospital.query.all()
                return {
                    "success": True,
                    "data": [
                        {
                            "id": h.id,
                            "name": h.name,
                            "location": h.location,
                            "beds_available": h.beds_available,
                            "icu_available": h.icu_available,
                            "ventilators_available": h.ventilators_available
                        }
                        for h in hospitals
                    ]
                }

        elif target == 'ambulance':
            if action == 'list_ambulances':
                ambulances = Ambulance.query.all()
                return {
                    "success": True,
                    "data": [
                        {
                            "id": a.id,
                            "driver_name": a.driver_name,
                            "status": a.status,
                            "location": f"({a.current_latitude}, {a.current_longitude})" if a.current_latitude else "Unknown"
                        }
                        for a in ambulances
                    ]
                }
            elif action == 'running_ambulances':
                running = Ambulance.query.filter(Ambulance.status != 'idle').all()
                return {
                    "success": True,
                    "count": len(running),
                    "data": [
                        {
                            "id": a.id,
                            "driver_name": a.driver_name,
                            "status": a.status,
                            "location": f"({a.current_latitude}, {a.current_longitude})" if a.current_latitude else "Unknown"
                        }
                        for a in running
                    ]
                }

        elif target == 'case':
            if action == 'list_cases':
                cases = Case.query.all()
                return {
                    "success": True,
                    "data": [
                        {
                            "id": c.id,
                            "patient_name": c.patient_name,
                            "severity": c.severity,
                            "condition": c.condition,
                            "status": "active" if not c.delay else "delayed"
                        }
                        for c in cases
                    ]
                }

        elif target == 'resource':
            if action == 'available_resources':
                resources = Resource.query.filter(Resource.available > 0).all()
                by_hospital = {}
                for r in resources:
                    if r.hospital_id not in by_hospital:
                        by_hospital[r.hospital_id] = {}
                    by_hospital[r.hospital_id][r.resource_type] = r.available

                hospitals_data = []
                for hospital_id, resources_dict in by_hospital.items():
                    hospital = Hospital.query.get(hospital_id)
                    hospitals_data.append({
                        "hospital": hospital.name if hospital else f"Hospital {hospital_id}",
                        "resources": resources_dict
                    })
                return {"success": True, "data": hospitals_data}
            
            elif action == 'free_ventilators':
                from sqlalchemy import func
                ventilators = Resource.query.filter_by(resource_type='ventilator').all()
                total_free = sum(v.available for v in ventilators)
                by_hospital = []
                for v in ventilators:
                    if v.available > 0:
                        hospital = Hospital.query.get(v.hospital_id)
                        by_hospital.append({
                            "hospital": hospital.name if hospital else f"Hospital {v.hospital_id}",
                            "free": v.available
                        })
                return {
                    "success": True,
                    "total_free": total_free,
                    "by_hospital": by_hospital
                }
            
            elif action == 'reserved_beds':
                # Count reserved beds from Reserved table
                reserved = Reserved.query.filter_by(type='bed', status='reserved').all()
                reserved_count = sum(r.quantity for r in reserved)
                
                # Get total beds available
                total_beds = Hospital.query.with_entities(func.sum(Hospital.beds_total)).scalar() or 0
                available_beds = Hospital.query.with_entities(func.sum(Hospital.beds_available)).scalar() or 0
                
                return {
                    "success": True,
                    "reserved_beds": reserved_count,
                    "available_beds": available_beds,
                    "total_beds": total_beds,
                    "summary": f"{reserved_count} reserved, {available_beds} available, {total_beds} total"
                }
        
        elif target == 'ambulance' and action == 'ambulance_location':
            ambulance_id = parameters.get('ambulance_id')
            if ambulance_id:
                ambulance = Ambulance.query.get(ambulance_id)
                if ambulance:
                    return {
                        "success": True,
                        "ambulance_id": ambulance_id,
                        "latitude": ambulance.current_latitude,
                        "longitude": ambulance.current_longitude,
                        "location": f"({ambulance.current_latitude}, {ambulance.current_longitude})"
                    }
                return {"success": False, "error": f"Ambulance {ambulance_id} not found"}
            else:
                ambulances = Ambulance.query.all()
                return {
                    "success": True,
                    "data": [
                        {
                            "id": a.id,
                            "driver_name": a.driver_name,
                            "latitude": a.current_latitude,
                            "longitude": a.current_longitude,
                            "location": f"({a.current_latitude}, {a.current_longitude})"
                        }
                        for a in ambulances if a.current_latitude
                    ]
                }
        
        elif target == 'case' and action == 'time_based_query':
            period = parameters.get('period', 'today')
            if period == 'today':
                start_time = datetime.now().replace(hour=0, minute=0, second=0)
            elif period == 'week':
                start_time = datetime.now() - timedelta(days=7)
            else:  # month
                start_time = datetime.now() - timedelta(days=30)
            
            cases = Case.query.filter(Case.created_at >= start_time).all()
            return {
                "success": True,
                "period": period,
                "count": len(cases),
                "data": [
                    {
                        "id": c.id,
                        "patient_name": c.patient_name,
                        "severity": c.severity,
                        "condition": c.condition,
                        "created_at": c.created_at.strftime('%Y-%m-%d %H:%M')
                    }
                    for c in cases
                ]
            }
        
        elif target == 'hospital' and action == 'hospital_utilization':
            hospitals = Hospital.query.all()
            utilization = []
            for h in hospitals:
                total_beds = h.beds_total or 1
                total_icu = h.icu_total or 1
                bed_usage = ((total_beds - h.beds_available) / total_beds) * 100
                icu_usage = ((total_icu - h.icu_available) / total_icu) * 100
                utilization.append({
                    "hospital": h.name,
                    "bed_usage_percent": round(bed_usage, 1),
                    "icu_usage_percent": round(icu_usage, 1),
                    "beds_available": h.beds_available,
                    "icu_available": h.icu_available
                })
            return {"success": True, "data": utilization}
        
        elif target == 'resource' and action == 'query_reservations':
            case_id = parameters.get('case_id')
            if case_id:
                reservations = Reserved.query.filter_by(case_id=case_id).all()
            else:
                reservations = Reserved.query.filter_by(status='reserved').all()
            
            return {
                "success": True,
                "data": [
                    {
                        "case_id": r.case_id,
                        "hospital_id": r.hospital_id,
                        "type": r.type,
                        "quantity": r.quantity,
                        "status": r.status
                    }
                    for r in reservations
                ]
            }
        
        elif target == 'alert' and action == 'query_alerts':
            case_id = parameters.get('case_id')
            if case_id:
                logs = Logs.query.filter_by(case_id=case_id).all()
            else:
                logs = Logs.query.filter(Logs.agent_name == 'alert_agent').all()
            
            return {
                "success": True,
                "data": [
                    {
                        "case_id": l.case_id,
                        "agent": l.agent_name,
                        "message": l.message,
                        "created_at": l.created_at.strftime('%Y-%m-%d %H:%M') if l.created_at else None
                    }
                    for l in logs[-10:]  # Last 10 alerts
                ]
            }

        return {"success": False, "error": f"Unknown query: {target}/{action}"}

    def _execute_command(self, target: str, action: str, parameters: Dict, user_id: Optional[int]) -> Dict[str, Any]:
        """Execute command actions (state-changing operations)."""
        # Validate user permissions for commands
        if user_id:
            user = User.query.get(user_id)
            if not user or user.role not in ['admin', 'hospital', 'ambulance']:
                return {"success": False, "error": "Insufficient permissions for this command"}

        if target == 'resource' and action == 'update_resource':
            # Example: "Add 2 ICU beds", "Mark 3 beds as free"
            hospital_id = parameters.get('hospital_id')
            resource_type = parameters.get('resource_type', 'bed')
            quantity = parameters.get('quantity', 1)

            if not hospital_id:
                return {"success": False, "error": "Hospital ID required"}

            resource = Resource.query.filter_by(
                hospital_id=hospital_id,
                resource_type=resource_type
            ).first()

            if resource:
                resource.available += quantity
                resource.total = max(resource.total, resource.available)
            else:
                resource = Resource(
                    hospital_id=hospital_id,
                    resource_type=resource_type,
                    total=quantity,
                    available=quantity,
                    status='available'
                )
                db.session.add(resource)

            db.session.commit()
            return {
                "success": True,
                "message": f"Updated {resource_type} at hospital {hospital_id}: now {resource.available} available"
            }

        elif target == 'ambulance' and action == 'set_ambulance_status':
            ambulance_id = parameters.get('ambulance_id')
            status = parameters.get('status')

            if not ambulance_id or not status:
                return {"success": False, "error": "Ambulance ID and status required"}

            ambulance = Ambulance.query.get(ambulance_id)
            if not ambulance:
                return {"success": False, "error": "Ambulance not found"}

            valid_statuses = ['idle', 'assigned', 'en route', 'delayed', 'arrived']
            if status not in valid_statuses:
                return {"success": False, "error": f"Invalid status. Must be one of: {', '.join(valid_statuses)}"}

            ambulance.status = status
            db.session.commit()
            return {
                "success": True,
                "message": f"Ambulance {ambulance_id} status set to {status}"
            }
        
        elif target == 'case' and action == 'mark_case_delayed':
            case_id = parameters.get('case_id')
            
            if not case_id:
                case = Case.query.filter_by(delay=False).order_by(Case.created_at.desc()).first()
                if not case:
                    return {"success": False, "error": "No active case found to mark as delayed"}
            else:
                case = Case.query.get(case_id)
                if not case:
                    return {"success": False, "error": f"Case {case_id} not found"}
            
            case.delay = True
            db.session.commit()
            return {
                "success": True,
                "message": f"Case {case.id} marked as delayed"
            }
        
        elif target == 'case' and action == 'create_case':
            # Create new emergency case
            patient_name = parameters.get('patient_name', 'Unknown Patient')
            condition = parameters.get('condition', 'Unknown')
            severity = parameters.get('severity', 'P3')
            location = parameters.get('location', 'Unknown')
            
            new_case = Case(
                patient_name=patient_name,
                condition=condition,
                severity=severity,
                location=location
            )
            db.session.add(new_case)
            db.session.commit()
            
            return {
                "success": True,
                "message": f"Case {new_case.id} created for {patient_name}",
                "case_id": new_case.id
            }
        
        elif target == 'ambulance' and action == 'update_ambulance_location':
            ambulance_id = parameters.get('ambulance_id')
            latitude = parameters.get('latitude')
            longitude = parameters.get('longitude')
            
            if not ambulance_id:
                return {"success": False, "error": "Ambulance ID required"}
            
            ambulance = Ambulance.query.get(ambulance_id)
            if not ambulance:
                return {"success": False, "error": f"Ambulance {ambulance_id} not found"}
            
            if latitude is not None:
                ambulance.current_latitude = latitude
            if longitude is not None:
                ambulance.current_longitude = longitude
            
            db.session.commit()
            return {
                "success": True,
                "message": f"Ambulance {ambulance_id} location updated to ({latitude}, {longitude})"
            }
        
        elif target == 'resource' and action == 'allocate_resources':
            from ..agents.resource_allocation_agent import ResourceAllocationAgent
            case_id = parameters.get('case_id')
            hospital_id = parameters.get('hospital_id')
            
            if not case_id or not hospital_id:
                return {"success": False, "error": "Case ID and Hospital ID required"}
            
            case = Case.query.get(case_id)
            hospital = Hospital.query.get(hospital_id)
            
            if not case or not hospital:
                return {"success": False, "error": "Case or Hospital not found"}
            
            res_agent = ResourceAllocationAgent()
            result = res_agent.allocate_resources(case, hospital)
            return result
        
        elif target == 'resource' and action == 'reserve_resources':
            case_id = parameters.get('case_id')
            hospital_id = parameters.get('hospital_id')
            resource_type = parameters.get('resource_type', 'bed')
            quantity = parameters.get('quantity', 1)
            
            if not case_id or not hospital_id:
                return {"success": False, "error": "Case ID and Hospital ID required"}
            
            reservation = Reserved(
                case_id=case_id,
                hospital_id=hospital_id,
                type=resource_type,
                quantity=quantity,
                status='reserved'
            )
            db.session.add(reservation)
            db.session.commit()
            return {
                "success": True,
                "message": f"Reserved {quantity} {resource_type}(s) for case {case_id}"
            }
        
        elif target == 'resource' and action == 'confirm_reservation':
            case_id = parameters.get('case_id')
            reservations = Reserved.query.filter_by(case_id=case_id, status='reserved').all()
            
            for r in reservations:
                r.status = 'confirmed'
            
            db.session.commit()
            return {
                "success": True,
                "message": f"Confirmed {len(reservations)} reservation(s) for case {case_id}"
            }
        
        elif target == 'resource' and action == 'release_resources':
            case_id = parameters.get('case_id')
            
            from ..agents.resource_allocation_agent import ResourceAllocationAgent
            res_agent = ResourceAllocationAgent()
            result = res_agent.release_resources(case_id)
            return result
        
        elif target == 'hospital' and action == 'update_details':
            hospital_id = parameters.get('hospital_id')
            if not hospital_id:
                return {"success": False, "error": "Hospital ID required"}
            
            hospital = Hospital.query.get(hospital_id)
            if not hospital:
                return {"success": False, "error": f"Hospital {hospital_id} not found"}
            
            if 'name' in parameters:
                hospital.name = parameters['name']
            if 'capacity' in parameters:
                hospital.beds_total = parameters['capacity']
            
            db.session.commit()
            return {
                "success": True,
                "message": f"Hospital {hospital_id} details updated"
            }
        
        elif target == 'ambulance' and action == 'update_details':
            ambulance_id = parameters.get('ambulance_id')
            if not ambulance_id:
                return {"success": False, "error": "Ambulance ID required"}
            
            ambulance = Ambulance.query.get(ambulance_id)
            if not ambulance:
                return {"success": False, "error": f"Ambulance {ambulance_id} not found"}
            
            if 'driver_name' in parameters:
                ambulance.driver_name = parameters['driver_name']
            
            db.session.commit()
            return {
                "success": True,
                "message": f"Ambulance {ambulance_id} details updated"
            }
        
        elif target == 'alert' and action == 'trigger_alert':
            from ..agents.alert_agent import AlertAgent
            case_id = parameters.get('case_id')
            if not case_id:
                return {"success": False, "error": "Case ID required"}
            
            case = Case.query.get(case_id)
            if not case:
                return {"success": False, "error": f"Case {case_id} not found"}
            
            alert_agent = AlertAgent()
            result = alert_agent.send_alerts(case)
            return result
        
        elif target == 'ambulance' and action == 'batch_update':
            # Batch update ambulance statuses
            status = parameters.get('status')
            current_status = parameters.get('current_status', 'idle')
            
            if not status:
                return {"success": False, "error": "Target status required"}
            
            ambulances = Ambulance.query.filter_by(status=current_status).all()
            for a in ambulances:
                a.status = status
            
            db.session.commit()
            return {
                "success": True,
                "message": f"Updated {len(ambulances)} ambulance(s) from {current_status} to {status}"
            }

        return {"success": False, "error": f"Unknown command: {target}/{action}"}

    def _execute_explanation(self, target: str, action: str, parameters: Dict) -> Dict[str, Any]:
        """Execute explanation actions."""
        if action == 'explain_hospital_selection':
            # Get latest case for context
            case = Case.query.order_by(Case.created_at.desc()).first()
            if not case or not case.hospital:
                return {"success": True, "explanation": "No recent case with hospital assignment found."}

            return {
                "success": True,
                "explanation": f"Hospital {case.hospital.name} was selected because: "
                              f"1) Severity {case.severity} requires ICU/beds available, "
                              f"2) Available resources: {case.hospital.beds_available} beds, "
                              f"{case.hospital.icu_available} ICU spaces, "
                              f"3) Proximity and specialty match for {case.condition}."
            }

        elif action == 'explain_ambulance_dispatch':
            case = Case.query.order_by(Case.created_at.desc()).first()
            if not case or not case.ambulance:
                return {"success": True, "explanation": "No recent case with ambulance assignment found."}

            return {
                "success": True,
                "explanation": f"Ambulance {case.ambulance.driver_name} was dispatched because: "
                              f"1) Status was idle and nearest to patient location, "
                              f"2) Distance calculated via Haversine formula, "
                              f"3) ETA optimized for severity {case.severity}."
            }

        return {"success": False, "error": f"Unknown explanation: {action}"}

    def _generate_response(self, intent: str, target: str, action: str, data: Any, original_message: str) -> str:
        if not self.llm:
            return self._generate_response_fallback(intent, target, action, data)

        try:
            import json
            data_str = json.dumps(data) if isinstance(data, dict) else str(data)

            llm_input = self.response_prompt.format(
                intent=intent,
                target=target,
                action=action,
                data=data_str,
                context=original_message
            )
            response = self.llm.invoke(llm_input)
            return response.content if hasattr(response, 'content') else str(response)
        except Exception as e:
            return self._generate_response_fallback(intent, target, action, data)

    def _generate_response_fallback(self, intent: str, target: str, action: str, data: Any) -> str:
        """Fallback response generation using templates."""
        if isinstance(data, dict):
            if data.get('error'):
                return f"Error: {data['error']}"
            elif data.get('message'):
                return data['message']
            elif data.get('success'):
                if intent == 'query':
                    items = data.get('data', [])
                    if isinstance(items, list) and items:
                        return f"Found {len(items)} {target}(s). Here are the details:\n" + \
                               "\n".join([str(item) for item in items[:3]])
                    return f"No {target}s found."
                elif intent == 'explanation':
                    return data.get('explanation', f"Here's the reasoning for {target} {action}.")

        return f"Processed your {intent} request about {target}."
