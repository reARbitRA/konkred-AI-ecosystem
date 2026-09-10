Here is the step-by-step guide to setting up, configuring, and running the entire ecosystem from scratch on any server (Ubuntu/Debian, VPS, or local Linux machine).

---

### Step 0: Install Docker and Docker Compose

On your server terminal, run:

```bash
# 1. Update system packages
sudo apt update && sudo apt upgrade -y

# 2. Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 3. Enable Docker and install Docker Compose plugin
sudo systemctl enable --now docker
sudo apt install -y docker-compose-plugin

# 4. Verify installation
docker --version
docker compose version
```

---

### Step 1: Create the Folder Structure

Run this single command to create the exact folder hierarchy:

```bash
mkdir -p konkred-production/gateway/src/gateway \
         konkred-production/gateway/src/providers \
         konkred-production/gateway/data \
         konkred-production/bot
```

Switch into the project root:

```bash
cd konkred-production
```

Verify your tree structure:

```bash
find . -type d
```

Output should look like:
```text
.
./gateway
./gateway/data
./gateway/src
./gateway/src/gateway
./gateway/src/providers
./bot
```

---

### Step 2: Create Gateway & Build Files

#### 1. Root Orchestration File: `docker-compose.yml`
```bash
cat << 'EOF' > docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    container_name: konkred-redis
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--save", "60", "1"]
    volumes:
      - redis-data:/data
    networks:
      - internal-net
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  gateway:
    build:
      context: ./gateway
      dockerfile: Dockerfile
    container_name: konkred-gateway
    restart: unless-stopped
    env_file: .env
    environment:
      - PORT=3000
      - HOST=0.0.0.0
      - DEMO_MOCK=false
    ports:
      - "3000:3000"
    networks:
      - internal-net
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 3

  bot:
    build:
      context: ./bot
      dockerfile: Dockerfile
    container_name: konkred-bot
    restart: unless-stopped
    env_file: .env
    environment:
      - GATEWAY_URL=http://gateway:3000/api/ai
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      redis:
        condition: service_healthy
      gateway:
        condition: service_healthy
    networks:
      - internal-net

volumes:
  redis-data:

networks:
  internal-net:
    driver: bridge
EOF
```

#### 2. Gateway Package Config: `gateway/package.json`
```bash
cat << 'EOF' > gateway/package.json
{
  "name": "konkred-gateway",
  "version": "2.0.0",
  "type": "module",
  "main": "src/server.mjs",
  "scripts": {
    "start": "node src/server.mjs"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
EOF
```

#### 3. Gateway Dockerfile: `gateway/Dockerfile`
```bash
cat << 'EOF' > gateway/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY data/ ./data/
EXPOSE 3000
CMD ["node", "src/server.mjs"]
EOF
```

