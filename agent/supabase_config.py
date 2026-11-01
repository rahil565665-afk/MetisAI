"""Tenant-scoped data bridge for independently deployed Pipecat agents.

Clinic containers never receive the central Supabase secret key. Each uses a
short-lived HS256 token signed with its own tenant-specific key to call only the
matching dashboard bridge endpoints.
"""

from __future__ import annotations

import os
import re
import time
from typing import Any
from urllib.parse import quote, urlparse

import httpx
import jwt


class TenantConfigError(RuntimeError):
    """Sanitized configuration or tenant-bridge failure."""


def _bridge_settings() -> tuple[str, str, str]:
    tenant_id = os.getenv("TENANT_ID", "").strip()
    signing_secret = os.getenv("VOICE_TOKEN_SIGNING_SECRET", "").strip()
    dashboard_origin = os.getenv("DASHBOARD_ORIGIN", "").strip().rstrip("/")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", tenant_id):
        raise TenantConfigError("This agent instance has no valid tenant ID")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", signing_secret):
        raise TenantConfigError("This agent instance has no valid bridge key")
    parsed = urlparse(dashboard_origin)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise TenantConfigError("The dashboard bridge URL is invalid")
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise TenantConfigError("The dashboard bridge must use HTTPS")
    if parsed.scheme not in {"https", "http"}:
        raise TenantConfigError("The dashboard bridge protocol is invalid")
    return tenant_id, signing_secret, dashboard_origin


def _bridge_token(tenant_id: str, signing_secret: str) -> str:
    now = int(time.time())
    claims = {
        "tenantId": tenant_id,
        "purpose": "agent_bridge",
        "iat": now,
        "exp": now + 60,
    }
    return jwt.encode(claims, signing_secret, algorithm="HS256")


async def _bridge_request(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    if not path.startswith("/api/agent/") or ".." in path:
        raise TenantConfigError("The requested dashboard bridge path is invalid")
    tenant_id, signing_secret, origin = _bridge_settings()
    headers = {
        "Authorization": f"Bearer {_bridge_token(tenant_id, signing_secret)}",
        "Accept": "application/json",
    }
    if payload is not None:
        headers["Content-Type"] = "application/json"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0), follow_redirects=False) as client:
            response = await client.request(method, f"{origin}{path}", headers=headers, json=payload)
    except httpx.RequestError:
        raise TenantConfigError("The dashboard data bridge could not be reached") from None
    if response.status_code < 200 or response.status_code >= 300:
        raise TenantConfigError("The dashboard rejected the tenant-scoped data request")
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        raise TenantConfigError("The dashboard returned an invalid data response") from None


def normalize_company_row(row: dict[str, Any], tenant_id: str) -> dict[str, Any]:
    """Normalize the receptionist configuration returned for this agent's tenant."""
    if row.get("id") != tenant_id:
        raise TenantConfigError("Tenant configuration did not match this agent instance")
    raw = row.get("receptionist_config")
    if not isinstance(raw, dict):
        raw = {}
    raw_calcom: dict[str, Any] = raw["calcom"] if isinstance(raw.get("calcom"), dict) else {}
    raw_cartesia: dict[str, Any] = raw["cartesia"] if isinstance(raw.get("cartesia"), dict) else {}

    def text(value: Any, limit: int, default: str = "") -> str:
        if not isinstance(value, str):
            return default
        cleaned = value.strip()
        if any(ord(char) < 32 and char not in "\n\t\r" for char in cleaned):
            return default
        return cleaned[:limit]

    calcom = {
        "event_type_id": raw_calcom.get("event_type_id"),
        "event_type_slug": text(raw_calcom.get("event_type_slug"), 120) or None,
        "username": text(raw_calcom.get("username"), 120) or None,
        "team_slug": text(raw_calcom.get("team_slug"), 120) or None,
    }
    faqs: list[dict[str, str]] = []
    raw_faqs = raw.get("faqs")
    if isinstance(raw_faqs, list):
        for item in raw_faqs[:50]:
            if not isinstance(item, dict):
                continue
            question = text(item.get("question"), 300)
            answer = text(item.get("answer"), 2000)
            if question and answer:
                faqs.append({"question": question, "answer": answer})
    return {
        "tenant_id": tenant_id,
        "clinic_name": text(raw.get("clinic_name"), 120),
        "greeting": text(raw.get("greeting"), 500),
        "knowledge": text(raw.get("knowledge_base"), 8000),
        "faqs": faqs,
        "calcom": calcom,
        "cartesia_voice_id": text(raw_cartesia.get("voice_id"), 180),
    }


async def load_company_config(tenant_id: str) -> dict[str, Any]:
    """Fetch one clinic's non-secret receptionist config through the signed bridge."""
    configured_id, _, _ = _bridge_settings()
    if configured_id != tenant_id:
        raise TenantConfigError("This agent cannot read another clinic's configuration")
    row = await _bridge_request("GET", "/api/agent/clinic-config")
    if not isinstance(row, dict):
        raise TenantConfigError("The dashboard returned invalid clinic configuration")
    return normalize_company_row(row, tenant_id)


async def insert_browser_call_log(tenant_id: str) -> str | None:
    """Create a metadata-only browser call record; failure never breaks voice audio."""
    try:
        configured_id, _, _ = _bridge_settings()
        if configured_id != tenant_id:
            return None
        result = await _bridge_request("POST", "/api/agent/call-logs", {})
        call_id = result.get("callId") if isinstance(result, dict) else None
        return call_id if isinstance(call_id, str) else None
    except Exception:
        return None


async def update_browser_call_log(call_id: str | None, fields: dict[str, Any]) -> None:
    """Best-effort update of one call record; the dashboard checks tenant ownership."""
    if not call_id or not re.fullmatch(r"[0-9a-fA-F-]{36}", call_id):
        return
    allowed = {"ended_at", "status", "transfer_requested", "transfer_reason"}
    if not fields or not set(fields).issubset(allowed):
        return
    try:
        await _bridge_request("PATCH", f"/api/agent/call-logs/{call_id}", fields)
    except Exception:
        return


async def record_appointment(payload: dict[str, Any]) -> bool:
    """Record a newly accepted Cal.com booking without blocking the voice reply."""
    try:
        await _bridge_request("POST", "/api/agent/appointments", payload)
        return True
    except Exception:
        return False


async def update_appointment(booking_uid: str, status: str) -> bool:
    """Update a known booking state for this agent's clinic only."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,128}", booking_uid):
        return False
    try:
        await _bridge_request("PATCH", f"/api/agent/appointments/{quote(booking_uid, safe='')}", {"status": status})
        return True
    except Exception:
        return False


async def record_reschedule(payload: dict[str, Any]) -> bool:
    """Record the reschedule when the previous booking exists in the app history."""
    try:
        await _bridge_request("POST", "/api/agent/appointments/reschedule", payload)
        return True
    except Exception:
        return False
