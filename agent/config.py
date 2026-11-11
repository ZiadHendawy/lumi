"""Every provider and tunable lives here, so swapping a vendor is a one-line change."""

import os

from livekit.agents import llm
from livekit.plugins import deepgram, groq, openai

AGENT_NAME = "lumi"  # must match the agentName the web app dispatches

# Public demo URL on free tiers: cap how long one visitor can hold a session.
MAX_SESSION_SECONDS = 10 * 60
IDLE_TIMEOUT_SECONDS = 3 * 60

# Checked 2026-11-11: llama-3.3-70b is no longer offered. gpt-oss-120b made correct tool
# calls in testing; qwen/qwen3.8-27b was ~0.2 s faster and is the first thing to try for latency.
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
# Flash-Lite, not Flash: on the free tier Flash allows ~20 requests/day, Flash-Lite ~500.
# The "-latest" alias follows Google's current Flash-Lite, so a model retirement can't break us.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
TTS_VOICE = os.getenv("TTS_VOICE", "aura-2-andromeda-en")


def build_stt() -> deepgram.STT:
    return deepgram.STT(model="nova-3", language="en-US")


def build_llm() -> llm.LLM:
    # Temperature 0 keeps evals stable; the persona comes from the prompt, not randomness.
    # FallbackAdapter moves to Gemini when Groq errors or rate-limits (free-tier risk).
    # Gemini speaks the OpenAI API, so the OpenAI plugin covers it with no extra package.
    return llm.FallbackAdapter(
        [
            # gpt-oss "thinks" before answering; low effort keeps that to a few tokens,
            # which matters for latency and the 8K tokens/min free-tier cap.
            groq.LLM(model=GROQ_MODEL, temperature=0, reasoning_effort="low"),
            openai.LLM(
                model=GEMINI_MODEL,
                base_url=GEMINI_BASE_URL,
                api_key=os.getenv("GEMINI_API_KEY"),
                temperature=0,
            ),
        ]
    )


def build_tts() -> deepgram.TTS:
    return deepgram.TTS(model=TTS_VOICE)