#### 4. Model Registry Database: `gateway/data/policies.registry.json`
```bash
cat << 'EOF' > gateway/data/policies.registry.json
{
  "registryBuiltAt": "2026-09-01T00:00:00Z",
  "providers": {
    "gemini": {
      "name": "Google Generative Language",
      "resetPolicy": "pt-midnight",
      "trainsOnData": true,
      "probe": { "kind": "gemini-generate" }
    },
    "groq": {
      "name": "Groq Cloud",
      "resetPolicy": "utc-midnight",
      "trainsOnData": false,
      "learnFromHeaders": {
        "rpm": "x-ratelimit-limit-requests",
        "tpm": "x-ratelimit-limit-tokens"
      },
      "probe": { "kind": "openai-chat" }
    },
    "cerebras": {
      "name": "Cerebras Inference",
      "resetPolicy": "utc-midnight",
      "trainsOnData": false,
      "learnFromHeaders": {
        "rpm": "x-ratelimit-limit-requests-minute",
        "tpm": "x-ratelimit-limit-tokens-minute"
      },
      "probe": { "kind": "openai-chat" }
    },
    "mistral": {
      "name": "Mistral La Plateforme",
      "resetPolicy": "utc-midnight",
      "trainsOnData": true,
      "probe": { "kind": "openai-chat" }
    },
    "openrouter": {
      "name": "OpenRouter",
      "resetPolicy": "utc-midnight",
      "trainsOnData": false,
      "probe": { "kind": "openrouter-keyinfo" }
    },
    "cloudflare": {
      "name": "Cloudflare Workers AI",
      "resetPolicy": "utc-midnight",
      "trainsOnData": false,
      "probe": { "kind": "none" }
    },
    "github": {
      "name": "GitHub Models",
      "resetPolicy": "utc-midnight",
      "trainsOnData": false,
      "probe": { "kind": "openai-chat" }
    },
    "mock": {
      "name": "Offline Simulator",
      "resetPolicy": "utc-midnight",
      "trainsOnData": false,
      "learnFromHeaders": {
        "rpm": "x-ratelimit-limit-requests",
        "tpm": "x-ratelimit-limit-tokens"
      },
      "probe": { "kind": "mock" }
    }
  },
  "models": [
    { "id": "gemini:flash", "providerId": "gemini", "modelName": "gemini-2.5-flash", "rpm": 15, "rpd": 1500, "tpm": 1000000, "tpd": null, "monthlyTokens": null, "contextWindow": 1048576, "quality": 4, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "gemini:flash-lite", "providerId": "gemini", "modelName": "gemini-2.5-flash-lite", "rpm": 30, "rpd": 1500, "tpm": 1000000, "tpd": null, "monthlyTokens": null, "contextWindow": 1048576, "quality": 3, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "groq:gpt-oss-120b", "providerId": "groq", "modelName": "openai/gpt-oss-120b", "rpm": 30, "rpd": 1000, "tpm": 8000, "tpd": 200000, "monthlyTokens": null, "contextWindow": 131072, "quality": 4, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "groq:llama-70b", "providerId": "groq", "modelName": "llama-3.3-70b-versatile", "rpm": 30, "rpd": 1000, "tpm": 12000, "tpd": 100000, "monthlyTokens": null, "contextWindow": 131072, "quality": 4, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "groq:llama-8b", "providerId": "groq", "modelName": "llama-3.1-8b-instant", "rpm": 30, "rpd": 14400, "tpm": 6000, "tpd": 500000, "monthlyTokens": null, "contextWindow": 131072, "quality": 2, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "groq:qwen3-32b", "providerId": "groq", "modelName": "qwen/qwen3-32b", "rpm": 60, "rpd": 1000, "tpm": 6000, "tpd": 500000, "monthlyTokens": null, "contextWindow": 131072, "quality": 3, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "groq:kimi-k2", "providerId": "groq", "modelName": "moonshotai/kimi-k2-instruct", "rpm": 60, "rpd": 1000, "tpm": 10000, "tpd": 300000, "monthlyTokens": null, "contextWindow": 131072, "quality": 4, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "groq:llama-4-scout", "providerId": "groq", "modelName": "meta-llama/llama-4-scout-17b-16e-instruct", "rpm": 30, "rpd": 1000, "tpm": 30000, "tpd": 500000, "monthlyTokens": null, "contextWindow": 131072, "quality": 3, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "cerebras:gpt-oss-120b", "providerId": "cerebras", "modelName": "gpt-oss-120b", "rpm": 30, "rpd": 10000, "tpm": 60000, "tpd": 1000000, "monthlyTokens": null, "contextWindow": 8192, "quality": 4, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "cerebras:llama-8b", "providerId": "cerebras", "modelName": "llama3.1-8b", "rpm": 30, "rpd": 10000, "tpm": 60000, "tpd": 1000000, "monthlyTokens": null, "contextWindow": 8192, "quality": 2, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "cerebras:qwen3-235b", "providerId": "cerebras", "modelName": "qwen-3-235b-a22b-instruct-2507", "rpm": 10, "rpd": 100, "tpm": 20000, "tpd": 500000, "monthlyTokens": null, "contextWindow": 65536, "quality": 5, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "mistral:small", "providerId": "mistral", "modelName": "mistral-small-latest", "rpm": 60, "rpd": null, "tpm": 50000, "tpd": null, "monthlyTokens": 4000000, "contextWindow": 128000, "quality": 3, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "mistral:codestral", "providerId": "mistral", "modelName": "codestral-latest", "rpm": 60, "rpd": null, "tpm": 40000, "tpd": null, "monthlyTokens": 2000000, "contextWindow": 256000, "quality": 4, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "openrouter:free-auto", "providerId": "openrouter", "modelName": "openrouter/auto", "rpm": 20, "rpd": 50, "tpm": null, "tpd": null, "monthlyTokens": null, "contextWindow": 32768, "quality": 3, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "cloudflare:llama-8b", "providerId": "cloudflare", "modelName": "@cf/meta/llama-3.1-8b-instruct", "rpm": 300, "rpd": 400, "tpm": 100000, "tpd": null, "monthlyTokens": null, "contextWindow": 8192, "quality": 2, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "github:gpt-4o", "providerId": "github", "modelName": "gpt-4o", "rpm": 10, "rpd": 50, "tpm": 8000, "tpd": null, "monthlyTokens": null, "contextWindow": 128000, "quality": 5, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "github:gpt-4o-mini", "providerId": "github", "modelName": "gpt-4o-mini", "rpm": 15, "rpd": 150, "tpm": 10000, "tpd": null, "monthlyTokens": null, "contextWindow": 128000, "quality": 3, "lastVerifiedAt": "2026-09-01", "confidence": "high" },
    { "id": "mock:atlas-70b", "providerId": "mock", "modelName": "atlas-70b-mock", "rpm": 100, "rpd": 10000, "tpm": 500000, "tpd": 5000000, "monthlyTokens": null, "contextWindow": 131072, "quality": 4, "lastVerifiedAt": "2026-09-01", "confidence": "n/a" },
    { "id": "mock:sparrow-8b", "providerId": "mock", "modelName": "sparrow-8b-mock", "rpm": 100, "rpd": 10000, "tpm": 500000, "tpd": 5000000, "monthlyTokens": null, "contextWindow": 131072, "quality": 2, "lastVerifiedAt": "2026-09-01", "confidence": "n/a" }
  ]
}
EOF
```

