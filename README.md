# toolcall-middleware

Proxy kecil yang nambahin **tool calling** ke API OpenAI-compatible yang ga support natively.

Cocok buat YepAPI, Ollama, LM Studio, atau endpoint `/v1/chat/completions` manapun.

## Cara kerja

```
App / Agent kamu
       ↓
toolcall-middleware (:1435)
       ↓
  ada tools di request?
  ├─ TIDAK → passthrough langsung (zero overhead)
  └─ IYA  → kirim ke upstream
       ├─ upstream return tool_calls? → forward apa adanya
       └─ ga ada tool_calls? → retry pake emulasi:
            1. inject definisi tools ke system prompt
            2. model output <tool_call> XML blocks
            3. proxy parse dan convert ke format OpenAI tool_calls
```

**Smart fallback** — kalau upstream lo udah support tool calling, proxy cuma passthrough. Emulasi cuma aktif kalau dibutuhin.

## Quick start

```bash
curl -fsSL https://bun.sh/install | bash

git clone https://github.com/zhaees/toolcall-middleware.git
cd toolcall-middleware

cp .env.example .env
# edit .env — isi UPSTREAM_URL dan UPSTREAM_KEY lo

bun run proxy.ts
```

## Environment variables

| Variable | Default | Keterangan |
|---|---|---|
| `UPSTREAM_URL` | `http://127.0.0.1:8080/v1` | Endpoint API lo |
| `UPSTREAM_KEY` | _(kosong)_ | API key upstream (dikirim sebagai `Bearer` token) |
| `PORT` | `1435` | Port proxy |
| `HOST` | `127.0.0.1` | Bind address |

## Pake di OpenCode

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

## Pake di Hermes

```yaml
# ~/.hermes/config.yaml
model:
  default: my-model
  provider: custom
  base_url: http://localhost:1435/v1
```

## Test pake curl

```bash
curl -X POST http://127.0.0.1:1435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any-model",
    "messages": [{"role":"user","content":"Baca file /etc/hostname"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Baca file dari disk",
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

Response bakal ada `tool_calls` yang proper:

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

## Jalanin di background

```bash
nohup bun run proxy.ts > /tmp/toolcall-proxy.log 2>&1 &

# auto-start pas buka terminal
echo 'cd ~/toolcall-middleware && bun run proxy.ts &' >> ~/.bashrc
```

## Tested

- [YepAPI](https://yepapi.com)
- [OpenCode](https://opencode.ai)
- [Hermes](https://github.com/hermes-ai)

## License

MIT
