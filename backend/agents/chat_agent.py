from __future__ import annotations
import json
import os
from typing import Any, Dict, List, Optional
import re
from langchain_core.prompts import PromptTemplate
from ..models import Ambulance, Case, Hospital
from ..tools.langchain_tools import TOOL_REGISTRY, invoke_tool
try:
    from langchain_groq import ChatGroq
except ImportError:  
    ChatGroq = None

class ChatAgent:
    REQUIRED_FIELDS_BY_TOOL = {
        "fetch_hospital_data": [],  # all optional
        "fetch_ambulance_data": [],  # all optional
        "fetch_case_data": [],  # all optional
        "fetch_resource_snapshot": [],  # all optional
        "update_hospital_resources": ["hospital_id", "resource_type", "quantity_change"],
        "update_ambulance_status": ["ambulance_id", "status"],
        "update_ambulance_location": ["ambulance_id", "current_latitude", "current_longitude"],
        "assign_ambulance_to_case": ["ambulance_id", "case_id"],
        "reserve_resources": ["hospital_id", "resource_type", "quantity", "case_id"],
        "confirm_reservation": ["case_id"],
        "release_resources": ["case_id"],
        "recommend_hospital_for_case": ["case_id"],
        "explain_hospital_selection": [],  # optional: accepts case_id and/or hospital_id
        "recommend_ambulance_for_case": ["case_id"],
        "log_decision": ["agent_name", "message"],
    }

    def __init__(self, llm: Any = None):
        self.llm = llm or self._build_default_llm()
        self.tool_registry = TOOL_REGISTRY
        self.available_tools = self._build_tool_catalog()

        self.planner_prompt = PromptTemplate(
            input_variables=["message", "tool_catalog"],
            template=(
                "You are a real-time tool selection planner for an emergency dispatch chatbot.\n"
                "Choose the single best tool for the user's message, or decide that no tool is needed.\n\n"
                "User message:\n{message}\n\n"
                "Available tools:\n{tool_catalog}\n\n"
                "Return ONLY valid JSON with this shape:\n"
                "{{\n"
                '  "intent": "query|command|explanation|other",\n'
                '  "needs_tool": true,\n'
                '  "tool_name": "one of the available tools or null",\n'
                '  "tool_args": {{"any": "arguments"}},\n'
                '  "assistant_preamble": "short sentence to introduce the tool result",\n'
                '  "reason": "brief why this tool was selected"\n'
                "}}\n\n"
                "Rules:\n"
                "- Prefer a tool whenever the user is asking for system data, an action, or a decision explanation.\n"
                "- If the user asks for hospital data, use fetch_hospital_data, fetch_resource_snapshot, or recommend_hospital_for_case depending on the request.\n"
                "- If the user asks for ambulance status, location, or assignment, use fetch_ambulance_data, update_ambulance_status, update_ambulance_location, or recommend_ambulance_for_case.\n"
                "- If the user asks about cases, use fetch_case_data.\n"
                "- If the user asks to update resources, reserve resources, confirm reservations, or release resources, use the corresponding command tool.\n"
                "- If the user asks why a hospital or ambulance was chosen, use the explanation tools.\n"
                "- Do not invent tool names.\n"
                "- If no tool is appropriate, set needs_tool to false and tool_name to null.\n"
            ),
        )

        self.response_prompt = PromptTemplate(
            input_variables=["message", "plan", "tool_result"],
            template=(
                "You are the response generator for an emergency dispatch chatbot.\n"
                "Use the tool result to answer the user naturally and directly.\n\n"
                "User message:\n{message}\n\n"
                "Planner JSON:\n{plan}\n\n"
                "Tool result JSON:\n{tool_result}\n\n"
                "Write a concise helpful response.\n"
                "- If the tool returned data, summarize it clearly.\n"
                "- If the tool returned an error, explain the issue plainly.\n"
                "- If no tool was needed, answer directly.\n"
                "- Do not mention internal tool names unless useful to the user.\n"
            ),
        )

    def _build_default_llm(self) -> Optional[Any]:
        if ChatGroq is None:
            return None

        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            return None

        model_name = os.getenv("GROQ_MODEL", "llama-3.1-70b-versatile")
        try:
            return ChatGroq(
                api_key=groq_api_key,
                model=model_name,
                temperature=0,
            )
        except Exception:
            return None

    def _build_tool_catalog(self) -> str:
        descriptions = {
            "fetch_hospital_data": "Fetch one hospital or the full hospital list with beds, ICU, ventilators, and specialty flags.",
            "fetch_ambulance_data": "Fetch one ambulance or a filtered ambulance list by status.",
            "fetch_case_data": "Fetch one case or a filtered case list by hospital, ambulance, or period.",
            "fetch_resource_snapshot": "Fetch hospital resource availability and utilization snapshots.",
            "update_hospital_resources": "Update hospital bed, ICU, or ventilator availability.",
            "update_ambulance_status": "Update ambulance status.",
            "update_ambulance_location": "Update ambulance coordinates.",
            "assign_ambulance_to_case": "Assign an ambulance to a case.",
            "reserve_resources": "Reserve resources for a case at a hospital.",
            "confirm_reservation": "Confirm reserved resources for a case.",
            "release_resources": "Release reserved resources for a case.",
            "recommend_hospital_for_case": "Rank hospitals for a case and recommend the best matches.",
            "explain_hospital_selection": "Explain why a hospital was selected for a case.",
            "recommend_ambulance_for_case": "Rank ambulances for a case and recommend the best match.",
            "log_decision": "Log an agent decision for auditability.",
        }
        return "\n".join(f"- {name}: {description}" for name, description in descriptions.items())

    def chat(
        self,
        message: str,
        user_id: Optional[int] = None,
        user_role: Optional[str] = None,
        hospital_user_id: Optional[int] = None,
        ambulance_user_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not message or not message.strip():
            return {"success": False, "response": "Please provide a valid message.", "plan": None}

        plan = self._plan(message)
        tool_result = self._execute_plan(
            plan,
            user_id=user_id,
            user_role=user_role,
            hospital_user_id=hospital_user_id,
            ambulance_user_id=ambulance_user_id,
            message=message,
        )
        response = self._generate_response(message, plan, tool_result)

        return {
            "success": tool_result.get("success", True) if isinstance(tool_result, dict) else True,
            "response": response,
            "plan": plan,
            "data": tool_result,
        }

    def _plan(self, message: str) -> Dict[str, Any]:
        if not self.llm:
            return self._fallback_plan(message)

        try:
            prompt_text = self.planner_prompt.format(message=message, tool_catalog=self.available_tools)
            raw_output = self.llm.invoke(prompt_text)
            content = raw_output.content if hasattr(raw_output, "content") else str(raw_output)
            return self._parse_json_object(content, fallback=self._fallback_plan(message))
        except Exception:
            return self._fallback_plan(message)

    def _fallback_plan(self, message: str) -> Dict[str, Any]:
        return {
            "intent": "other",
            "needs_tool": False,
            "tool_name": None,
            "tool_args": {},
            "assistant_preamble": "",
            "reason": "No specific tool was needed.",
        }

    def _execute_plan(
        self,
        plan: Dict[str, Any],
        user_id: Optional[int],
        user_role: Optional[str],
        hospital_user_id: Optional[int],
        ambulance_user_id: Optional[int],
        message: str,
    ) -> Dict[str, Any]:
        if not plan.get("needs_tool") or not plan.get("tool_name"):
            return {"success": True, "message": plan.get("assistant_preamble") or ""}

        tool_name = plan.get("tool_name")
        tool_args = plan.get("tool_args") or {}
        normalized_args = self._normalize_tool_args(tool_name, tool_args, message=message, user_id=user_id)

        if tool_name not in self.tool_registry:
            return {"success": False, "error": f"Unknown tool: {tool_name}"}

        validation_error = self._validate_tool_args(tool_name, normalized_args)
        if validation_error is not None:
            return validation_error

        return invoke_tool(
            tool_name,
            user_id=user_id,
            user_role=user_role,
            user_hospital_id=hospital_user_id,
            user_ambulance_id=ambulance_user_id,
            **normalized_args,
        )

    def _normalize_tool_args(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        message: str,
        user_id: Optional[int],
    ) -> Dict[str, Any]:
        args = dict(tool_args or {})
        lowered = message.lower()

        if tool_name == "fetch_hospital_data":
            hospital_id = self._extract_first_int(args.get("hospital_id"))
            if hospital_id is None:
                hospital_id = self._extract_first_int(message)
            if hospital_id is not None:
                args["hospital_id"] = hospital_id

        elif tool_name == "fetch_ambulance_data":
            ambulance_id = self._extract_first_int(args.get("ambulance_id"))
            if ambulance_id is None:
                ambulance_id = self._extract_first_int(message)
            if ambulance_id is not None:
                args["ambulance_id"] = ambulance_id
            elif any(word in lowered for word in ["running", "active", "non idle"]):
                args["status"] = "running"
            elif "all ambulances" in lowered or "all ambulance" in lowered:
                args["status"] = "all"

        elif tool_name == "fetch_case_data":
            case_id = self._extract_first_int(args.get("case_id"))
            if case_id is None:
                case_id = self._extract_first_int(message)
            if case_id is not None:
                args["case_id"] = case_id
            elif "today" in lowered:
                args["period"] = "today"
            elif "week" in lowered:
                args["period"] = "week"
            elif "month" in lowered:
                args["period"] = "month"

        elif tool_name == "fetch_resource_snapshot":
            hospital_id = self._extract_first_int(args.get("hospital_id"))
            if hospital_id is None:
                hospital_id = self._extract_first_int(message)
            if hospital_id is not None:
                args["hospital_id"] = hospital_id
            if "ventilator" in lowered:
                args["resource_type"] = "ventilator"
            elif "icu" in lowered:
                args["resource_type"] = "icu"
            elif "bed" in lowered:
                args["resource_type"] = "bed"

        elif tool_name == "update_hospital_resources":
            hospital_id = self._extract_first_int(args.get("hospital_id"))
            quantity_change = self._extract_first_int(args.get("quantity_change"))
            if hospital_id is None:
                hospital_id = self._extract_first_int(message)
            if quantity_change is None:
                quantity_change = self._extract_signed_quantity(message)
            if hospital_id is not None:
                args["hospital_id"] = hospital_id
            if quantity_change is not None:
                args["quantity_change"] = quantity_change
            if "ventilator" in lowered:
                args["resource_type"] = "ventilator"
            elif "icu" in lowered:
                args["resource_type"] = "icu"
            else:
                args.setdefault("resource_type", "bed")

        elif tool_name == "update_ambulance_status":
            ambulance_id = self._extract_first_int(args.get("ambulance_id"))
            if ambulance_id is None:
                ambulance_id = self._extract_first_int(message)
            if ambulance_id is not None:
                args["ambulance_id"] = ambulance_id

            status = args.get("status")
            if not status:
                for candidate in ["idle", "assigned", "en route", "en_route", "delayed", "arrived", "at hospital", "at_hospital"]:
                    if candidate in lowered:
                        args["status"] = candidate
                        break

        elif tool_name == "update_ambulance_location":
            ambulance_id = self._extract_first_int(args.get("ambulance_id"))
            if ambulance_id is None:
                ambulance_id = self._extract_first_int(message)
            if ambulance_id is not None:
                args["ambulance_id"] = ambulance_id

            latitude, longitude = self._extract_coordinates(message)
            if latitude is not None:
                args["current_latitude"] = latitude
            if longitude is not None:
                args["current_longitude"] = longitude

        elif tool_name in {"reserve_resources", "confirm_reservation", "release_resources", "explain_hospital_selection", "recommend_hospital_for_case", "recommend_ambulance_for_case", "assign_ambulance_to_case", "log_decision"}:
            case_id = self._extract_first_int(args.get("case_id"))
            if case_id is None:
                case_id = self._extract_first_int(message)
            if case_id is not None:
                args["case_id"] = case_id

        if tool_name == "reserve_resources":
            hospital_id = self._extract_first_int(args.get("hospital_id"))
            if hospital_id is None:
                hospital_id = self._extract_first_int(message)
            if hospital_id is not None:
                args["hospital_id"] = hospital_id
            if "ventilator" in lowered:
                args["resource_type"] = "ventilator"
            elif "icu" in lowered:
                args["resource_type"] = "icu"
            elif "bed" in lowered:
                args["resource_type"] = "bed"

            quantity = self._extract_first_int(args.get("quantity"))
            if quantity is None:
                quantity = self._extract_first_int(message)
            if quantity is not None:
                args["quantity"] = quantity

        if tool_name == "log_decision":
            args.setdefault("agent_name", "chat_agent")
            args.setdefault("message", message)

        return args

    def _validate_tool_args(self, tool_name: str, tool_args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        def missing_field(field_name: str) -> Dict[str, Any]:
            return {
                "success": False,
                "error": f"{field_name} is required for {tool_name}",
                "tool_name": tool_name,
            }

        def missing_entity(entity: str, entity_id: Any) -> Dict[str, Any]:
            return {
                "success": False,
                "error": f"{entity} {entity_id} not found",
                "tool_name": tool_name,
            }

        # Validate all required fields from REQUIRED_FIELDS_BY_TOOL (Issue #10)
        required_fields = self.REQUIRED_FIELDS_BY_TOOL.get(tool_name, [])
        for field_name in required_fields:
            field_value = tool_args.get(field_name)
            # For numeric fields (IDs, coordinates, quantities), extract and validate
            if field_name in {"hospital_id", "ambulance_id", "case_id", "quantity", "quantity_change"}:
                if self._extract_first_int(field_value) is None:
                    return missing_field(field_name)
            # For numeric coordinate fields
            elif field_name in {"current_latitude", "current_longitude"}:
                if field_value is None or (isinstance(field_value, (int, float)) and field_value is not None):
                    if field_value is None:
                        return missing_field(field_name)
                else:
                    try:
                        float(field_value)
                    except (ValueError, TypeError):
                        return missing_field(field_name)
            # For string fields (resource_type, status, agent_name, message)
            elif field_name in {"resource_type", "status", "agent_name", "message"}:
                if not field_value or (isinstance(field_value, str) and not field_value.strip()):
                    return missing_field(field_name)
            else:
                # Generic check for any other required field
                if field_value is None or (isinstance(field_value, str) and not field_value.strip()):
                    return missing_field(field_name)

        # Extract IDs for entity existence checks
        hospital_id = self._extract_first_int(tool_args.get("hospital_id"))
        ambulance_id = self._extract_first_int(tool_args.get("ambulance_id"))
        case_id = self._extract_first_int(tool_args.get("case_id"))

        # Validate entity existence for tools that use IDs (Issue #10)
        if tool_name in {"fetch_hospital_data", "fetch_resource_snapshot", "update_hospital_resources", "reserve_resources"} and hospital_id is not None:
            if not Hospital.query.get(hospital_id):
                return missing_entity("Hospital", hospital_id)

        if tool_name in {"fetch_ambulance_data", "update_ambulance_status", "update_ambulance_location", "assign_ambulance_to_case"} and ambulance_id is not None:
            if not Ambulance.query.get(ambulance_id):
                return missing_entity("Ambulance", ambulance_id)

        if tool_name in {"fetch_case_data", "confirm_reservation", "release_resources", "recommend_hospital_for_case", "recommend_ambulance_for_case", "assign_ambulance_to_case", "explain_hospital_selection"} and case_id is not None:
            if not Case.query.get(case_id):
                return missing_entity("Case", case_id)

        if tool_name == "fetch_case_data":
            if hospital_id is not None and not Hospital.query.get(hospital_id):
                return missing_entity("Hospital", hospital_id)
            if ambulance_id is not None and not Ambulance.query.get(ambulance_id):
                return missing_entity("Ambulance", ambulance_id)

        if tool_name == "explain_hospital_selection":
            if hospital_id is not None and not Hospital.query.get(hospital_id):
                return missing_entity("Hospital", hospital_id)

        return None

    def _generate_response(self, message: str, plan: Dict[str, Any], tool_result: Dict[str, Any]) -> str:
        if not self.llm:
            return self._generate_response_fallback(plan, tool_result)

        try:
            response_input = self.response_prompt.format(
                message=message,
                plan=json.dumps(plan, ensure_ascii=False),
                tool_result=json.dumps(tool_result, ensure_ascii=False),
            )
            response = self.llm.invoke(response_input)
            return response.content if hasattr(response, "content") else str(response)
        except Exception:
            return self._generate_response_fallback(plan, tool_result)

    def _generate_response_fallback(self, plan: Dict[str, Any], tool_result: Dict[str, Any]) -> str:
        if not tool_result:
            return "I couldn't produce a response."

        if tool_result.get("error"):
            return f"Error: {tool_result['error']}"

        if "message" in tool_result and tool_result["message"]:
            return tool_result["message"]

        if "explanation" in tool_result and tool_result["explanation"]:
            return tool_result["explanation"]

        if "data" in tool_result:
            data = tool_result["data"]
            if isinstance(data, list):
                preview = data[:3]
                return f"Found {len(data)} item(s). First few results: {preview}"
            return f"Here is the information I found: {data}"

        return "Request processed."

    def _parse_json_object(self, text: str, fallback: Dict[str, Any]) -> Dict[str, Any]:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            if cleaned.lower().startswith("json"):
                cleaned = cleaned[4:].strip()

        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                parsed = json.loads(cleaned[start : end + 1])
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass

        return fallback

    def _extract_first_int(self, value: Any) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str):
            match = re.search(r"-?\d+", value)
            if match:
                return int(match.group(0))
        return None

    def _extract_signed_quantity(self, message: str) -> Optional[int]:
        match = re.search(r"([+-]?\d+)", message)
        if match:
            return int(match.group(1))
        return None

    def _extract_coordinates(self, message: str) -> tuple[Optional[float], Optional[float]]:
        lower = message.lower()
        lat_match = re.search(r"lat(?:itude)?\s*[:=]?\s*([-+]?\d+(?:\.\d+)?)", lower)
        lon_match = re.search(r"lon(?:gitude)?\s*[:=]?\s*([-+]?\d+(?:\.\d+)?)", lower)

        latitude = float(lat_match.group(1)) if lat_match else None
        longitude = float(lon_match.group(1)) if lon_match else None

        if latitude is not None and longitude is not None:
            return latitude, longitude

        pair_match = re.search(r"([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)", message)
        if pair_match:
            return float(pair_match.group(1)), float(pair_match.group(2))

        return None, None