---

### Step 3: Populate Gateway Source Files (`gateway/src/`)

Copy the 20 files from your `SRC-CODEBOOK.md` into `gateway/src/` according to this exact map:

| Destination Path | Source File in Codebook |
|---|---|
| `gateway/src/config.mjs` | `src/config.mjs` |
| `gateway/src/policy-store.mjs` | `src/policy-store.mjs` |
| `gateway/src/util.mjs` | `src/util.mjs` |
| `gateway/src/watchdog.mjs` | `src/watchdog.mjs` |
| `gateway/src/dashboard.mjs` | `src/dashboard.mjs` |
| `gateway/src/server.mjs` | `src/server.mjs` |
| `gateway/src/providers/base.mjs` | `src/providers/base.mjs` |
| `gateway/src/providers/cloudflare.mjs` | `src/providers/cloudflare.mjs` |
| `gateway/src/providers/gemini.mjs` | `src/providers/gemini.mjs` |
| `gateway/src/providers/index.mjs` | `src/providers/index.mjs` |
| `gateway/src/providers/mock.mjs` | `src/providers/mock.mjs` |
| `gateway/src/providers/openai-compat.mjs` | `src/providers/openai-compat.mjs` |
| `gateway/src/gateway/cache.mjs` | `src/gateway/cache.mjs` |
| `gateway/src/gateway/dedup.mjs` | `src/gateway/dedup.mjs` |
| `gateway/src/gateway/fallback.mjs` | `src/gateway/fallback.mjs` |
| `gateway/src/gateway/fusion.mjs` | `src/gateway/fusion.mjs` |
| `gateway/src/gateway/gateway.mjs` | `src/gateway/gateway.mjs` |
| `gateway/src/gateway/key-pool.mjs` | `src/gateway/key-pool.mjs` |
| `gateway/src/gateway/router.mjs` | `src/gateway/router.mjs` |
| `gateway/src/gateway/user-limiter.mjs` | `src/gateway/user-limiter.mjs` |

---

### Step 4: Create the Bot Microservice Files (`bot/`)

#### 1. `bot/requirements.txt`
```bash
cat << 'EOF' > bot/requirements.txt
aiogram==3.15.0
httpx==0.28.1
redis==5.2.1
EOF
```

#### 2. `bot/Dockerfile`
```bash
cat << 'EOF' > bot/Dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PYTHONUNBUFFERED=1
CMD ["python", "main.py"]
EOF
```

