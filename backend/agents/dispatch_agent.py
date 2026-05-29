from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
import math
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from ..models import Ambulance, Case, Hospital, Logs, db
from ..tools.langchain_tools import recommend_ambulance_for_case, recommend_hospital_for_case
# case ->ambulance,hospital
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
        try:
            if not getattr(case, "severity", None):
                return {
                    "ambulance_id": None,
                    "hospital_id": None,
                    "reasoning": "Case severity is missing. Triaging must complete before dispatch.",
                }

            ambulance_recommendation = recommend_ambulance_for_case.invoke({"case_id": case.id, "top_k": 1})
            hospital_recommendation = recommend_hospital_for_case.invoke({"case_id": case.id, "top_k": 1})

            ambulance_candidates = ambulance_recommendation.get("recommended", []) if ambulance_recommendation.get("success") else []
            hospital_candidates = hospital_recommendation.get("recommended", []) if hospital_recommendation.get("success") else []

            if not ambulance_candidates or not hospital_candidates:
                return self.fallback(case, location)

            chosen_ambulance = ambulance_candidates[0]
            chosen_hospital = hospital_candidates[0]

            result = {
                "ambulance_id": chosen_ambulance["ambulance_id"],
                "hospital_id": chosen_hospital["hospital_id"],
                "reasoning": (
                    f"Selected by ranking tools. Ambulance score={chosen_ambulance.get('score')} "
                    f"reasons={', '.join(chosen_ambulance.get('reasons', []))}. "
                    f"Hospital score={chosen_hospital.get('score')} reasons={', '.join(chosen_hospital.get('reasons', []))}."
                ),
            }
            
            # Log the dispatch decision
            log = Logs(
                case_id=case.id,
                agent_name='dispatch_agent',
                message=f"Dispatched ambulance {result.get('ambulance_id')} to hospital {result.get('hospital_id')}",
                metadata=result.get('reasoning', 'ranking-tool-based dispatch')
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
        ambulance_recommendation = recommend_ambulance_for_case.invoke({"case_id": case.id, "top_k": 1})
        hospital_recommendation = recommend_hospital_for_case.invoke({"case_id": case.id, "top_k": 1})

        ambulance_candidates = ambulance_recommendation.get("recommended", []) if ambulance_recommendation.get("success") else []
        hospital_candidates = hospital_recommendation.get("recommended", []) if hospital_recommendation.get("success") else []

        if not ambulance_candidates or not hospital_candidates:
            return {"ambulance_id": None, "hospital_id": None, "reasoning": "No available ambulance or hospital found."}

        chosen_ambulance = ambulance_candidates[0]
        chosen_hospital = hospital_candidates[0]

        reasoning_parts = [
            f"Ambulance ranking selected {chosen_ambulance['ambulance_id']} with score {chosen_ambulance.get('score')}",
            f"Hospital ranking selected {chosen_hospital['hospital_id']} with score {chosen_hospital.get('score')}",
        ]

        if ambulance_recommendation.get("recommended"):
            reasoning_parts.append(f"ambulance reasons: {', '.join(chosen_ambulance.get('reasons', []))}")
        if hospital_recommendation.get("recommended"):
            reasoning_parts.append(f"hospital reasons: {', '.join(chosen_hospital.get('reasons', []))}")

        reasoning = " | ".join(reasoning_parts)

        log = Logs(
            case_id=case.id,
            agent_name='dispatch_agent',
            message=f"Fallback dispatch used ranking tools: ambulance {chosen_ambulance['ambulance_id']} to hospital {chosen_hospital['hospital_id']}",
            metadata=reasoning
        )
        db.session.add(log)
        db.session.commit()

        return {"ambulance_id": chosen_ambulance["ambulance_id"], "hospital_id": chosen_hospital["hospital_id"], "reasoning": reasoning}

    