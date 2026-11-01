"""Minimal server-side Cal.com v2 adapter. Never logs provider requests or responses."""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx


class CalComError(RuntimeError):
    """Sanitized Cal.com configuration, validation, or API failure."""


class CalComClient:
    BASE_URL = "https://api.cal.com/v2"

    def __init__(
        self,
        *,
        api_key: str,
        event_type_id: int | None,
        event_type_slug: str | None,
        username: str | None,
        team_slug: str | None,
    ) -> None:
        self._api_key = api_key
        self._event_type_id = event_type_id
        self._event_type_slug = event_type_slug
        self._username = username
        self._team_slug = team_slug

    @classmethod
    def from_environment(cls, tenant_config: dict[str, Any] | None = None) -> "CalComClient":
        config = tenant_config if isinstance(tenant_config, dict) else {}
        local_fallback = os.getenv("LOCAL_DEV_FALLBACK", "").strip().lower() == "true"
        raw_event_id = config.get("event_type_id")
        slug = config.get("event_type_slug")
        username = config.get("username")
        team_slug = config.get("team_slug")
        if local_fallback:
            raw_event_id = raw_event_id or os.getenv("CALCOM_EVENT_TYPE_ID", "").strip()
            slug = slug or os.getenv("CALCOM_EVENT_TYPE_SLUG", "").strip()
            username = username or os.getenv("CALCOM_USERNAME", "").strip()
            team_slug = team_slug or os.getenv("CALCOM_TEAM_SLUG", "").strip()
        raw_event_id = str(raw_event_id).strip() if raw_event_id is not None else ""
        event_type_id: int | None = None
        if raw_event_id:
            try:
                event_type_id = int(raw_event_id)
                if event_type_id < 1:
                    raise ValueError
            except ValueError as exc:
                raise CalComError("Cal.com event type ID must be a positive integer") from exc
        slug = str(slug).strip() if slug else None
        username = str(username).strip() if username else None
        team_slug = str(team_slug).strip() if team_slug else None
        if bool(event_type_id) == bool(slug):
            raise CalComError("Configure exactly one Cal.com event type ID or slug in the clinic settings")
        if slug and bool(username) == bool(team_slug):
            raise CalComError("A slug event type requires exactly one clinic username or team slug")
        key = os.getenv("CALCOM_API_KEY", "").strip()
        if not key:
            raise CalComError("Cal.com scheduling is not configured")
        return cls(
            api_key=key,
            event_type_id=event_type_id,
            event_type_slug=slug,
            username=username,
            team_slug=team_slug,
        )

    def _event_params(self) -> dict[str, str | int]:
        if self._event_type_id is not None:
            return {"eventTypeId": self._event_type_id}
        assert self._event_type_slug is not None
        params: dict[str, str | int] = {"eventTypeSlug": self._event_type_slug}
        if self._team_slug:
            params["teamSlug"] = self._team_slug
        if self._username:
            params["username"] = self._username
        return params

    async def _request(
        self,
        method: str,
        path: str,
        *,
        version: str,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "cal-api-version": version,
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(12.0), follow_redirects=False) as client:
                response = await client.request(
                    method,
                    f"{self.BASE_URL}{path}",
                    headers=headers,
                    params=params,
                    json=json_body,
                )
        except httpx.RequestError as exc:
            # Do not propagate exception text; it can contain request metadata.
            raise CalComError("Cal.com could not be reached") from None
        if response.status_code >= 400:
            if response.status_code in (401, 403):
                raise CalComError("Cal.com rejected the configured credentials or access")
            if response.status_code == 404:
                raise CalComError("The requested Cal.com record was not found")
            if response.status_code == 409:
                raise CalComError("The requested appointment slot is no longer available")
            if response.status_code == 429:
                raise CalComError("Cal.com rate limit reached; try again shortly")
            raise CalComError("Cal.com could not complete the scheduling request")
        try:
            payload = response.json()
        except ValueError:
            raise CalComError("Cal.com returned an invalid response") from None
        if not isinstance(payload, dict) or payload.get("status") == "error":
            raise CalComError("Cal.com returned an unsuccessful response")
        data = payload.get("data")
        if not isinstance(data, (dict, list)):
            raise CalComError("Cal.com returned an incomplete response")
        return payload

    async def available_slots(self, start: datetime, end: datetime, time_zone: str) -> Any:
        query: dict[str, Any] = {
            **self._event_params(),
            "start": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "end": end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "timeZone": time_zone,
            "format": "range",
        }
        payload = await self._request("GET", "/slots", version="2024-09-04", params=query)
        # Return only Cal.com's availability data; never return request credentials/config.
        return payload["data"]

    def _booking_body_event(self) -> dict[str, Any]:
        if self._event_type_id is not None:
            return {"eventTypeId": self._event_type_id}
        return {
            "eventTypeSlug": self._event_type_slug,
            **({"teamSlug": self._team_slug} if self._team_slug else {"username": self._username}),
        }

    async def create_booking(
        self,
        *,
        name: str,
        email: str,
        start: datetime,
        time_zone: str,
    ) -> dict[str, Any]:
        body = {
            **self._booking_body_event(),
            "start": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "attendee": {"name": name, "email": email, "timeZone": time_zone, "language": "en"},
        }
        payload = await self._request("POST", "/bookings", version="2026-02-25", json_body=body)
        return self._booking_summary(payload["data"])

    async def _get_booking(self, booking_uid: str) -> dict[str, Any]:
        payload = await self._request(
            "GET", f"/bookings/{booking_uid}", version="2026-02-25"
        )
        data = payload["data"]
        if not isinstance(data, dict):
            # Recurring UID resolving to multiple records is ambiguous: fail closed.
            raise CalComError("The Cal.com booking identity is ambiguous")
        return data

    async def require_attendee_identity(self, booking_uid: str, patient_email: str) -> None:
        booking = await self._get_booking(booking_uid)
        attendees = booking.get("attendees")
        if not isinstance(attendees, list) or not attendees:
            raise CalComError("Cal.com did not provide attendee identity; mutation denied")
        matching = False
        for attendee in attendees:
            if isinstance(attendee, dict) and isinstance(attendee.get("email"), str):
                if attendee["email"].strip().lower() == patient_email:
                    matching = True
                    break
        if not matching:
            raise CalComError("Patient identity does not match this booking; mutation denied")
        if booking.get("status") not in {"accepted", "pending"}:
            raise CalComError("This booking cannot be changed in its current status")

    async def reschedule_booking(
        self, booking_uid: str, *, email: str, new_start: datetime
    ) -> dict[str, Any]:
        body = {
            "start": new_start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "rescheduledBy": email,
            "reschedulingReason": "Patient requested rescheduling through the dental receptionist",
        }
        payload = await self._request(
            "POST", f"/bookings/{booking_uid}/reschedule", version="2026-02-25", json_body=body
        )
        return self._booking_summary(payload["data"])

    async def cancel_booking(self, booking_uid: str, *, reason: str) -> dict[str, Any]:
        payload = await self._request(
            "POST",
            f"/bookings/{booking_uid}/cancel",
            version="2026-02-25",
            json_body={"cancellationReason": reason},
        )
        return self._booking_summary(payload["data"])

    @staticmethod
    def _booking_summary(data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            raise CalComError("Cal.com returned an ambiguous booking result")
        result: dict[str, Any] = {}
        for key in ("uid", "status", "start", "end"):
            value = data.get(key)
            if isinstance(value, (str, int, float)):
                result[key] = value
        event_type = data.get("eventType")
        if isinstance(event_type, dict) and isinstance(event_type.get("title"), str):
            result["eventType"] = {"title": event_type["title"][:160]}
        if not result:
            raise CalComError("Cal.com returned an incomplete booking result")
        return result
