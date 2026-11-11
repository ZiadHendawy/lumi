# syntax=docker/dockerfile:1
# Trimmed from livekit-examples/agent-starter-python.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# Unbuffered logs so a crash still shows its output; precompiled bytecode for a faster cold start.
ENV PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 HF_HOME=/app/.cache/huggingface

RUN adduser --disabled-password --gecos "" --home /app --uid 10001 appuser
WORKDIR /app

# Dependencies first so code-only changes reuse this cached layer.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --locked --no-dev

COPY . .
# Bake model weights (VAD, turn detector) into the image instead of downloading on each cold start.
RUN .venv/bin/python -m livekit.agents download-files && chown -R appuser:appuser /app

USER appuser
# Call the venv directly: `uv run` would re-check the environment on every cold start.
CMD [".venv/bin/python", "agent.py", "start"]
