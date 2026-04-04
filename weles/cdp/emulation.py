"""CDP emulation helpers for user agent and viewport."""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .connection import CDPConnection


async def set_user_agent(
    session_id: str,
    connection: CDPConnection,
    user_agent: str,
    *,
    platform: Optional[str] = None,
    accept_language: Optional[str] = None,
):
    """Set the browser's user agent string via Emulation domain.

    Args:
        session_id: CDP session ID for the target.
        connection: Active CDPConnection instance.
        user_agent: The user agent string to set.
        platform: Navigator.platform value (e.g. "Win32", "MacIntel").
        accept_language: Accept-Language header value.
    """
    params = {"userAgent": user_agent}
    if platform is not None:
        params["platform"] = platform
    if accept_language is not None:
        params["acceptLanguage"] = accept_language
    await connection.send(
        "Emulation.setUserAgentOverride", params, session_id=session_id
    )


async def set_viewport(
    session_id: str,
    connection: CDPConnection,
    width: int,
    height: int,
    *,
    device_scale_factor: float = 1.0,
    mobile: bool = False,
):
    """Set the device viewport metrics via Emulation domain.

    Args:
        session_id: CDP session ID for the target.
        connection: Active CDPConnection instance.
        width: Viewport width in pixels.
        height: Viewport height in pixels.
        device_scale_factor: Device scale factor (default 1.0).
        mobile: Whether to emulate a mobile device.
    """
    await connection.send("Emulation.setDeviceMetricsOverride", {
        "width": width,
        "height": height,
        "deviceScaleFactor": device_scale_factor,
        "mobile": mobile,
    }, session_id=session_id)
