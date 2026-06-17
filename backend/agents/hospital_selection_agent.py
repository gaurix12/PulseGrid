from langchain_core.prompts import PromptTemplate
try:
    from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
except Exception:
    from ..utils.langchain_compat import StructuredOutputParser, ResponseSchema
from langchain_core.language_models.llms import LLM

from ..models import Hospital, db, Case, Logs
import math

HOSPITAL_SELECTION_GUARDRAILS = """You are a hospital selection agent. Your role is to match a patient case with the most optimal hospital.

## STRICT RULES:
1. **Observe Resource Constraints:**
   - Critical cases (P0/P1) **must** go to a hospital with available ICU beds and ventilators.
   - Respect specialty requirements (e.g., Cardiology for heart issues, Trauma Center for major accidents).
2. **Prioritize Proximity:** When resources are equal, select the nearest hospital.
3. **Never send a patient to a hospital with zero available beds.**
4. **Never hallucinate resource availability.** Only make recommendations based on the provided list of hospitals.
"""

def _required_specialty_for_condition(condition: str):
    normalized = str(condition or "").strip().lower()
    if any(keyword in normalized for keyword in ["cardiac", "heart", "chest pain", "heart attack"]):
        return "cardiology"
    if any(keyword in normalized for keyword in ["trauma", "polytrauma", "major accident", "severe accident", "head injury"]):
        return "trauma_care"
    return None