#### 3. `bot/config.py`
```bash
cat << 'EOF' > bot/config.py
import os
import sys

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
GATEWAY_URL = os.getenv("GATEWAY_URL", "http://gateway:3000/api/ai").strip()
GATEWAY_API_KEY = os.getenv("GATEWAY_API_KEY", "bot-internal-key").strip()
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0").strip()

if not TELEGRAM_BOT_TOKEN:
    sys.exit("[FATAL] TELEGRAM_BOT_TOKEN is not configured in environment.")
EOF
```

#### 4. `bot/gateway_client.py`
```bash
cat << 'EOF' > bot/gateway_client.py
import httpx
from typing import List, Dict, Any, Optional
from config import GATEWAY_URL, GATEWAY_API_KEY

class GatewayError(Exception):
    def __init__(self, status_code: int, code: str, message: str, retry_after: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retry_after = retry_after

class GatewayClient:
    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(120.0, connect=10.0),
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=50)
            )
        return self._client

    async def ask(
        self,
        task_type: str,
        messages: List[Dict[str, str]],
        max_tokens: int = 2048,
        temperature: float = 0.3,
        preferred_model: Optional[str] = None
    ) -> Dict[str, Any]:
        client = self._get_client()
        payload = {
            "taskType": task_type,
            "messages": messages,
            "maxTokens": max_tokens,
            "temperature": temperature,
            "privacy": "any",
            "skipCache": False
        }
        if preferred_model:
            payload["model"] = preferred_model

        headers = {
            "Content-Type": "application/json",
            "x-api-key": GATEWAY_API_KEY
        }

        try:
            response = await client.post(GATEWAY_URL, json=payload, headers=headers)
        except httpx.RequestError as exc:
            raise GatewayError(503, "GATEWAY_UNREACHABLE", f"Gateway network error: {str(exc)}")

        if response.status_code == 200:
            data = response.json()
            return data["data"]

        retry_after = None
        if "retry-after" in response.headers:
            try:
                retry_after = int(response.headers["retry-after"])
            except ValueError:
                pass

        try:
            err_json = response.json().get("error", {})
            code = err_json.get("code", f"HTTP_{response.status_code}")
            msg = err_json.get("message", response.text)
        except Exception:
            code = f"HTTP_{response.status_code}"
            msg = response.text

        raise GatewayError(response.status_code, code, msg, retry_after)

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

gateway_client = GatewayClient()
EOF
```

#### 5. `bot/history.py`
```bash
cat << 'EOF' > bot/history.py
import json
from typing import List, Dict
from redis.asyncio import Redis

MAX_HISTORY_TURNS = 10
TTL_SECONDS = 86400

class HistoryManager:
    def __init__(self, redis_conn: Redis):
        self.redis = redis_conn

    def _key(self, user_id: int) -> str:
        return f"konkred:history:{user_id}"

    async def get_history(self, user_id: int) -> List[Dict[str, str]]:
        raw = await self.redis.get(self._key(user_id))
        if not raw:
            return []
        try:
            return json.loads(raw)
        except Exception:
            return []

    async def append_interaction(self, user_id: int, user_content: str, assistant_content: str):
        history = await self.get_history(user_id)
        history.append({"role": "user", "content": user_content})
        history.append({"role": "assistant", "content": assistant_content})

        truncated = history[-(MAX_HISTORY_TURNS * 2):]
        key = self._key(user_id)
        await self.redis.set(key, json.dumps(truncated), ex=TTL_SECONDS)

    async def clear_history(self, user_id: int):
        await self.redis.delete(self._key(user_id))
EOF
```

#### 6. `bot/keyboards.py`
```bash
cat << 'EOF' > bot/keyboards.py
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton

def get_task_keyboard(current_task: str) -> InlineKeyboardMarkup:
    tasks = [
        ("General", "general"),
        ("Code Gen", "code-generation"),
        ("Bug Fixing", "bug-fixing"),
        ("Architecture", "architecture"),
        ("Summarize", "summarization"),
        ("Translate", "translate")
    ]
    buttons = []
    row = []
    for label, task in tasks:
        prefix = "✅ " if task == current_task else ""
        row.append(InlineKeyboardButton(text=f"{prefix}{label}", callback_data=f"set_task:{task}"))
        if len(row) == 2:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)

    buttons.append([InlineKeyboardButton(text="🗑 Clear Context", callback_data="clear_context")])
    return InlineKeyboardMarkup(inline_keyboard=buttons)
EOF
```

