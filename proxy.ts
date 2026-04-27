#!/usr/bin/env bun
const UPSTREAM = process.env.UPSTREAM_URL || "http://127.0.0.1:8080/v1";
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || "";
const PORT = parseInt(process.env.PORT || "1435");

function upstreamHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (UPSTREAM_KEY) h["Authorization"] = `Bearer ${UPSTREAM_KEY}`;
  return h;
}

function buildToolSystemPrompt(tools: any[]): string {
  if (!tools?.length) return "";

  const descs = tools.map((t: any) => {
    const fn = t.function || t;
    const params = fn.parameters ? JSON.stringify(fn.parameters, null, 2) : "{}";
    return `### ${fn.name}\n${fn.description || ""}\nParameters:\n\`\`\`json\n${params}\n\`\`\``;
  }).join("\n\n");

  return `\n\n# Available Tools

When you need to use a tool, output EXACTLY this format:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

Rules:
- Use EXACT <tool_call> XML tags
- Valid JSON with "name" and "arguments" fields
- Multiple calls = multiple <tool_call> blocks
- No markdown code blocks around tool calls
- When calling tools, output ONLY tool_call blocks

## Tools

${descs}
`;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function parseToolCalls(text: string): { toolCalls: ToolCall[]; textContent: string } | null {
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const calls: ToolCall[] = [];
  let m, i = 0;

  while ((m = re.exec(text)) !== null) {
    try {
      const raw = m[1].trim().replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
      const p = JSON.parse(raw);
      calls.push({
        id: `call_${Date.now()}_${i++}`,
        type: "function",
        function: {
          name: p.name,
          arguments: typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments),
        },
      });
    } catch {
      console.error("[toolcall-proxy] bad tool_call JSON:", m[1]);
    }
  }

  if (!calls.length) return null;
  return { toolCalls: calls, textContent: text.replace(re, "").trim() };
}

function sseFromToolCalls(response: any): Response {
  const msg = response.choices[0].message;
  const { id, model, created } = response;
  const chunks: string[] = [];

  chunks.push(JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
  }));

  for (let i = 0; i < msg.tool_calls.length; i++) {
    const tc = msg.tool_calls[i];
    chunks.push(JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }, finish_reason: null }],
    }));
    const args = tc.function.arguments;
    for (let j = 0; j < args.length; j += 100) {
      chunks.push(JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(j, j + 100) } }] }, finish_reason: null }],
      }));
    }
  }

  chunks.push(JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: response.usage,
  }));

  return new Response(
    chunks.map(c => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
  );
}

function sseFromText(response: any): Response {
  const { id, model, created } = response;
  const content = response.choices[0].message.content || "";
  const chunks: string[] = [];

  chunks.push(JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  }));
  for (let i = 0; i < content.length; i += 50) {
    chunks.push(JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: content.slice(i, i + 50) }, finish_reason: null }],
    }));
  }
  chunks.push(JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: response.usage,
  }));

  return new Response(
    chunks.map(c => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
  );
}

async function handleChat(req: Request): Promise<Response> {
  const body = await req.json();
  const hasTools = body.tools?.length > 0;
  const wantStream = body.stream === true;

  if (!hasTools) {
    return fetch(`${UPSTREAM}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify(body),
    });
  }

  // ── Try native first ──
  const nativeRes = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify({ ...body, stream: false }),
  });

  if (!nativeRes.ok) return nativeRes;

  const result = await nativeRes.json() as any;
  const msg = result.choices?.[0]?.message;

  if (msg?.tool_calls?.length) {
    console.log(`[✓] ${body.model} → native tool_calls`);
    if (wantStream) return sseFromToolCalls(result);
    return Response.json(result);
  }

  // ── Native didn't return tool_calls → emulate ──
  console.log(`[~] ${body.model} → emulating tool calls...`);

  const toolPrompt = buildToolSystemPrompt(body.tools);
  const messages = [...(body.messages || [])];

  const sysIdx = messages.findIndex((m: any) => m.role === "system");
  if (sysIdx >= 0) {
    messages[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + toolPrompt };
  } else {
    messages.unshift({ role: "system", content: toolPrompt.trim() });
  }

  if (body.tool_choice === "required") {
    messages.push({ role: "user", content: "[SYSTEM: You MUST use at least one tool. Output <tool_call> blocks only.]" });
  } else if (body.tool_choice?.function) {
    messages.push({ role: "user", content: `[SYSTEM: You MUST call the "${body.tool_choice.function.name}" tool now.]` });
  }

  const emulatedBody = { ...body, messages, stream: false };
  delete emulatedBody.tools;
  delete emulatedBody.tool_choice;

  const emRes = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify(emulatedBody),
  });

  if (!emRes.ok) return emRes;

  const emResult = await emRes.json() as any;
  const emContent = emResult.choices?.[0]?.message?.content || "";
  const parsed = parseToolCalls(emContent);

  if (parsed?.toolCalls.length) {
    console.log(`[✓] ${body.model} → emulated ${parsed.toolCalls.length} tool call(s)`);
    const response = {
      ...emResult,
      choices: [{
        ...emResult.choices[0],
        finish_reason: "tool_calls",
        message: { role: "assistant", content: parsed.textContent || null, tool_calls: parsed.toolCalls },
      }],
    };
    if (wantStream) return sseFromToolCalls(response);
    return Response.json(response);
  }

  console.log(`[!] ${body.model} → emulation failed, returning text`);
  if (wantStream) return sseFromText(emResult);
  return Response.json(emResult);
}

const server = Bun.serve({
  port: PORT,
  hostname: process.env.HOST || "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" },
      });
    }

    try {
      if (path === "/v1/chat/completions" && req.method === "POST") return handleChat(req);

      if (path === "/health" || path === "/") {
        return Response.json({ status: "ok", proxy: "toolcall-middleware", port: PORT, upstream: UPSTREAM });
      }

      return fetch(`${UPSTREAM}${path}`, { method: req.method, headers: upstreamHeaders(), body: req.method !== "GET" ? await req.text() : undefined });
    } catch (err: any) {
      console.error("[toolcall-proxy]", err);
      return Response.json({ error: { message: err.message, type: "proxy_error" } }, { status: 500 });
    }
  },
});

console.log(`\n  toolcall-middleware v1.0.0`);
console.log(`  → http://127.0.0.1:${PORT}`);
console.log(`  → upstream: ${UPSTREAM}`);
console.log(`  → mode: native-first, fallback emulation\n`);
