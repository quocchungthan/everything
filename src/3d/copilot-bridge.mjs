/**
 * Vite plugin: serves the AI assistant's GitHub Copilot bridge from the dev and preview servers at
 * /api/copilot, so `npm run dev` is all that is needed. It drives the Copilot runtime bundled with
 * @github/copilot-sdk using the Copilot CLI login already stored on this computer.
 *
 * Only loopback clients may use it (the dev server listens on every interface), and POSTs must be
 * same-origin JSON so other web pages cannot drive the user's Copilot account.
 */
const ROUTE = '/api/copilot';
const MAX_BODY = 32 * 1024 * 1024;

// The default ("copilot-cli") client mode is required: "empty" mode disables the OS credential store
// where the Copilot CLI keeps its login. These options apply empty mode's sandboxing per session.
const SANDBOX = {
  enableSessionTelemetry: false,
  skipCustomInstructions: true,
  enableOnDemandInstructionDiscovery: false,
  enableFileHooks: false,
  enableHostGitOperations: false,
  enableSessionStore: false,
  enableSkills: false,
  includedBuiltinSkills: [],
  skipEmbeddingRetrieval: true,
  memory: { enabled: false },
  customAgentsLocalOnly: true,
  coauthorEnabled: false,
  manageScheduleEnabled: false,
};

/** A turn may run tools for a long time; it only fails when nothing happens for STALL_MS. */
const STALL_MS = 180000;
const TURN_LIMIT_MS = 30 * 60000;

/**
 * Sends the prompt and waits for the turn to finish. Unlike a fixed sendAndWait timeout, the stall
 * clock restarts on every session event and stops while `busy()` (a tool the app is running or the
 * user is confirming), so long multi-tool builds are not cut off.
 */
export async function runTurn(session, message, { busy = () => false, stallMs = STALL_MS, limitMs = TURN_LIMIT_MS, tick = 1000 } = {}) {
  let last = Date.now();
  let stalled = false;
  const unsubscribe = session.on(() => {
    last = Date.now();
  });
  const watchdog = setInterval(() => {
    if (busy()) last = Date.now();
    else if (!stalled && Date.now() - last > stallMs) {
      stalled = true;
      void Promise.resolve(session.abort()).catch(() => {});
    }
  }, Math.min(tick, stallMs));
  try {
    const response = await session.sendAndWait(message, limitMs);
    if (stalled) throw new Error(`Copilot stopped responding: nothing happened for ${Math.round(stallMs / 1000)} s.`);
    return response;
  } catch (error) {
    if (stalled) throw new Error(`Copilot stopped responding: nothing happened for ${Math.round(stallMs / 1000)} s.`);
    throw error;
  } finally {
    clearInterval(watchdog);
    unsubscribe();
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function loopbackAddress(address) {
  return typeof address === 'string' && (address === '::1' || /^(::ffff:)?127(?:\.\d{1,3}){3}$/.test(address));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw httpError(415, 'Request body must be JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'Request exceeds the 32 MB limit.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Request body must be valid JSON.');
  }
}

function sse(res, event, data) {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function chatPayload(body) {
  if (!Array.isArray(body?.messages) || body.messages.length > 256) throw httpError(400, 'Invalid chat messages.');
  if (!Array.isArray(body.tools) || body.tools.length > 64) throw httpError(400, 'Invalid tool definitions.');
  const system = body.messages.find((m) => m?.role === 'system')?.content;
  if (typeof system !== 'string') throw httpError(400, 'The assistant system prompt is missing.');

  const attachments = [];
  const lines = [];
  let attachmentIndex = 0;
  for (const message of body.messages.filter((m) => m?.role !== 'system')) {
    const role = String(message.role).toUpperCase();
    const content = message.content;
    const text = [];
    if (typeof content === 'string') text.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') text.push(part.text);
        else if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string' && typeof part.source.media_type === 'string') {
          attachmentIndex++;
          attachments.push({ type: 'blob', data: part.source.data, mimeType: part.source.media_type, displayName: `image-${attachmentIndex}` });
          text.push(`[Image attachment ${attachmentIndex}]`);
        } else if (part?.type === 'document' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
          attachmentIndex++;
          attachments.push({ type: 'blob', data: part.source.data, mimeType: 'application/pdf', displayName: `document-${attachmentIndex}.pdf` });
          text.push(`[PDF attachment ${attachmentIndex}]`);
        }
      }
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) text.push(`Requested tool ${call.function?.name}: ${call.function?.arguments}`);
    }
    if (message.role === 'tool') text.unshift(`Result for tool call ${message.tool_call_id}:`);
    if (text.length) lines.push(`${role}:\n${text.join('\n')}`);
  }

  const tools = body.tools.map((tool) => {
    const fn = tool?.function;
    if (tool?.type !== 'function' || typeof fn?.name !== 'string' || !/^[\w.-]{1,80}$/.test(fn.name) || typeof fn.description !== 'string' || !fn.parameters || typeof fn.parameters !== 'object') {
      throw httpError(400, 'A tool definition is invalid.');
    }
    // The app runs and confirms tools itself; deferred tools would sit behind a tool-search tool
    // that the allowlist below excludes.
    return { name: fn.name, description: fn.description, parameters: fn.parameters, defer: 'never', skipPermission: true };
  });
  return {
    system,
    prompt: lines.join('\n\n') || '(No conversation messages.)',
    attachments,
    tools,
    model: typeof body.model === 'string' && body.model ? body.model : 'auto',
  };
}