#### 7. `bot/handlers.py`
```bash
cat << 'EOF' > bot/handlers.py
import asyncio
from typing import List
from aiogram import Router, F, types
from aiogram.filters import CommandStart, Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.utils.chat_action import ChatActionSender

from gateway_client import gateway_client, GatewayError
from history import HistoryManager
from keyboards import get_task_keyboard

router = Router()

class UserSession(StatesGroup):
    task = State()

def split_telegram_message(text: str, max_length: int = 4000) -> List[str]:
    if len(text) <= max_length:
        return [text]

    chunks = []
    while text:
        if len(text) <= max_length:
            chunks.append(text)
            break

        split_index = text.rfind("\n\n", 0, max_length)
        if split_index == -1:
            split_index = text.rfind("\n", 0, max_length)
        if split_index == -1:
            split_index = text.rfind(" ", 0, max_length)
        if split_index == -1:
            split_index = max_length

        chunks.append(text[:split_index].strip())
        text = text[split_index:].strip()

    return chunks

@router.message(CommandStart())
async def handle_start(message: types.Message, state: FSMContext):
    await state.set_state(UserSession.task)
    await state.update_data(task="general")
    await message.answer(
        "⚡ **Konkred AI Gateway Connected**\n\n"
        "Stateful interaction with automatic multi-provider rate limit failover.\n\n"
        "Select an operational routing task:",
        reply_markup=get_task_keyboard("general"),
        parse_mode="Markdown"
    )

@router.callback_query(F.data.startswith("set_task:"))
async def handle_task_selection(callback: types.CallbackQuery, state: FSMContext):
    selected_task = callback.data.split(":")[1]
    await state.update_data(task=selected_task)
    await callback.message.edit_reply_markup(reply_markup=get_task_keyboard(selected_task))
    await callback.answer(f"Task set to: {selected_task}")

@router.callback_query(F.data == "clear_context")
async def handle_clear_context(callback: types.CallbackQuery, history_mgr: HistoryManager):
    await history_mgr.clear_history(callback.from_user.id)
    await callback.answer("Context cleared.")
    await callback.message.answer("🧹 Conversation context purged.")

@router.message(Command("clear"))
async def handle_clear_command(message: types.Message, history_mgr: HistoryManager):
    await history_mgr.clear_history(message.from_user.id)
    await message.answer("🧹 Conversation context purged.")

@router.message(F.text)
async def handle_chat_message(message: types.Message, state: FSMContext, history_mgr: HistoryManager):
    data = await state.get_data()
    active_task = data.get("task", "general")
    user_id = message.from_user.id

    prior_history = await history_mgr.get_history(user_id)
    messages_payload = prior_history + [{"role": "user", "content": message.text}]

    async with ChatActionSender.typing(bot=message.bot, chat_id=message.chat.id):
        try:
            result = await gateway_client.ask(
                task_type=active_task,
                messages=messages_payload,
                max_tokens=2500,
                temperature=0.3
            )
            content = result["content"]

            await history_mgr.append_interaction(user_id, message.text, content)

            provider = result.get("provider", "unknown")
            model = result.get("model", "unknown")
            cached = " (cache-hit)" if result.get("cached") else ""
            footer = f"\n\n—\n⚙️ `{provider}` / `{model}`{cached}"

            full_reply = content + footer
            chunks = split_telegram_message(full_reply)

            for chunk in chunks:
                await message.answer(chunk, parse_mode="Markdown")
                await asyncio.sleep(0.05)

        except GatewayError as e:
            if e.status_code == 429:
                wait_sec = e.retry_after or 60
                await message.answer(f"⏳ **Rate Limited:** Upstream capacity reached. Retry in {wait_sec}s.")
            elif e.status_code == 503:
                await message.answer("⚠️ **Capacity Saturated:** All available pool slots cooling down. Retry shortly.")
            else:
                await message.answer(f"⛔ **Gateway Error [{e.code}]:** {e.message}")
        except Exception as ex:
            await message.answer(f"❌ **System Error:** {str(ex)}")
EOF
```

