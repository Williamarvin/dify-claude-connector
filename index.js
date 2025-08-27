#!/usr/bin/env node
import 'dotenv/config';
import { fetch } from 'undici';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline';

// ========= Config =========
const REMOTE_URL = process.env.DIFY_MCP_URL;
const TOKEN = process.env.DIFY_MCP_TOKEN;
const TIMEOUT = Number(process.env.DIFY_MCP_TIMEOUT || 60000);

// ========= Utils =========
function log(...a){ console.error('[dify-bridge]', ...a); }

if (!REMOTE_URL || !TOKEN) {
  log('Missing env. Set DIFY_MCP_URL and DIFY_MCP_TOKEN.');
  process.exit(1);
}

function sanitizeToolName(name, fallbackBase = 'tool') {
  const cleaned = String(name ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
  return cleaned || fallbackBase;
}

function repairToolsInInitializeResult(result) {
  if (!result || !Array.isArray(result.tools)) return result;
  const tools = result.tools.map((t, i) => {
    if (!t || typeof t !== 'object') return t;
    const name = sanitizeToolName(t.name ?? `tool_${i+1}`, `tool_${i+1}`);
    return { ...t, name };
  });
  return { ...result, tools };
}

// Only ever emit valid JSON-RPC objects to stdout
function sendResponse(obj) {
  const out = {};
  out.jsonrpc = '2.0';

  if (obj && typeof obj === 'object') {
    if ('id' in obj) out.id = obj.id;
    if ('result' in obj) out.result = obj.result;
    if ('error' in obj) out.error = obj.error;
  }
  // Ensure either result or error exists
  if (!('result' in out) && !('error' in out)) {
    out.error = { code: -32603, message: 'Internal error: empty response' };
  }
  if (!('id' in out)) out.id = null;

  output.write(JSON.stringify(out) + '\n');
}

function sendNotification(method, params) {
  const obj = {
    jsonrpc: '2.0',
    method: String(method || ''),
    params: params ?? {}
  };
  output.write(JSON.stringify(obj) + '\n');
}

function makeError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

async function parseSseLike(text) {
  const chunks = text.split('\n\n').map(c => c.trim()).filter(Boolean);
  let lastData = null;
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) lastData = payload;
      }
    }
  }
  if (!lastData && text.includes('data:')) {
    const matches = [...text.matchAll(/data:\s*(\{[\s\S]*?\})(?=\n|$)/g)];
    if (matches.length) lastData = matches[matches.length - 1][1];
  }
  if (!lastData) return null;
  try { return JSON.parse(lastData); } catch {}
  try { return JSON.parse(JSON.parse(lastData)); } catch {}
  return null;
}

async function forwardToRemote(payload, expectId) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(REMOTE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();

    if (!res.ok) {
      return makeError(expectId, -32000, `Remote MCP error ${res.status}`, text);
    }

    if (ct.includes('text/event-stream')) {
      const parsed = await parseSseLike(text);
      if (!parsed) {
        return makeError(expectId, -32700, 'Parse error (no SSE data)', text);
      }
      return parsed;
    }

    try {
      return JSON.parse(text);
    } catch {
      const parsed = await parseSseLike(text);
      if (parsed) return parsed;
      return makeError(expectId, -32700, 'Parse error (invalid JSON)', text);
    }
  } catch (e) {
    return makeError(expectId, -32098, 'Network error forwarding to remote MCP', e?.message || String(e));
  } finally {
    clearTimeout(t);
  }
}

// ========= IO =========
const rl = readline.createInterface({ input });
output.setDefaultEncoding('utf8');

let initialized = false;

function localInitializeSuccess(id) {
  initialized = true;
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'dify-mcp-bridge', version: '1.0.0' },
      capabilities: {},
      tools: []
    }
  };
}
function normalizeRemoteError(err) {
  // Accept many shapes and coerce into { code, message, data? }
  if (!err || typeof err !== 'object') {
    return { code: -32000, message: String(err ?? 'Remote error') };
  }
  const code = Number(
    err.code !== undefined ? err.code :
    err.status !== undefined ? err.status :
    -32000
  );
  const message = String(
    err.message ??
    err.error ??
    err.reason ??
    'Remote error'
  );
  const out = { code, message };
  if (err.data !== undefined) out.data = err.data;
  return out;
}

function coerceToValidResponseForClient(resp, fallbackId) {
  // Notifications from remote (method present, no id): emit as notification, not response
  if (resp && typeof resp === 'object' && 'method' in resp && !('id' in resp)) {
    const method = typeof resp.method === 'string' ? resp.method : 'remote/notification';
    const params = (resp.params && typeof resp.params === 'object') ? resp.params : {};
    sendNotification(method, params);
    // And return a benign success response for the original request
    return { jsonrpc: '2.0', id: fallbackId ?? null, result: { ok: true } };
  }

  // If remote omitted jsonrpc/id but has a result or error, attach id
  if (!resp || typeof resp !== 'object') {
    return makeError(fallbackId, -32603, 'Remote returned non-object');
  }

  // Error path (support many shapes)
  if ('error' in resp && resp.error !== undefined && resp.error !== null) {
    const norm = normalizeRemoteError(resp.error);
    return { jsonrpc: '2.0', id: resp.id ?? fallbackId ?? null, error: norm };
  }

  // Sometimes remotes use { message, status } as an error response
  if (!('result' in resp) && ('message' in resp || 'status' in resp)) {
    const norm = normalizeRemoteError(resp);
    return { jsonrpc: '2.0', id: resp.id ?? fallbackId ?? null, error: norm };
  }

  // Result path
  if (!('result' in resp)) {
    return makeError(fallbackId, -32603, 'Remote missing result and error');
  }

  // Strip unknown top-level keys from result response
  return {
    jsonrpc: '2.0',
    id: resp.id ?? fallbackId ?? null,
    result: resp.result
  };
}

async function handleMessage(line) {
  if (!line || !line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // ignore invalid lines
    return;
  }

  const id = msg.id ?? null;
  const method = msg.method;

  if (typeof method !== 'string' || !method) {
    sendResponse(makeError(id, -32600, 'Invalid Request: missing method'));
    return;
  }

  // Forward initialize, sanitize tools
  if (method === 'initialize') {
    const remote = await forwardToRemote(msg, id);

    if (remote && remote.result) {
      initialized = true;
      remote.result = repairToolsInInitializeResult(remote.result);
      const safe = coerceToValidResponseForClient(remote, id);
      sendResponse(safe);
      return;
    }

    if (remote && remote.error) {
      log('Remote initialize failed, returning local minimal initialize. Remote error:', remote.error);
      sendResponse(localInitializeSuccess(id));
      sendNotification('notifications/message', {
        level: 'warning',
        message: `dify-bridge: remote initialize failed (${remote.error.message || 'unknown'})`
      });
      return;
    }

    // Unexpected fallback
    sendResponse(localInitializeSuccess(id));
    return;
  }

  const remote = await forwardToRemote(msg, id);

  // If remote provided tool lists inside result, sanitize names
  if (remote && remote.result && Array.isArray(remote.result.tools)) {
    remote.result = repairToolsInInitializeResult(remote.result);
  }

  const safe = coerceToValidResponseForClient(remote, id);
  sendResponse(safe);
}

// ========= Start =========
log('Starting bridge →', REMOTE_URL);
rl.on('line', l => { handleMessage(l).catch(err => log('handleMessage error', err)); });
rl.on('close', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));