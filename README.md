# toolcall-middleware

Drop-in proxy that adds **tool calling** (function calling) to any OpenAI-compatible API that doesn't support it natively.

Works with YepAPI, LiteLLM, Ollama, LM Studio, or any `/v1/chat/completions` endpoint.

## How it works

```
Your App / Agent
       ↓
toolcall-middleware (:1435)
       ↓
  has tools in request?
  ├─ NO  → passthrough (zero overhead)
  └─ YES → send to upstream
       ├─ upstream returned tool_calls? → forward as-is
       └─ no tool_calls? → retry with emulation:
            1. inject tool definitions into system prompt
            2. model outputs <tool_call> XML blocks
            3. proxy parses and converts to OpenAI tool_calls format
```

**Smart fallback** — if your upstream already supports tool calling (e.g. OpenAI, Anthropic), the proxy just passes through. Only kicks in when needed.

## Quick start

```bash
# install bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# clone
git clone https://github.com/YOUR_USER/toolcall-middleware.git
cd toolcall-middleware

# configure
cp .env.example .env
# edit .env with your upstream URL and API key

# run
bun run proxy.ts
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `UPSTREAM_URL` | `http://127.0.0.1:8080/v1` | Your OpenAI-compatible API endpoint |
| `UPSTREAM_KEY` | _(empty)_ | API key for upstream (sent as `Bearer` token) |
| `PORT` | `1435` | Port for the proxy |
| `HOST` | `127.0.0.1` | Bind address |

## Usage with OpenCode

```jsonc
// ~/.config/opencode/opencode.json
{
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:1435/v1"
      },
      "models": {
        "my-model": {
          "name": "My Model (with tools)",
          "limit": { "context": 200000, "output": 64000 }
        }
      }
    }
  }
}
```

## Usage with Hermes

```yaml
# ~/.hermes/config.yaml
model:
  default: my-model
  provider: custom
  base_url: http://localhost:1435/v1
```

## Usage with curl

```bash
curl -X POST http://127.0.0.1:1435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any-model",
    "messages": [{"role": "user", "content": "Read /etc/hostname"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file",
        "parameters": {
          "type": "object",
          "properties": {"path": {"type": "string"}},
          "required": ["path"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

Response will contain proper `tool_calls`:

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_1234",
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": "{\"path\":\"/etc/hostname\"}"
        }
      }]
    }
  }]
}
```

## Run as background service

```bash
# simple
nohup bun run proxy.ts > /tmp/toolcall-proxy.log 2>&1 &

# or add to ~/.bashrc for auto-start
echo 'cd ~/toolcall-middleware && bun run proxy.ts &' >> ~/.bashrc
```

## Tested with

- [YepAPI](https://yepapi.com) — no native tool calling
- [OpenCode](https://opencode.ai) — agentic coding
- [Hermes](https://github.com/hermes-ai) — AI agent
- Any OpenAI-compatible endpoint that strips `tools` from requests

## License

MIT
