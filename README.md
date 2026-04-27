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

---

## Install Bun

Proxy ini pake [Bun](https://bun.sh) runtime. Install dulu sesuai OS:

**Linux / macOS / WSL:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows (PowerShell):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

**Windows (npm):**
```
npm install -g bun
```

**Windows (Scoop):**
```
scoop install bun
```

> Kalau di Windows dapet error `unzip is required`, pake cara PowerShell atau npm di atas.

---

## Quick start

### 1. Clone repo

```bash
git clone https://github.com/zhaees/toolcall-middleware.git
cd toolcall-middleware
```

### 2. Setup config

```bash
cp .env.example .env
```

Edit file `.env`:

```env
UPSTREAM_URL=http://127.0.0.1:8080/v1
UPSTREAM_KEY=api-key-lo-disini
PORT=1435
```

- `UPSTREAM_URL` → endpoint API yang mau lo tambahin tool calling
- `UPSTREAM_KEY` → API key buat endpoint itu (kosong kalau ga perlu)
- `PORT` → port proxy (default 1435)

### 3. Jalanin

```bash
bun run proxy.ts
```

Kalau berhasil bakal muncul:

```
  toolcall-middleware v1.0.0
  → http://127.0.0.1:1435
  → upstream: http://127.0.0.1:8080/v1
  → mode: native-first, fallback emulation
```

### 4. Test

```bash
curl http://127.0.0.1:1435/health
```

Harusnya return `{"status":"ok"}`.

---

## Environment variables

| Variable | Default | Keterangan |
|---|---|---|
| `UPSTREAM_URL` | `http://127.0.0.1:8080/v1` | Endpoint API lo |
| `UPSTREAM_KEY` | _(kosong)_ | API key upstream (dikirim sebagai `Bearer` token) |
| `PORT` | `1435` | Port proxy |
| `HOST` | `127.0.0.1` | Bind address |

---

## Contoh integrasi

### OpenCode

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

### Hermes

```yaml
# ~/.hermes/config.yaml
model:
  default: my-model
  provider: custom
  base_url: http://localhost:1435/v1
```

### Agentic app lain

Tinggal arahin `base_url` ke `http://127.0.0.1:1435/v1` — format request/response sama persis kayak OpenAI API.

---

## Test tool calling pake curl

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

---

## Jalanin di background

**Linux / macOS / WSL:**
```bash
nohup bun run proxy.ts > /tmp/toolcall-proxy.log 2>&1 &
```

**Auto-start pas buka terminal:**
```bash
echo 'cd ~/toolcall-middleware && bun run proxy.ts &' >> ~/.bashrc
```

**Windows (PowerShell):**
```powershell
Start-Process -NoNewWindow bun -ArgumentList "run","proxy.ts" -WorkingDirectory "$HOME\toolcall-middleware"
```

---

## Tested

- [YepAPI](https://yepapi.com)
- [OpenCode](https://opencode.ai)
- [Hermes](https://github.com/hermes-ai)

## License

MIT