#### 8. `bot/main.py`
```bash
cat << 'EOF' > bot/main.py
import asyncio
import logging
from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.redis import RedisStorage
from redis.asyncio import Redis

from config import TELEGRAM_BOT_TOKEN, REDIS_URL
from handlers import router
from history import HistoryManager
from gateway_client import gateway_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s - [%(levelname)s] - %(name)s - %(message)s")
logger = logging.getLogger("konkred-bot")

async def main():
    logger.info("Initializing Redis connection...")
    redis = Redis.from_url(REDIS_URL, decode_responses=True)
    storage = RedisStorage(redis=redis)
    history_mgr = HistoryManager(redis_conn=redis)

    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    dp = Dispatcher(storage=storage)

    dp["history_mgr"] = history_mgr
    dp.include_router(router)

    try:
        logger.info("Purging webhooks and starting polling...")
        await bot.delete_webhook(drop_pending_updates=True)
        await dp.start_polling(bot)
    finally:
        logger.info("Graceful shutdown initiated...")
        await gateway_client.close()
        await redis.aclose()
        await bot.session.close()

if __name__ == "__main__":
    asyncio.run(main())
EOF
```

---

### Step 5: Acquire API Keys & Setup `.env`

You need at least **one** Telegram bot token and **one** free AI API key:

1. **Telegram Token**: Open Telegram, message `@BotFather`, send `/newbot`, follow prompts, and copy the HTTP API token.
2. **Groq (Free & Fast)**: Go to [console.groq.com](https://console.groq.com), log in, navigate to **API Keys**, and generate a key.
3. **Cerebras (1M Tokens/Day Free)**: Go to [cloud.cerebras.ai](https://cloud.cerebras.ai), log in, create a key.
4. **Google Gemini (Free Tier)**: Go to [aistudio.google.com](https://aistudio.google.com), click **Get API key**, create a key.

Create your `.env` file in the root directory:

```bash
cat << 'EOF' > .env
# Required: Insert your actual bot token from @BotFather
TELEGRAM_BOT_TOKEN=your_token_from_botfather

# Gateway internal auth
ADMIN_KEY=dev-admin-key-change-in-production
USERS_JSON=[{"key":"bot-internal-key","userId":"telegram-bot","tier":"internal"}]
GATEWAY_API_KEY=bot-internal-key

# Providers: Add any keys you have (leave empty if not available)
GEMINI_KEY_P1=
GEMINI_KEY_P2=
GEMINI_KEY_P3=
GROQ_API_KEY=your_groq_api_key
CEREBRAS_API_KEY=your_cerebras_api_key
MISTRAL_API_KEY=
OPENROUTER_API_KEY=
CF_ACCOUNT_ID=
CF_API_TOKEN=
GITHUB_TOKEN=
EOF
```

Edit `.env` using nano to paste your real keys:
```bash
nano .env
```
*(Press `Ctrl+O` then `Enter` to save, and `Ctrl+X` to exit)*.

---

### Step 6: Build and Launch Containers

Run:

```bash
docker compose up --build -d
```

This commands executes:
1. Starts `redis` and runs healthcheck verification.
2. Builds the Node.js `gateway` container, boots the HTTP server on port `3000`, loads all quota policies, and runs healthcheck verification.
3. Builds the Python `bot` container, hooks up to Redis and the Gateway, registers all Aiogram routes, and starts long-polling Telegram.

---

### Step 7: Verify Everything Works

Check that all three containers are healthy:
```bash
docker compose ps
```
The output should show:
```text
NAME              IMAGE                     COMMAND                  SERVICE   STATUS                    PORTS
konkred-bot       konkred-production-bot    "python main.py"         bot       Up                        
konkred-gateway   konkred-production-gateway "docker-entrypoint.s…" gateway   Up (healthy)              0.0.0.0:3000->3000/tcp
konkred-redis     redis:7-alpine            "docker-entrypoint.s…"   redis     Up (healthy)              6379/tcp
```

View live logs:
```bash
# Check Gateway logs:
docker compose logs -f gateway

# Check Bot logs:
docker compose logs -f bot
```

Open Telegram, find your bot, and send:
```text
/start
```
Select a task (e.g. `Code Gen`), send a prompt, and the bot will reply with model and provider metadata appended at the bottom.

---

### Daily Operations Reference

- **Stop everything**: `docker compose down`
- **Restart everything**: `docker compose restart`
- **Rebuild after code edits**: `docker compose up --build -d`
- **Check health API**: `curl http://localhost:3000/api/health`