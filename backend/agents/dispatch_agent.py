from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
import math
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from ..models import Ambulance, Case, Hospital, Logs, db

class DispatchAgent:
    def __init__(self, llm: Any = None):
        self.llm = llm
        self.out_parser = StructuredOutputParser.from_response_schemas([
                ResponseSchema(name="hospital_id", description ="ID of the chosen hospital"),
                ResponseSchema(name="ambulance_id", description ="ID of the chosen ambulance"),
                ResponseSchema(name="reasoning", description ="short explanation of the decision")
            ])
        self.format_instructions = self.out_parser.get_format_instructions()
        self.prompt = PromptTemplate(
            input_variables=['patient_name', 'condition', 'severity', 'location', 'ambulances', 'hospitals', 'format_instructions'],

            template=(
                """
You are an emergency dispatch system.

Select the best ambulance and hospital.

Rules:
- Prioritize patient safety
- Choose nearest ambulance
- Choose hospital with ICU/ventilator if severity is high
- Prefer hospitals with required specialties

Patient:
- Name: {patient_name}
- Condition: {condition}
- Severity (P0(highest)- P3(lowest) ): {severity}
- Location: {location}

Available Ambulances:
{ambulances}

Available Hospitals:
{hospitals}

Return ONLY valid JSON that matches the format instructions below.

{format_instructions}
"""
            )

        )
    # take case -> list of available ambulance that are idle, or worst case assigned  -> list of hospitals(filter available icu, ventilator > capacity) -> return best ambulance 
    
    
    def calculate_distance(self, loc1: str, loc2: str) -> float:
        if not loc1 or not loc2:
            return 9999

        try:
            lat1, lon1 = map(float, loc1.split(","))
            lat2, lon2 = map(float, loc2.split(","))
        except (ValueError, AttributeError):
            return 9999
        r = 6371
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)

        a = (
            math.sin(dlat / 2) ** 2 +
            math.cos(math.radians(lat1)) *
            math.cos(math.radians(lat2)) *
            math.sin(dlon / 2) ** 2
        )

        return r * (2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)))
    
    def dispatch(self, case, location):
        ambulances = Ambulance.query.filter_by(status='idle').all()
        if not ambulances:
            ambulances = Ambulance.query.filter(Ambulance.status == 'assigned').all()
        hospitals = Hospital.query.filter(
            Hospital.beds_available > 0,
            Hospital.icu_available > 0,
            Hospital.ventilators_available > 0,
            Hospital.capacity > Hospital.current_patients
        ).all()
        ambulances = self.format_ambulances(ambulances, location)
        hospitals = self.format_hospitals(hospitals, location)
        prompt = self.prompt.format(patient_name=case.patient_name,
                                    condition=case.condition,
                                    severity=case.severity,
                                    location=location,
                                    ambulances=ambulances,
                                    hospitals=hospitals,
                                    format_instructions=self.format_instructions)
        try:
            response = self.llm.invoke(prompt)
            text = response if isinstance(response, str) else response.content
            result = self.out_parser.parse(text)
            
            # Log the dispatch decision
            log = Logs(
                case_id=case.id,
                agent_name='dispatch_agent',
                message=f"Dispatched ambulance {result.get('ambulance_id')} to hospital {result.get('hospital_id')}",
                metadata=result.get('reasoning', 'LLM-based dispatch')
            )
            db.session.add(log)
            db.session.commit()
            return result
        except Exception as e:
            return self.fallback(case, location)
        

    def format_ambulances(self, ambulances, location):
        formatted = []
        for amb in ambulances:
            amb_location = f"{amb.current_latitude},{amb.current_longitude}"
            dist = self.calculate_distance(amb_location, location)
            formatted.append(f"ID: {amb.id}, Status: {amb.status}, Distance: {dist:.2f} km")
        return "\n".join(formatted)
    def format_hospitals(self, hospitals, location):
        formatted = []
        for hosp in hospitals:
            hosp_lat = getattr(hosp, 'lattitude', None)
            if hosp_lat is None:
                hosp_lat = getattr(hosp, 'latitude', None)
            hosp_location = f"{hosp_lat},{hosp.longitude}"
            dist = self.calculate_distance(hosp_location, location)
            formatted.append(f"ID: {hosp.id}, Name: {hosp.name}, Beds: {hosp.beds_available}/{hosp.beds_total}, ICU: {hosp.icu_available}/{hosp.icu_total}, Ventilators: {hosp.ventilators_available}/{hosp.ventilators_total}, Distance: {dist:.2f} km")
        return "\n".join(formatted)

    #fallback: simple rules - nearest ambulance, hospital with resources, log reasoning for audit
    def fallback(self, case, location):
        ambulances = Ambulance.query.filter_by(status='idle').all()
        if not ambulances:
            ambulances = Ambulance.query.filter(Ambulance.status == 'assigned').all()
        hospitals = Hospital.query.filter(
            Hospital.beds_available > 0,
            Hospital.icu_available > 0,
            Hospital.ventilators_available > 0,
            Hospital.capacity > Hospital.current_patients
        ).all()

        if not ambulances or not hospitals:
            return {"ambulance_id": None, "hospital_id": None, "reasoning": "No available ambulance or hospital found."}

        def ambulance_location(amb):
            return f"{amb.current_latitude},{amb.current_longitude}"

        def hospital_location(hosp):
            hosp_lat = getattr(hosp, 'lattitude', None)
            if hosp_lat is None:
                hosp_lat = getattr(hosp, 'latitude', None)
            return f"{hosp_lat},{hosp.longitude}"

        nearest_ambulance = min(
            ambulances,
            key=lambda amb: self.calculate_distance(ambulance_location(amb), location)
        )

        if case.severity in ('P0', 'P1'):
            suitable_hospitals = [h for h in hospitals if h.icu_available > 0 and h.ventilators_available > 0]
        else:
            suitable_hospitals = [h for h in hospitals if h.beds_available > 0]

        if not suitable_hospitals:
            suitable_hospitals = hospitals

        chosen_hospital = min(
            suitable_hospitals,
            key=lambda h: self.calculate_distance(hospital_location(h), location)
        )
        reasoning = f"Fallback: Chose ambulance {nearest_ambulance.id} and hospital {chosen_hospital.id} based on proximity and resource availability."
        
        # Log the fallback dispatch decision
        log = Logs(
            case_id=case.id,
            agent_name='dispatch_agent',
            message=f"Fallback dispatch: ambulance {nearest_ambulance.id} to hospital {chosen_hospital.id}",
            metadata=reasoning
        )
        db.session.add(log)
        db.session.commit()
        
        return {"ambulance_id": nearest_ambulance.id, "hospital_id": chosen_hospital.id, "reasoning": reasoning}

    