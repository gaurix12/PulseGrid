import json
from typing import Any, List

class ResponseSchema:
    def __init__(self, name: str, description: str):
        self.name = name
        self.description = description

class StructuredOutputParser:
    def __init__(self, schemas: List[ResponseSchema]):
        self.schemas = schemas

    @classmethod
    def from_response_schemas(cls, schemas: List[ResponseSchema]):
        return cls(schemas)

    def get_format_instructions(self) -> str:
        return "Please provide a JSON object matching the response schemas: " + ", ".join([s.name for s in self.schemas])

    def parse(self, text: Any) -> Any:
        # If already a dict, return as-is
        if isinstance(text, dict):
            return text
        # If text-like, try JSON
        try:
            if hasattr(text, 'content'):
                text = text.content
            return json.loads(text)
        except Exception:
            # best-effort: try to extract a JSON substring
            try:
                start = text.index('{')
                end = text.rfind('}')
                return json.loads(text[start:end+1])
            except Exception:
                return {s.name: None for s in self.schemas}