class HospitalSelectionAgent:
    def __init__(self, llm: LLM):
        self.llm = llm
        self.out_parser = StructuredOutputParser.from_response_schemas([
            ResponseSchema(name="hospital_id", description="ID of the chosen hospital"),
            ResponseSchema(name="reasoning", description="short explanation of the decision"),
        ])
        self.format_instructions = self.out_parser.get_format_instructions()
        self.prompt = PromptTemplate(
            input_variables=["severity", "condition", "hospitals_info", "format_instructions"],
            template=(
                HOSPITAL_SELECTION_GUARDRAILS+"\n\n"
                """
You are a hospital selection agent for emergency medical dispatch.

Based on the patient condition and severity, select the best hospital.

Rules:
- Match hospital specialties to condition (trauma center for trauma, cardiology for cardiac, etc.)
- Ensure adequate critical resources: beds, ICU, ventilators based on severity
- Prefer closer hospitals when resources are equivalent
- High severity (P0/P1) requires ICU and ventilators

Patient:
- Condition: {condition}
- Severity (P0(highest)- P3(lowest) ): {severity}

Available Hospitals:
{hospitals_info}

Return ONLY valid JSON matching the format below:

{format_instructions}
"""
            ),
        )

    def _apply_specialty_filter(self, hospitals: list, required_specialty: str) -> list:
        """
        Apply specialty constraint to hospital list.
        HARD CONSTRAINT: If specialty required, only return hospitals with that specialty.
        """
        if not required_specialty:
            return hospitals
        
        if required_specialty == "cardiology":
            filtered = [h for h in hospitals if h.get("has_cardiology", False)]
        elif required_specialty == "trauma_care":
            filtered = [h for h in hospitals if h.get("has_trauma_care", False)]
        else:
            filtered = hospitals
        
        return filtered

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
            math.sin(dlat / 2) ** 2
            + math.cos(math.radians(lat1))
            * math.cos(math.radians(lat2))
            * math.sin(dlon / 2) ** 2
        )

        return r * (2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)))

    def _build_hospital_data(self, case: Case):
        hospitals = Hospital.query.all()
        if not hospitals:
            return [], None

        required_specialty = _required_specialty_for_condition(case.condition)
        data = []
        for hosp in hospitals:
            hosp_lat = getattr(hosp, "lattitude", None)
            if hosp_lat is None:
                hosp_lat = getattr(hosp, "latitude", None)

            distance = self.calculate_distance(case.location, f"{hosp_lat},{hosp.longitude}")
            data.append(
                {
                    "hospital_id": hosp.id,
                    "beds_available": hosp.beds_available,
                    "icu_available": hosp.icu_available,
                    "ventilators_available": hosp.ventilators_available,
                    "has_cardiology": hosp.has_cardiology,
                    "has_trauma_care": hosp.has_trauma_care,
                    "distance": distance,
                }
            )

        # Apply specialty filter (HARD CONSTRAINT)
        data = self._apply_specialty_filter(data, required_specialty)

        return data, required_specialty

    def select_hospital(self, case: Case):
        print(f"[AGENT] Scoring hospitals for case {case.id}...")
        data, required_specialty = self._build_hospital_data(case)
        if not data:
            if required_specialty:
                return {
                    "hospital_id": None,
                    "reasoning": f"No hospital with required {required_specialty} specialty is available",
                }
            return {"hospital_id": None, "reasoning": "No hospitals available"}

        if not self.llm:
            return self.fallback_deterministic(case)

        hospitals_info = "\n".join(
            [
                f"- Hospital {d['hospital_id']}: {d['beds_available']} beds, {d['icu_available']} ICU, {d['ventilators_available']} ventilators, "
                f"Trauma: {d['has_trauma_care']}, Cardiology: {d['has_cardiology']}, Distance: {d['distance']:.1f}km"
                for d in data
            ]
        )

        prompt = self.prompt.format(
            severity=case.severity,
            condition=case.condition,
            hospitals_info=hospitals_info,
            format_instructions=self.format_instructions,
        )

        try:
            response = self.llm.invoke(prompt)
            text = response if isinstance(response, str) else response.content
            result = self.out_parser.parse(text)

            valid_ids = {item["hospital_id"] for item in data}
            selected_id = result.get("hospital_id")
            if selected_id not in valid_ids:
                return self.fallback(case, data, required_specialty)

            hosp = Hospital.query.get(selected_id)
            hosp_name = hosp.name if hosp else f"Hospital {selected_id}"
            print(f"[AGENT] Selected Hospital: {hosp_name}")

            log = Logs(
                case_id=case.id,
                agent_name='hospital_selection_agent',
                message=f"LLM-based hospital selection: {result.get('selected')}",
                metadata_json=result.get("reasoning", "LLM-based selection"),
            )
            db.session.add(log)
            db.session.commit()
            return result
        except Exception:
            return self.fallback(case, data, required_specialty)

    def fallback(self, case: Case, data, required_specialty=None):
        if not data:
            return {"hospital_id": None, "reasoning": "No hospitals available"}

        severity = case.severity
        if severity in ("P0", "P1"):
            suitable_hospitals = [d for d in data if d["icu_available"] > 0 and d["ventilators_available"] > 0]
        else:
            suitable_hospitals = [d for d in data if d["beds_available"] > 0]

        # Apply specialty filter (HARD CONSTRAINT)
        suitable_hospitals = self._apply_specialty_filter(suitable_hospitals, required_specialty)

        if not suitable_hospitals:
            return {
                "hospital_id": None,
                "reasoning": f"No hospital with required {required_specialty or 'resource'} match is available",
            }

        suitable_hospitals.sort(key=lambda x: (x["distance"], -x["icu_available"], -x["ventilators_available"]))
        chosen = suitable_hospitals[0]

        hosp = Hospital.query.get(chosen["hospital_id"])
        hosp_name = hosp.name if hosp else f"Hospital {chosen['hospital_id']}"
        print(f"[AGENT] Selected Hospital: {hosp_name} (Fallback)")

        log = Logs(
            case_id=case.id,
            agent_name='hospital_selection_agent',
            message=f"Deterministic selection used for case {case.id}",
            metadata_json="Based on distance and available resources",
        )
        db.session.add(log)
        db.session.commit()

        return {
            "hospital_id": chosen["hospital_id"],
            "reasoning": f"Fallback: Selected hospital {chosen['hospital_id']} based on distance and available resources",
        }

    def fallback_deterministic(self, case: Case):
        print(f"[AGENT] [Deterministic Fallback] Scoring hospitals for case {case.id}...")
        data, required_specialty = self._build_hospital_data(case)
        if not data:
            if required_specialty:
                return {
                    "hospital_id": None,
                    "reasoning": f"No hospital with required {required_specialty} specialty is available",
                }
            return {"hospital_id": None, "reasoning": "No hospitals available"}

        severity = case.severity
        if severity in ("P0", "P1"):
            candidates = [h for h in data if h["icu_available"] > 0 and h["ventilators_available"] > 0]
        else:
            candidates = [h for h in data if h["beds_available"] > 0]

        # Apply specialty filter (HARD CONSTRAINT)
        candidates = self._apply_specialty_filter(candidates, required_specialty)

        if not candidates:
            return {
                "hospital_id": None,
                "reasoning": f"No hospital with required {required_specialty or 'resource'} match is available",
            }

        best_hospital = min(
            candidates,
            key=lambda h: (h["distance"], -h["icu_available"]),
        )

        hosp = Hospital.query.get(best_hospital["hospital_id"])
        hosp_name = hosp.name if hosp else f"Hospital {best_hospital['hospital_id']}"
        print(f"[AGENT] Selected Hospital: {hosp_name} (Fallback Deterministic)")

        log = Logs(
            case_id=case.id,
            agent_name='hospital_selection_agent',
            message=f"Fallback selection used: hospital {best_hospital['hospital_id']}",
            metadata_json="Based on resources and proximity",
        )
        db.session.add(log)
        db.session.commit()

        return {
            "hospital_id": best_hospital["hospital_id"],
            "reasoning": f"Selected hospital {best_hospital['hospital_id']} based on resources and proximity",
        }
