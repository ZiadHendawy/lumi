"""Every provider and tunable lives here, so swapping a vendor is a one-line change."""

import os

from livekit.agents import llm
from livekit.plugins import deepgram, groq, openai

AGENT_NAME = "lumi"  # must match the agentName the web app dispatches

# Public demo URL on free tiers: cap how long one visitor can hold a session.
MAX_SESSION_SECONDS = 10 * 60
IDLE_TIMEOUT_SECONDS = 3 * 60

# How many upcoming days the prompt lists with their dates, so the model looks up
# "next Friday" instead of computing it. 0 turns the calendar off (used to measure it:
# CALENDAR_DAYS=0 uv run pytest -m eval -k due_date).
CALENDAR_DAYS = int(os.getenv("CALENDAR_DAYS", "14"))
# How many recent chat items (messages, tool calls, tool results) each LLM request
# carries. A task turn is about four items, so this is the last five to ten turns:
# enough for "undo" and "which one?" follow-ups.
MAX_HISTORY_ITEMS = 20
# Notes are cut to this many characters in the prompt: enough to tell tasks apart,
# without paying for long notes on every request.
NOTES_PREVIEW_CHARS = 60

# Open-Meteo: free, no API key. Its forecast covers today plus 15 days.
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
FORECAST_DAYS_AHEAD = 15
# The user is waiting in silence while this runs; better a quick "couldn't get it".
WEATHER_TIMEOUT_SECONDS = 3

# Checked 2026-11-11: llama-3.3-70b is no longer offered. gpt-oss-120b made correct tool
# calls in testing; qwen/qwen3.8-27b was ~0.2 s faster and is the first thing to try for latency.
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
# Groq's free caps (8K tokens/min, 200K tokens/day) are per model, so each extra Groq
# model adds a full day of capacity before we reach Gemini. Order is by correctness on
# our hardest evals (ambiguous reference + priority edit, 3 runs each, 2026-11-12):
# gpt-oss-20b passed 6/6 at ~0.3 s, qwen 2/6, so qwen only serves once both are capped.
GROQ_BACKUP_MODELS = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"]
# Flash-Lite, not Flash: on the free tier Flash allows ~20 requests/day, Flash-Lite ~500.
# The "-latest" alias follows Google's current Flash-Lite, so a model retirement can't break us.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
TTS_VOICE = os.getenv("TTS_VOICE", "aura-2-andromeda-en")


def build_stt() -> deepgram.STT:
    return deepgram.STT(model="nova-3", language="en-US")


def build_llm() -> llm.LLM:
    # Temperature 0 keeps evals stable; the persona comes from the prompt, not randomness.
    # FallbackAdapter moves down the list when a model errors or rate-limits (free-tier
    # risk). Gemini speaks the OpenAI API, so the OpenAI plugin covers it, no extra package.
    return llm.FallbackAdapter(
        [
            # gpt-oss "thinks" before answering; low effort keeps that to a few tokens,
            # which matters for latency and the 8K tokens/min free-tier cap.
            groq.LLM(model=GROQ_MODEL, temperature=0, reasoning_effort="low"),
            groq.LLM(
                model=GROQ_BACKUP_MODELS[0], temperature=0, reasoning_effort="low"
            ),
            groq.LLM(model=GROQ_BACKUP_MODELS[1], temperature=0),
            openai.LLM(
                model=GEMINI_MODEL,
                base_url=GEMINI_BASE_URL,
                api_key=os.getenv("GEMINI_API_KEY"),
                temperature=0,
                # Flash-Lite thinks by default: first token took 2-7.6 s (2026-11-12).
                # "low" usually cuts that to ~2 s, though the free tier is erratic.
                reasoning_effort="low",
            ),
        ],
        # Groq's rate-limit errors come back instantly, so this limit only matters for a
        # slow provider: Gemini's free tier took 0.8-30 s for the same prompt
        # (2026-11-12). A slow last-resort answer beats none; the default is 5 s.
        attempt_timeout=10,
    )


# Gemini rejects a turn whose tool calls lack a "thought signature" (found 2026-11-12:
# HTTP 400 "Function call is missing a thought_signature"). Gemini signs its own calls,
# but calls made by Groq have none, so falling back to Gemini in the middle of a tool
# turn would fail exactly when Groq is rate-limited. Google documents this placeholder
# for tool calls that came from another model; Groq ignores the field.
GEMINI_PLACEHOLDER_SIGNATURE = "skip_thought_signature_validator"


def sign_tool_calls_for_gemini(chat_ctx: llm.ChatContext) -> None:
    for item in chat_ctx.items:
        if item.type == "function_call" and "google" not in item.extra:
            item.extra["google"] = {"thought_signature": GEMINI_PLACEHOLDER_SIGNATURE}


def build_tts() -> deepgram.TTS:
    return deepgram.TTS(model=TTS_VOICE)
