from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
from langchain_core.language_models.llms import LLM
from ..models import Hospital, db, Case, Ambulance, Logs
import math

class HospitalSelectionAgent:
    def __init__(self, llm:LLM):
        self.llm = llm
        self.out_parser = StructuredOutputParser.from_response_schemas([
            ResponseSchema(name="hospital_id", description="ID of the chosen hospital"),
            ResponseSchema(name="reasoning", description="short explanation of the decision")
        ])
        self.format_instructions = self.out_parser.get_format_instructions()
        self.prompt = PromptTemplate(
            input_variables=['severity', 'condition', 'hospitals_info', 'format_instructions'],
            template=("""
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
""")
        )

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
    
    def select_hospital(self, case: Case):
        if not self.llm:
            return self.fallback_deterministic(case)

        hospitals = Hospital.query.all()
        if not hospitals:
            return {"hospital_id": None, "reasoning": "No hospitals available"}

        data = []
        for hosp in hospitals:
            hosp_lat = getattr(hosp, 'lattitude', None)
            if hosp_lat is None:
                hosp_lat = getattr(hosp, 'latitude', None)
            distance = self.calculate_distance(case.location, f"{hosp_lat},{hosp.longitude}")
            data.append({
                "hospital_id": hosp.id,
                "beds_available": hosp.beds_available,
                "icu_available": hosp.icu_available,
                "ventilators_available": hosp.ventilators_available,
                "has_cardiology": hosp.has_cardiology,
                "has_trauma_care": hosp.has_trauma_care,
                "distance": distance
            })

        hospitals_info = "\n".join([
            f"- Hospital {d['hospital_id']}: {d['beds_available']} beds, {d['icu_available']} ICU, {d['ventilators_available']} ventilators, "
            f"Trauma: {d['has_trauma_care']}, Cardiology: {d['has_cardiology']}, Distance: {d['distance']:.1f}km"
            for d in data
        ])

        prompt = self.prompt.format(
            severity=case.severity,
            condition=case.condition,
            hospitals_info=hospitals_info,
            format_instructions=self.format_instructions
        )
        try:
            response = self.llm.invoke(prompt)
            text = response if isinstance(response, str) else response.content
            result = self.out_parser.parse(text)
            
            # Log the hospital selection decision
            log = Logs(
                case_id=case.id,
                agent_name='hospital_selection_agent',
                message=f"Selected hospital {result.get('hospital_id')}",
                metadata=result.get('reasoning', 'LLM-based selection')
            )
            db.session.add(log)
            db.session.commit()
            return result
        except Exception as e:
            return self.fallback(case, data)
        
    def fallback(self, case, data):
        if not data:
            return {"hospital_id": None, "reasoning": "No hospitals available"}

        severity = case.severity
        if severity in ('P0', 'P1'):
            suitable_hospitals = [d for d in data if d["icu_available"] > 0 and d["ventilators_available"] > 0]
        else:
            suitable_hospitals = [d for d in data if d["beds_available"] > 0]

        if not suitable_hospitals:
            suitable_hospitals = data

        suitable_hospitals.sort(key=lambda x: (x["distance"], -x["icu_available"], -x["ventilators_available"]))
        chosen = suitable_hospitals[0]

        # Log the fallback hospital selection
        log = Logs(
            case_id=case.id,
            agent_name='hospital_selection_agent',
            message=f"Fallback: selected hospital {chosen['hospital_id']}",
            metadata=f"Based on distance and available resources"
        )
        db.session.add(log)
        db.session.commit()

        return {
            "hospital_id": chosen["hospital_id"],
            "reasoning": f"Fallback: Selected hospital {chosen['hospital_id']} based on distance and available resources"
        }

    def fallback_deterministic(self, case: Case):
        hospitals = Hospital.query.all()
        if not hospitals:
            return {"hospital_id": None, "reasoning": "No hospitals available"}

        severity = case.severity
        if severity in ('P0', 'P1'):
            candidates = [h for h in hospitals if h.icu_available > 0 and h.ventilators_available > 0]
        else:
            candidates = [h for h in hospitals if h.beds_available > 0]

        if not candidates:
            candidates = hospitals

        best_hospital = min(
            candidates,
            key=lambda h: (getattr(h, 'distance', 0) or 0, -h.icu_available)
        )

        # Log the deterministic hospital selection
        log = Logs(
            case_id=case.id,
            agent_name='hospital_selection_agent',
            message=f"Deterministic: selected hospital {best_hospital.id}",
            metadata=f"Based on resources and proximity"
        )
        db.session.add(log)
        db.session.commit()

        return {
            "hospital_id": best_hospital.id,
            "reasoning": f"Selected hospital {best_hospital.id} based on resources and proximity"
        }
    