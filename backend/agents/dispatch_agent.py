from langchain_core.prompts import PromptTemplate
try:
    from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
except Exception:
    from ..utils.langchain_compat import StructuredOutputParser, ResponseSchema
from typing import Any
from ..models import Ambulance, Case, Hospital, Logs, db
from ..tools.langchain_tools import recommend_ambulance_for_case, recommend_hospital_for_case
from ..utils.h3 import compute_h3_from_location, h3_grid_distance
# case ->ambulance,hospital

DISPATCH_GUARDRAILS = """You are an emergency dispatch system agent. Your role is to select the best ambulance and hospital combination for incoming cases.

## STRICT RULES:
1. **Nearest Ambulance:** Choose the closest idle ambulance to the patient location.
2. **Safety First:** Select a hospital with matching capabilities and resource availability matching the patient's triage severity.
3. **Log Decisions:** Ensure the selected IDs correspond strictly to available units in the parameters. Do not hallucinate IDs.
"""

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
                DISPATCH_GUARDRAILS+"\n\n"
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
    
    
    
    def dispatch(self, case, location):
        try:
            if not getattr(case, "severity", None):
                return {
                    "ambulance_id": None,
                    "hospital_id": None,
                    "reasoning": "Case severity is missing. Triaging must complete before dispatch.",
                }

            print(f"[AGENT] Scoring ambulances for case {case.id}...")
            ambulance_recommendation = recommend_ambulance_for_case.invoke({"case_id": case.id, "top_k": 1})
            print(f"[AGENT] Scoring hospitals for case {case.id}...")
            hospital_recommendation = recommend_hospital_for_case.invoke({"case_id": case.id, "top_k": 1})

            ambulance_candidates = ambulance_recommendation.get("recommended", []) if ambulance_recommendation.get("success") else []
            hospital_candidates = hospital_recommendation.get("recommended", []) if hospital_recommendation.get("success") else []

            if not ambulance_candidates or not hospital_candidates:
                return self.fallback(case, location)

            chosen_ambulance = ambulance_candidates[0]
            chosen_hospital = hospital_candidates[0]

            print(f"[AGENT] Selected Ambulance: ID {chosen_ambulance['ambulance_id']} (score: {chosen_ambulance.get('score')})")
            print(f"[AGENT] Selected Hospital: {chosen_hospital.get('hospital', f'Hospital {chosen_hospital.get('hospital_id')}')} (score: {chosen_hospital.get('score')})")

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
                 metadata_json=result.get('reasoning', 'ranking-tool-based dispatch')
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
            dist = h3_grid_distance(
                getattr(amb, "h3_index", None) or compute_h3_from_location(amb_location),
                compute_h3_from_location(location),
            )
            formatted.append(f"ID: {amb.id}, Status: {amb.status}, H3 grid distance: {dist if dist is not None else 'unknown'} cells")
        return "\n".join(formatted)
    def format_hospitals(self, hospitals, location):
        formatted = []
        for hosp in hospitals:
            hosp_lat = getattr(hosp, 'lattitude', None)
            if hosp_lat is None:
                hosp_lat = getattr(hosp, 'latitude', None)
            hosp_location = f"{hosp_lat},{hosp.longitude}"
            dist = h3_grid_distance(
                getattr(hosp, "h3_index", None) or compute_h3_from_location(hosp_location),
                compute_h3_from_location(location),
            )
            formatted.append(f"ID: {hosp.id}, Name: {hosp.name}, Beds: {hosp.beds_available}/{hosp.beds_total}, ICU: {hosp.icu_available}/{hosp.icu_total}, Ventilators: {hosp.ventilators_available}/{hosp.ventilators_total}, H3 grid distance: {dist if dist is not None else 'unknown'} cells")
        return "\n".join(formatted)

    #fallback: simple rules - nearest ambulance, hospital with resources, log reasoning for audit
    def fallback(self, case, location):
        print(f"[AGENT] [Fallback] Scoring ambulances for case {case.id}...")
        ambulance_recommendation = recommend_ambulance_for_case.invoke({"case_id": case.id, "top_k": 1})
        print(f"[AGENT] [Fallback] Scoring hospitals for case {case.id}...")
        hospital_recommendation = recommend_hospital_for_case.invoke({"case_id": case.id, "top_k": 1})

        ambulance_candidates = ambulance_recommendation.get("recommended", []) if ambulance_recommendation.get("success") else []
        hospital_candidates = hospital_recommendation.get("recommended", []) if hospital_recommendation.get("success") else []

        if not ambulance_candidates or not hospital_candidates:
            return {"ambulance_id": None, "hospital_id": None, "reasoning": "No available ambulance or hospital found."}

        chosen_ambulance = ambulance_candidates[0]
        chosen_hospital = hospital_candidates[0]

        print(f"[AGENT] [Fallback] Selected Ambulance: ID {chosen_ambulance['ambulance_id']} (score: {chosen_ambulance.get('score')})")
        print(f"[AGENT] [Fallback] Selected Hospital: {chosen_hospital.get('hospital', f'Hospital {chosen_hospital.get('hospital_id')}')} (score: {chosen_hospital.get('score')})")

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
              metadata_json=reasoning
        )
        db.session.add(log)
        db.session.commit()

        return {"ambulance_id": chosen_ambulance["ambulance_id"], "hospital_id": chosen_hospital["hospital_id"], "reasoning": reasoning}

    