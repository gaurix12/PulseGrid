from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema
from langchain_core.language_models.llms import LLM
# case-> return severity and condition 
class TriageAgent:
    def __init__(self, llm: LLM):
        self.llm = llm
        self.out_parser = StructuredOutputParser.from_response_schemas([
            ResponseSchema(name="severity", description="P0, P1, P2, or P3"),
            ResponseSchema(name="condition", description ="short medical condition label")
        ])
        self.format_instructions = self.out_parser.get_format_instructions()
        self.prompt = PromptTemplate(
            input_variables=['patient_info', 'format_instructions'],
            template=(
                "You are a medical triage assistant.\n\n"

                "Classify the emergency based on symptoms.\n\n"

                "Severity rules:\n"
                "- P0: life-threatening (heart attack, stroke, unconscious, not breathing)\n"
                "- P1: serious but stable\n"
                "- P2: moderate\n"
                "- P3: minor\n\n"

                "Return:\n"
                "- severity (P0–P3)\n"
                "- condition (short medical label)\n\n"

                "Patient Info:\n"
                "{patient_info}\n\n"

                "{format_instructions}"
            )

        )
    def triage(self, patient_details: str):
        prompt = self.prompt.format(patient_info=patient_details,
                                    format_instructions=self.format_instructions)
        try:
            response = self.llm.invoke(prompt)
            text = response if isinstance(response, str) else response.content
            return self.out_parser.parse(text)
        except Exception as e:
            return self.fallback(patient_details)
        
    def fallback(self,patient_details):
        details_lower = patient_details.lower()
        P0_keys = ["heart attack", "cardiac arrest", "cardiac", "chest pain severe",
            "not breathing", "no pulse", "cannot breathe", "stopped breathing",
            "stroke", "paralysis", "slurred speech", "unconscious", "collapsed",
            "severe accident", "major accident", "polytrauma", "head injury severe",
            "heavy bleeding", "bleeding uncontrollable",
            "unresponsive", "critical condition", "loss of consciousness"]
        
        P1_keys =[
            "chest pain", "cardiac issue", "heart problem",
            "difficulty breathing", "shortness of breath",
            "accident", "injury", "fracture severe", "deep wound",
            "dizziness severe", "confusion", "seizure",
            "severe pain", "high fever", "burn serious"
        ]

        P2_keys = [
            "fracture", "injury minor", "moderate pain",
            "vomiting", "dehydration",
            "fever", "infection",
            "burn minor", "cut deep"
        ]

        P3_keys = [
            "mild pain", "headache", "cold", "cough",
            "minor injury", "small cut", "bruise",
            "weakness", "tired"
        ]
        if any(word in details_lower for word in P0_keys):
            return {"severity": "P0", "condition": "critical emergency"}
        elif any(word in details_lower for word in P1_keys):
            return {"severity": "P1", "condition": "serious condition"}
        elif any(word in details_lower for word in P2_keys):
            return {"severity": "P2", "condition": "Moderate"}
        elif any(word in details_lower for word in P3_keys):
            return {"severity": "P3", "condition": "minor issue"}
        else:
            return {"severity": "P3", "condition": "Unknown"}