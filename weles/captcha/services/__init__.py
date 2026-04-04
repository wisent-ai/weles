"""Captcha solving service backends."""

from .base import CaptchaService
from .twocaptcha import TwoCaptchaService, AntiCaptchaService, CapMonsterService, NextCaptchaService
from .capsolver import CapsolverService, NopeCHAService, NoCaptchaAIService

__all__ = [
    "CaptchaService",
    "TwoCaptchaService",
    "AntiCaptchaService",
    "CapMonsterService",
    "NextCaptchaService",
    "CapsolverService",
    "NopeCHAService",
    "NoCaptchaAIService",
]
