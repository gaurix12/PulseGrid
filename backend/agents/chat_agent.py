from __future__ import annotations
import json
import os
from dotenv import load_dotenv
load_dotenv()
from typing import Any, Dict, List, Optional
import re
from langchain_core.prompts import PromptTemplate
from ..models import Ambulance, Case, Hospital
from ..tools.langchain_tools import TOOL_REGISTRY, invoke_tool
try:
    from langchain_groq import ChatGroq
except ImportError:  
    ChatGroq = None


CHAT_GUARDRAILS = """You are an intelligent Emergency Dispatch Assistant for the PulsePath real-time emergency platform.
Your role is to help dispatchers, hospital staff, and ambulance crews manage resources, track units, check statuses, and manage cases.

## STRICT RULES:
1. **NEVER fabricate or hallucinate data.** Only use information returned by tool calls.
2. **Always call the appropriate tool** to fetch current details before responding.
3. **Respect the user's role and authorization restrictions:**
   - **Admins:** Can perform all queries and mutations (update resources, assign ambulances, etc.).
   - **Hospital users:** Can only check/update resources and cases for their specific assigned hospital.
   - **Ambulance users:** Can only check/update status and locations for their specific assigned ambulance.
   *Note: Read queries and updates are automatically scoped to the user's assigned entity (hospital/ambulance) in the backend. Do not refuse to query or update resources/cases on authorization grounds; the backend automatically enforces limits based on the user's identity. If a search returns empty, simply state that no records were found.*
4. **Validate arguments:** Ensure IDs (case_id, hospital_id, ambulance_id) and numbers are extracted cleanly before calling tools.
5. **Be concise, professional, and clear.** This is an emergency environment; keep responses action-oriented and urgent when appropriate.
6. If the request is ambiguous, ask for clarifying details instead of executing potentially destructive actions or guessing.

## CRITICAL ANTI-HALLUCINATION INSTRUCTIONS:
- You ONLY have access to the specific emergency dispatch tools provided in the catalog.
- You DO NOT have access to web search, brave_search, or general knowledge tools.
- If the user asks ANY question not directly related to emergency operations, cases, hospital resources, or ambulances (e.g. general knowledge, opinions, weather, off-topic requests), you MUST NOT call any tools or attempt to answer them. You must immediately state:
  "I am an internal Emergency Dispatch assistant and can only help with tracking ambulances, managing cases, checking hospital resource availability, and updating dispatch status."
"""

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
        "update_case_status": ["case_id", "status"],
        "update_case_data": ["case_id"],
    }

    def __init__(self, llm: Any = None):
        self.llm = llm or self._build_default_llm()
        self.tool_registry = TOOL_REGISTRY
        self.available_tools = self._build_tool_catalog()

        self.planner_prompt = PromptTemplate(
            input_variables=["message", "tool_catalog", "user_context"],
            template=(
                CHAT_GUARDRAILS + "\n\n"
                "User Context:\n{user_context}\n\n"
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
                "- If the user asks to update case status, close cases, discharge patients, resolve cases, or change/transfer/reassign case data, use update_case_data.\n"
                "- If the user asks about cases (other than updating status), use fetch_case_data.\n"
                "- If the user asks to update resources, reserve resources, confirm reservations, or release resources, use the corresponding command tool.\n"
                "- If the user asks why a hospital or ambulance was chosen, use the explanation tools.\n"
                "- Do not invent tool names.\n"
                "- If no tool is appropriate, set needs_tool to false and tool_name to null.\n"
            ),
        )

        self.response_prompt = PromptTemplate(
            input_variables=["message", "plan", "tool_result", "user_context"],
            template=(
                CHAT_GUARDRAILS + "\n\n"
                "User Context:\n{user_context}\n\n"
                "You are the response generator for an emergency dispatch chatbot.\n"
                "Use the tool result to answer the user naturally and directly.\n\n"
                "User message:\n{message}\n\n"
                "Planner JSON:\n{plan}\n\n"
                "Tool result JSON:\n{tool_result}\n\n"
                "Write a concise helpful response.\n"
                "- If the tool returned data, summarize it clearly.\n"
                "- If the tool returned an error, explain the issue plainly.\n"
                "- If no tool was needed, answer directly.\n"
                "- If the user asks any question not directly related to emergency operations, cases, hospital resources, or ambulances (e.g. C++ programming, general knowledge, trivia, weather), you MUST refuse to answer, stating exactly:\n"
                "  'I am an internal Emergency Dispatch assistant and can only help with tracking ambulances, managing cases, checking hospital resource availability, and updating dispatch status.'\n"
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
            "update_case_status": "Update a case status (e.g. resolve, discharge, triage, etc.).",
            "update_case_data": "Update case details including status, hospital_id (e.g. for transfer/reassignment), or ambulance_id.",
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

        role = str(user_role or "").strip().lower()
        if role == "hospital" and hospital_user_id is not None:
            try:
                hosp = Hospital.query.get(hospital_user_id)
                hosp_name = hosp.name if hosp else f"Hospital {hospital_user_id}"
            except Exception:
                hosp_name = f"Hospital {hospital_user_id}"
            user_context = f"Logged-in User Role: hospital. Assigned Hospital: {hosp_name} (ID: {hospital_user_id})."
        elif role == "ambulance" and ambulance_user_id is not None:
            try:
                amb = Ambulance.query.get(ambulance_user_id)
                amb_name = amb.plate_number if amb else f"Ambulance {ambulance_user_id}"
            except Exception:
                amb_name = f"Ambulance {ambulance_user_id}"
            user_context = f"Logged-in User Role: ambulance. Assigned Ambulance: {amb_name} (ID: {ambulance_user_id})."
        elif role == "admin":
            user_context = "Logged-in User Role: admin. Authorized to manage all cases, hospitals, and ambulances."
        else:
            user_context = f"Logged-in User Role: {role or 'unknown'}."

        plan = self._plan(message, user_context=user_context)
        tool_result = self._execute_plan(
            plan,
            user_id=user_id,
            user_role=user_role,
            hospital_user_id=hospital_user_id,
            ambulance_user_id=ambulance_user_id,
            message=message,
        )
        response = self._generate_response(message, plan, tool_result, user_context=user_context)

        return {
            "success": tool_result.get("success", True) if isinstance(tool_result, dict) else True,
            "response": response,
            "plan": plan,
            "data": tool_result,
            "metadata": {
                "plan": plan,
                "tool_result": tool_result,
                "tool_used": plan.get("tool_name") if plan else None,
                "tool_args": plan.get("tool_args") if plan else None,
                "results": tool_result if tool_result else None,
                "reasoning": plan.get("reason") if plan else None,
            },
        }

    def _plan(self, message: str, user_context: str = "") -> Dict[str, Any]:
        if not self.llm:
            return self._fallback_plan(message)

        try:
            prompt_text = self.planner_prompt.format(
                message=message,
                tool_catalog=self.available_tools,
                user_context=user_context
            )
            raw_output = self.llm.invoke(prompt_text)
            content = raw_output.content if hasattr(raw_output, "content") else str(raw_output)
            return self._parse_json_object(content, fallback=self._fallback_plan(message))
        except Exception:
            return self._fallback_plan(message)

    def _fallback_plan(self, message: str) -> Dict[str, Any]:
       # keyword based
        m = message.lower()
        update_kw = any(w in m for w in ["update", "increase", "decrease", "add", "reduce", "set", "change"])
        if update_kw and any(w in m for w in ["bed", "icu", "ventilator", "resource"]):
            return {
                "intent": "command",
                "needs_tool": True,
                "tool_name": "update_hospital_resources",
                "tool_args": {},
                "assistant_preamble": "Updating hospital resources…",
                "reason": "User wants to update hospital resource counts.",
            }
        if update_kw and any(w in m for w in ["ambulance", "unit"]):
            return {
                "intent": "command",
                "needs_tool": True,
                "tool_name": "update_ambulance_status",
                "tool_args": {},
                "assistant_preamble": "Updating ambulance status…",
                "reason": "User wants to update ambulance status.",
            }

        if any(w in m for w in ["assign"]) and "ambulance" in m:
            return {
                "intent": "command",
                "needs_tool": True,
                "tool_name": "assign_ambulance_to_case",
                "tool_args": {},
                "assistant_preamble": "Assigning ambulance to case…",
                "reason": "User wants to assign an ambulance to a case.",
            }

       
        if any(w in m for w in ["bed", "icu", "ventilator"]) and any(w in m for w in ["how many", "available", "free", "status", "show", "list", "get", "check"]):
            return {
                "intent": "query",
                "needs_tool": True,
                "tool_name": "fetch_resource_snapshot",
                "tool_args": {},
                "assistant_preamble": "Fetching resource availability…",
                "reason": "User is asking about resource availability.",
            }

        if any(w in m for w in ["hospital", "hospitals"]) and any(w in m for w in ["show", "list", "get", "status", "info", "details", "how many", "which", "available"]):
            return {
                "intent": "query",
                "needs_tool": True,
                "tool_name": "fetch_hospital_data",
                "tool_args": {},
                "assistant_preamble": "Fetching hospital data…",
                "reason": "User is asking about hospitals.",
            }

        # Ambulance queries
        if any(w in m for w in ["ambulance", "ambulances", "unit", "units"]) and any(w in m for w in ["show", "list", "get", "status", "where", "how many", "available", "idle", "active"]):
            return {
                "intent": "query",
                "needs_tool": True,
                "tool_name": "fetch_ambulance_data",
                "tool_args": {},
                "assistant_preamble": "Fetching ambulance data…",
                "reason": "User is asking about ambulances.",
            }

        if any(w in m for w in ["case", "cases", "patient", "patients", "emergency"]) and any(w in m for w in ["show", "list", "get", "status", "how many", "active", "all"]):
            return {
                "intent": "query",
                "needs_tool": True,
                "tool_name": "fetch_case_data",
                "tool_args": {},
                "assistant_preamble": "Fetching case data…",
                "reason": "User is asking about cases.",
            }

        if any(w in m for w in ["recommend", "best", "suggest"]) and "hospital" in m:
            return {
                "intent": "query",
                "needs_tool": True,
                "tool_name": "recommend_hospital_for_case",
                "tool_args": {},
                "assistant_preamble": "Finding the best hospital for this case…",
                "reason": "User wants a hospital recommendation.",
            }

        if any(w in m for w in ["recommend", "best", "suggest"]) and "ambulance" in m:
            return {
                "intent": "query",
                "needs_tool": True,
                "tool_name": "recommend_ambulance_for_case",
                "tool_args": {},
                "assistant_preamble": "Finding the best ambulance for this case…",
                "reason": "User wants an ambulance recommendation.",
            }

        return {
            "intent": "other",
            "needs_tool": False,
            "tool_name": None,
            "tool_args": {},
            "assistant_preamble": "",
            "reason": "No matching intent detected.",
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
        normalized_args = self._normalize_tool_args(
            tool_name,
            tool_args,
            message=message,
            user_id=user_id,
            user_role=user_role,
            hospital_user_id=hospital_user_id,
            ambulance_user_id=ambulance_user_id,
        )

        plan["tool_args"] = normalized_args

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

    def _extract_hospital_id(self, message: str, args: Dict[str, Any]) -> Optional[int]:
        val = self._extract_first_int(args.get("hospital_id"))
        if val is not None:
            return val
        match = re.search(r"hosp(?:ital)?\s*#?\s*(\d+)", message.lower())
        if match:
            return int(match.group(1))
        return None

    def _extract_ambulance_id(self, message: str, args: Dict[str, Any]) -> Optional[int]:
        val = self._extract_first_int(args.get("ambulance_id"))
        if val is not None:
            return val
        match = re.search(r"amb(?:ulance)?\s*#?\s*(\d+)", message.lower())
        if match:
            return int(match.group(1))
        return None

    def _extract_case_id(self, message: str, args: Dict[str, Any]) -> Optional[int]:
        val = self._extract_first_int(args.get("case_id"))
        if val is not None:
            return val
        match = re.search(r"case\s*#?\s*(\d+)", message.lower())
        if match:
            return int(match.group(1))
        return None

    def _extract_remaining_int(self, message: str, exclude: List[int]) -> Optional[int]:
        all_nums = [int(n) for n in re.findall(r"-?\d+", message)]
        for num in all_nums:
            if num not in exclude:
                return num
        return None

    def _normalize_tool_args(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        message: str,
        user_id: Optional[int],
        user_role: Optional[str] = None,
        hospital_user_id: Optional[int] = None,
        ambulance_user_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        args = dict(tool_args or {})
        lowered = message.lower()

        # Apply role-based scoping constraints
        role = str(user_role or "").strip().lower()
        if role == "hospital" and hospital_user_id is not None:
            if tool_name in {"fetch_hospital_data", "fetch_resource_snapshot", "update_hospital_resources", "reserve_resources", "fetch_case_data"}:
                args["hospital_id"] = hospital_user_id

        if role == "ambulance" and ambulance_user_id is not None:
            if tool_name in {"fetch_ambulance_data", "update_ambulance_status", "update_ambulance_location", "assign_ambulance_to_case", "fetch_case_data"}:
                args["ambulance_id"] = ambulance_user_id

        if tool_name == "fetch_hospital_data":
            hospital_id = self._extract_hospital_id(message, args)
            if hospital_id is not None:
                args["hospital_id"] = hospital_id

        elif tool_name == "fetch_ambulance_data":
            ambulance_id = self._extract_ambulance_id(message, args)
            if ambulance_id is not None:
                args["ambulance_id"] = ambulance_id
            elif any(word in lowered for word in ["running", "active", "non idle"]):
                args["status"] = "running"
            elif "all ambulances" in lowered or "all ambulance" in lowered:
                args["status"] = "all"

        elif tool_name == "fetch_case_data":
            case_id = self._extract_case_id(message, args)
            if case_id is not None:
                args["case_id"] = case_id

            hospital_id = self._extract_hospital_id(message, args)
            if hospital_id is not None:
                args["hospital_id"] = hospital_id

            ambulance_id = self._extract_ambulance_id(message, args)
            if ambulance_id is not None:
                args["ambulance_id"] = ambulance_id

            if "today" in lowered:
                args["period"] = "today"
            elif "week" in lowered:
                args["period"] = "week"
            elif "month" in lowered:
                args["period"] = "month"

        elif tool_name == "fetch_resource_snapshot":
            hospital_id = self._extract_hospital_id(message, args)
            if hospital_id is not None:
                args["hospital_id"] = hospital_id
            if "ventilator" in lowered:
                args["resource_type"] = "ventilator"
            elif "icu" in lowered:
                args["resource_type"] = "icu"
            elif "bed" in lowered:
                args["resource_type"] = "bed"

        elif tool_name == "update_hospital_resources":
            hospital_id = self._extract_hospital_id(message, args)
            
            absolute_value = None
            total_value = None
            quantity_change = None

            # First look at planner args
            if "beds_available" in args or "available_beds" in args or "available" in args:
                absolute_value = self._extract_first_int(args.get("beds_available") or args.get("available_beds") or args.get("available"))
            if "beds_total" in args or "total_beds" in args or "total" in args:
                total_value = self._extract_first_int(args.get("beds_total") or args.get("total_beds") or args.get("total"))
            if "quantity_change" in args:
                quantity_change = self._extract_first_int(args.get("quantity_change"))

            # Fallback message parsing for absolute/total settings
            if absolute_value is None and total_value is None and quantity_change is None:
                total_match = re.search(r"total\s*(?:beds?|icu|ventilators?)?\s*(?:to|as|=)\s*(\d+)", lowered)
                avail_match = re.search(r"(?:available|free|avail)\s*(?:beds?|icu|ventilators?)?\s*(?:to|as|=)\s*(\d+)", lowered)
                
                if total_match:
                    total_value = int(total_match.group(1))
                if avail_match:
                    absolute_value = int(avail_match.group(1))
                
                if absolute_value is None and total_value is None:
                    # e.g., "set beds to 50"
                    set_match = re.search(r"(?:set|change)\s+(?:beds?|icu|ventilators?)\s+(?:to|as|=)\s*(\d+)", lowered)
                    if set_match:
                        absolute_value = int(set_match.group(1))

            # Relative change fallback
            if absolute_value is None and total_value is None and quantity_change is None:
                for resource_key in ["beds", "bed", "icu", "ventilator", "ventilators"]:
                    if resource_key in args:
                        quantity_change = self._extract_first_int(args[resource_key])
                        break
                if quantity_change is None:
                    change_match = re.search(r"(?:by|to|increase|decrease|add|reduce|change)\s*([+-]?\d+)", lowered)
                    if change_match:
                        quantity_change = int(change_match.group(1))
                    else:
                        exclude = []
                        if hospital_id is not None:
                            exclude.append(hospital_id)
                        quantity_change = self._extract_remaining_int(message, exclude)

            if "resource_type" not in args:
                if "ventilator" in lowered:
                    args["resource_type"] = "ventilator"
                elif "icu" in lowered:
                    args["resource_type"] = "icu"
                else:
                    args["resource_type"] = "bed"

            if hospital_id is not None:
                args["hospital_id"] = hospital_id
            if quantity_change is not None:
                args["quantity_change"] = quantity_change
            if absolute_value is not None:
                args["absolute_value"] = absolute_value
            if total_value is not None:
                args["total_value"] = total_value


        elif tool_name == "update_ambulance_status":
            ambulance_id = self._extract_ambulance_id(message, args)
            if ambulance_id is not None:
                args["ambulance_id"] = ambulance_id

            status = args.get("status")
            if not status:
                for candidate in ["idle", "assigned", "en route", "en_route", "delayed", "arrived", "at hospital", "at_hospital"]:
                    if candidate in lowered:
                        args["status"] = candidate
                        break

        elif tool_name == "update_ambulance_location":
            ambulance_id = self._extract_ambulance_id(message, args)
            if ambulance_id is not None:
                args["ambulance_id"] = ambulance_id

            latitude, longitude = self._extract_coordinates(message)
            if latitude is not None:
                args["current_latitude"] = latitude
            if longitude is not None:
                args["current_longitude"] = longitude

        elif tool_name in {"confirm_reservation", "release_resources", "explain_hospital_selection", "recommend_hospital_for_case", "recommend_ambulance_for_case", "log_decision"}:
            case_id = self._extract_case_id(message, args)
            if case_id is not None:
                args["case_id"] = case_id

        elif tool_name == "assign_ambulance_to_case":
            ambulance_id = self._extract_ambulance_id(message, args)
            case_id = self._extract_case_id(message, args)
            if ambulance_id is None or case_id is None:
                exclude = []
                if ambulance_id is not None:
                    exclude.append(ambulance_id)
                if case_id is not None:
                    exclude.append(case_id)
                remaining = [int(n) for n in re.findall(r"-?\d+", message) if int(n) not in exclude]
                if ambulance_id is None and case_id is None:
                    if len(remaining) >= 2:
                        ambulance_id = remaining[0]
                        case_id = remaining[1]
                elif ambulance_id is None:
                    if remaining:
                        ambulance_id = remaining[0]
                elif case_id is None:
                    if remaining:
                        case_id = remaining[0]
            if ambulance_id is not None:
                args["ambulance_id"] = ambulance_id
            if case_id is not None:
                args["case_id"] = case_id

        elif tool_name in {"update_case_status", "update_case_data"}:
            case_id = self._extract_case_id(message, args)
            if case_id is not None:
                args["case_id"] = case_id

            status = args.get("status")
            if not status:
                for candidate in ["discharged", "failed_escalation", "resolved", "alerts_sent", "triaged", "dispatched", "arrived"]:
                    if candidate in lowered:
                        args["status"] = candidate
                        break
                if not args.get("status") and ("transfer" in lowered or "failed" in lowered):
                    args["status"] = "failed_escalation"

            if tool_name == "update_case_data":
                hospital_id = self._extract_hospital_id(message, args)
                if hospital_id is not None:
                    args["hospital_id"] = hospital_id
                ambulance_id = self._extract_ambulance_id(message, args)
                if ambulance_id is not None:
                    args["ambulance_id"] = ambulance_id

        if tool_name == "reserve_resources":
            hospital_id = self._extract_hospital_id(message, args)
            case_id = self._extract_case_id(message, args)
            quantity = self._extract_first_int(args.get("quantity"))
            if quantity is None:
                exclude = []
                if hospital_id is not None:
                    exclude.append(hospital_id)
                if case_id is not None:
                    exclude.append(case_id)
                quantity = self._extract_remaining_int(message, exclude)

            if hospital_id is not None:
                args["hospital_id"] = hospital_id
            if case_id is not None:
                args["case_id"] = case_id
            if quantity is not None:
                args["quantity"] = quantity

            if "resource_type" not in args:
                if "ventilator" in lowered:
                    args["resource_type"] = "ventilator"
                elif "icu" in lowered:
                    args["resource_type"] = "icu"
                elif "bed" in lowered:
                    args["resource_type"] = "bed"

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

        required_fields = self.REQUIRED_FIELDS_BY_TOOL.get(tool_name, [])
        for field_name in required_fields:
            if tool_name == "update_hospital_resources" and field_name == "quantity_change":
                if "absolute_value" in tool_args or "total_value" in tool_args:
                    continue
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

        if tool_name in {"fetch_hospital_data", "fetch_resource_snapshot", "update_hospital_resources", "reserve_resources", "update_case_data"} and hospital_id is not None:
            if not Hospital.query.get(hospital_id):
                return missing_entity("Hospital", hospital_id)

        if tool_name in {"fetch_ambulance_data", "update_ambulance_status", "update_ambulance_location", "assign_ambulance_to_case", "update_case_data"} and ambulance_id is not None:
            if not Ambulance.query.get(ambulance_id):
                return missing_entity("Ambulance", ambulance_id)

        if tool_name in {"fetch_case_data", "confirm_reservation", "release_resources", "recommend_hospital_for_case", "recommend_ambulance_for_case", "assign_ambulance_to_case", "explain_hospital_selection", "update_case_status", "update_case_data"} and case_id is not None:
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

    def _generate_response(self, message: str, plan: Dict[str, Any], tool_result: Dict[str, Any], user_context: str = "") -> str:
        if not self.llm:
            return self._generate_response_fallback(plan, tool_result)

        try:
            response_input = self.response_prompt.format(
                message=message,
                plan=json.dumps(plan, ensure_ascii=False),
                tool_result=json.dumps(tool_result, ensure_ascii=False),
                user_context=user_context,
            )
            response = self.llm.invoke(response_input)
            return response.content if hasattr(response, "content") else str(response)
        except Exception:
            return self._generate_response_fallback(plan, tool_result)

    def _generate_response_fallback(self, plan: Dict[str, Any], tool_result: Dict[str, Any]) -> str:
        if not tool_result:
            return "I could not produce a response."

        tool_name = plan.get("tool_name") or ""

        if tool_result.get("error"):
            return f"Could not complete the request: {tool_result['error']}"

        if not tool_result.get("success", True):
            return tool_result.get("message") or "The action could not be completed."

        data = tool_result.get("data") or tool_result

        if tool_name == "update_hospital_resources":
            rt = tool_result.get("resource_type") or (data.get("resource_type") if isinstance(data, dict) else "resource")
            change = tool_result.get("quantity_change")
            hosp_name = (data.get("name") if isinstance(data, dict) else None) or f"Hospital {tool_result.get('hospital_id')}"

            new_val = None
            if isinstance(data, dict):
                rt_lower = (rt or "").lower()
                if rt_lower in ("bed", "beds"):
                    new_val = data.get("beds_available")
                elif rt_lower == "icu":
                    new_val = data.get("icu_available")
                elif rt_lower in ("ventilator", "ventilators"):
                    new_val = data.get("ventilators_available")

            sign = f"+{change}" if isinstance(change, int) and change > 0 else str(change)
            if new_val is not None:
                return (f"\u2705 {hosp_name}: {(rt or '').upper()} updated by {sign}. "
                        f"Now {new_val} available.")
            # Fallback to tool-level message
            msg = tool_result.get("message", "")
            return f"\u2705 {msg}" if msg else "\u2705 Resource updated successfully."

        if tool_name == "update_ambulance_status":
            amb_id = data.get("ambulance_id")
            status = data.get("status")
            if amb_id and status:
                return f"\u2705 Ambulance {amb_id} status updated to \u2018{status}\u2019."
            return f"\u2705 {tool_result.get('message', 'Ambulance status updated.')}"

        if tool_name == "assign_ambulance_to_case":
            amb_id = data.get("ambulance_id")
            case_id = data.get("case_id")
            if amb_id and case_id:
                return f"\u2705 Ambulance {amb_id} has been assigned to Case {case_id}."
            return f"\u2705 {tool_result.get('message', 'Assignment completed.')}"

        if tool_name == "fetch_resource_snapshot":
            if isinstance(data, dict):
                rows = [data]
            elif isinstance(data, list):
                rows = data
            else:
                rows = []

            if rows:
                lines = ["\U0001f3e5 Resource Snapshot:"]
                for r in rows[:6]:
                    name = r.get("hospital") or f"Hospital {r.get('hospital_id')}"
                    focused = r.get("focused_resource")
                    if focused and isinstance(focused, dict):
                        rt = focused.get("type", "resource")
                        avail = focused.get("available", "?")
                        total = focused.get("total", "?")
                        lines.append(f"  {name} • {rt.upper()}: {avail}/{total} available")
                    else:
                        beds_avail = r.get("beds_available", "?")
                        beds_tot = r.get("beds_total", "?")
                        icu_avail = r.get("icu_available", "?")
                        icu_tot = r.get("icu_total", "?")
                        vents_avail = r.get("ventilators_available", "?")
                        vents_tot = r.get("ventilators_total", "?")
                        lines.append(f"  {name} • BEDS: {beds_avail}/{beds_tot} | ICU: {icu_avail}/{icu_tot} | VENTS: {vents_avail}/{vents_tot} available")
                return "\n".join(lines)
            return "No resource data available."

        if tool_name == "fetch_hospital_data":
            rows = data if isinstance(data, list) else ([data] if isinstance(data, dict) and data else [])
            if rows:
                lines = ["\U0001f3e5 Hospital Overview:"]
                for h in rows[:5]:
                    name = h.get("name", "Unknown")
                    beds = h.get("beds_available", "?")
                    icu = h.get("icu_available", "?")
                    vents = h.get("ventilators_available", "?")
                    lines.append(f"  {name} • Beds: {beds} | ICU: {icu} | Vents: {vents}")
                if len(rows) > 5:
                    lines.append(f"  … and {len(rows)-5} more")
                return "\n".join(lines)
            return "No hospital data found."

        if tool_name == "fetch_ambulance_data":
            rows = data if isinstance(data, list) else ([data] if isinstance(data, dict) and data else [])
            if rows:
                lines = ["\U0001f691 Ambulance Fleet:"]
                for a in rows[:8]:
                    amb_id = a.get("id", "?")
                    driver = a.get("driver_name", "Unknown")
                    status = a.get("status", "unknown")
                    case = a.get("current_case_id")
                    case_str = f" → Case {case}" if case else ""
                    lines.append(f"  Ambulance {amb_id} ({driver}): {status}{case_str}")
                return "\n".join(lines)
            return "No ambulance data found."

        if tool_name == "fetch_case_data":
            rows = data if isinstance(data, list) else ([data] if isinstance(data, dict) and data else [])
            if rows:
                lines = ["\U0001f6a8 Cases:"]
                for c in rows[:8]:
                    cid = c.get("id", "?")
                    name = c.get("patient_name", "Unknown")
                    sev = c.get("severity", "?")
                    status = c.get("status", "?")
                    lines.append(f"  Case {cid} • {name} [{sev}] — {status}")
                if len(rows) > 8:
                    lines.append(f"  … and {len(rows)-8} more")
                return "\n".join(lines)
            return "No cases found."

        if tool_name in ("recommend_hospital_for_case", "recommend_ambulance_for_case"):
            explanation = data.get("explanation") or data.get("reasoning") or data.get("message")
            if explanation:
                return explanation
            top = data.get("recommended") or (data.get("ranked", [{}])[0] if data.get("ranked") else None)
            if top:
                return f"\u2705 Recommended: {top.get('name') or top.get('driver_name') or str(top)}"

        if tool_result.get("message"):
            return f"\u2705 {tool_result['message']}"
        if isinstance(data, dict) and data.get("message"):
            return f"\u2705 {data['message']}"
        if isinstance(data, dict) and data.get("explanation"):
            return data["explanation"]

        return "\u2705 Action completed successfully."

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