function createBridge(logger) {
  const pendingTools = new Map();
  let clientPromise = null;

  // Started on first use so the dev server starts instantly, and dropped after a failure or a
  // signed-out status so "Retry connection" picks up a fresh `copilot login` without a restart.
  function client() {
    clientPromise ??= (async () => {
      const { CopilotClient } = await import('@github/copilot-sdk');
      const c = new CopilotClient({
        logLevel: 'error',
        useLoggedInUser: true,
        env: { ...process.env, COPILOT_GITHUB_TELEMETRY_DISABLED: 'true' },
      });
      await c.start();
      return c;
    })();
    clientPromise.catch(() => {
      clientPromise = null;
    });
    return clientPromise;
  }

  async function reset() {
    const current = clientPromise;
    clientPromise = null;
    if (current) await current.then((c) => c.stop()).catch(() => {});
  }

  async function health(res) {
    try {
      const auth = await (await client()).getAuthStatus();
      const authenticated = auth.isAuthenticated === true;
      if (!authenticated) await reset();
      sendJson(res, 200, { available: true, authenticated, ...(authenticated ? { login: auth.login } : {}) });
    } catch (error) {
      await reset();
      sendJson(res, 200, { available: false, authenticated: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function chat(req, res) {
    const input = chatPayload(await readJson(req));
    let c;
    try {
      c = await client();
    } catch (error) {
      throw httpError(503, `The Copilot runtime could not start: ${error instanceof Error ? error.message : String(error)}`);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let session;
    let closed = false;
    let streamedText = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        closed = true;
        if (session) void session.abort().catch(() => {});
      }
    });

    try {
      session = await c.createSession({
        ...SANDBOX,
        model: input.model,
        streaming: true,
        systemMessage: { mode: 'customize', content: input.system, sections: { environment_context: { action: 'remove' } } },
        tools: input.tools,
        availableTools: input.tools.map((tool) => `custom:${tool.name}`),
      });
      session.on('assistant.message_delta', (event) => {
        if (!event.agentId && typeof event.data.deltaContent === 'string' && event.data.deltaContent) {
          streamedText = true;
          sse(res, 'text', { text: event.data.deltaContent });
        }
      });
      session.on('external_tool.requested', (event) => {
        pendingTools.set(event.data.requestId, session);
        sse(res, 'tool', event.data);
      });

      const owned = session;
      const response = await runTurn(session, { prompt: input.prompt, attachments: input.attachments }, {
        busy: () => [...pendingTools.values()].includes(owned),
      });
      if (!streamedText && response?.data.content) sse(res, 'text', { text: response.data.content });
      if (!closed) sse(res, 'done', {});
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (!closed) {
        sse(res, 'error', { message: error instanceof Error ? error.message : String(error) });
        res.end();
      }
    } finally {
      for (const [requestId, owner] of pendingTools) if (owner === session) pendingTools.delete(requestId);
      if (session) await session.disconnect().catch(() => {});
    }
  }

  async function toolResult(req, res) {
    const body = await readJson(req);
    const session = pendingTools.get(body?.requestId);
    if (!session) throw httpError(404, 'This tool request is no longer pending.');
    const result = body.result || {};
    const image = typeof result.image === 'string' ? /^data:(image\/[^;,]+);base64,(.*)$/.exec(result.image) : null;
    const payload = {
      textResultForLlm: String(result.content || ''),
      resultType: result.ok === false ? 'failure' : 'success',
      ...(result.ok === false ? { error: String(result.content || 'Tool failed.') } : {}),
      ...(image ? { binaryResultsForLlm: [{ type: 'image', data: image[2], mimeType: image[1], description: 'Scene viewport screenshot' }] } : {}),
    };
    const handled = await session.rpc.tools.handlePendingToolCall({ requestId: body.requestId, result: payload });
    pendingTools.delete(body.requestId);
    if (!handled.success) throw httpError(409, 'Copilot no longer accepts this tool result.');
    sendJson(res, 200, { ok: true });
  }

  async function handle(req, res) {
    try {
      if (!loopbackAddress(req.socket.remoteAddress)) throw httpError(403, 'The Copilot bridge only accepts requests from this computer.');
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return await health(res);
      if (req.method !== 'POST') throw httpError(404, 'Not found.');
      if (!sameOrigin(req)) throw httpError(403, 'Cross-origin requests are not allowed.');
      if (path === '/chat') return await chat(req, res);
      if (path === '/tool-result') return await toolResult(req, res);
      throw httpError(404, 'Not found.');
    } catch (error) {
      if (!error.status) logger.error(`[copilot] ${error.stack || error}`);
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || 'The Copilot bridge failed.' });
      else if (!res.writableEnded) res.end();
    }
  }

  return { handle, close: reset };
}

export default function copilotBridge() {
  function attach(server) {
    const bridge = createBridge(server.config.logger);
    server.middlewares.use(ROUTE, (req, res) => void bridge.handle(req, res));
    server.httpServer?.on('close', () => void bridge.close());
  }
  return { name: 'copilot-bridge', configureServer: attach, configurePreviewServer: attach };
}
