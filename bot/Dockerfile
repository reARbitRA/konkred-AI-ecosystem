# Konkred Telegram bot — Aiogram 3 long-polling worker.
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HEARTBEAT_PATH=/tmp/konkred-bot-heartbeat

WORKDIR /app

# Install dependencies first for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Non-root runtime user; heartbeat lives in /tmp which stays writable.
RUN useradd --create-home --uid 10001 konkred \
    && mkdir -p /tmp \
    && chown -R konkred:konkred /app
USER konkred

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["python", "healthcheck.py"]

CMD ["python", "main.py"]
