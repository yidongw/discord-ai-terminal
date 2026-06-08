#!/usr/bin/env node

// MCP stdio bridge for the Discord bot.
//
// Claude Code speaks the MCP protocol to this script over stdio. The protocol
// (initialize / tools/list / tools/call) is terminated *locally* here — this
// process is long-lived, so the handshake state survives across messages.
//
// Only the actual side effects (ask the user a question / request a permission
// decision) are forwarded to the bot's HTTP server via its plain JSON endpoints
// (POST /tool/ask_user_question, POST /tool/approve_tool). This avoids the
// stateless-MCP-over-HTTP problem where every line became a fresh HTTP request
// that failed with "Server not initialized".

const http = require('http');
const { createInterface } = require('readline');

const HOST = process.env.MCP_SERVER_HOST || 'localhost';
const PORT = parseInt(process.env.MCP_SERVER_PORT || '3001', 10);
const PROTOCOL_VERSION = '2024-11-05';

function log(...args) {
  console.error('[mcp-bridge]', ...args);
}

log(`startup: DISCORD_CHANNEL_ID=${process.env.DISCORD_CHANNEL_ID}, server=${HOST}:${PORT}`);

// Discord context comes from env (baked into the per-session mcp-config by the
// bot) and is forwarded to the HTTP server as headers, matching what the
// server's extractDiscordContext() expects.
// HTTP header values must be ASCII. Discord channel/thread names routinely
// contain em dashes, emoji, etc. (the thread name is derived from the prompt),
// which Node's http rejects with ERR_INVALID_CHAR. Strip anything outside
// printable ASCII — the name is only metadata; channelId is what matters.
function headerSafe(value) {
  return String(value).replace(/[^\x20-\x7E]/g, '').trim();
}

function discordHeaders() {
  const headers = {};
  if (process.env.DISCORD_CHANNEL_ID) headers['X-Discord-Channel-Id'] = headerSafe(process.env.DISCORD_CHANNEL_ID);
  if (process.env.DISCORD_CHANNEL_NAME) headers['X-Discord-Channel-Name'] = headerSafe(process.env.DISCORD_CHANNEL_NAME);
  if (process.env.DISCORD_USER_ID) headers['X-Discord-User-Id'] = headerSafe(process.env.DISCORD_USER_ID);
  if (process.env.DISCORD_MESSAGE_ID) headers['X-Discord-Message-Id'] = headerSafe(process.env.DISCORD_MESSAGE_ID);
  return headers;
}

// POST a tool's arguments to the bot's HTTP endpoint and resolve with the
// parsed JSON response. No timeout here: ask_user_question intentionally blocks
// until the user clicks (the server applies its own timeout).
function callToolEndpoint(toolName, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args ?? {});
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: `/tool/${toolName}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...discordHeaders(),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Bad response from /tool/${toolName}: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'ask_user_question',
    description:
      'Ask the Discord user a question with multiple-choice options. Sends ' +
      'buttons to the Discord channel and blocks until the user clicks one ' +
      '(or picks "Other..." to type a free-form answer). Use this instead of ' +
      'the built-in AskUserQuestion tool.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'The questions to ask (usually one).',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question to ask.' },
              header: { type: 'string', description: 'Short header for the question.' },
              options: {
                type: 'array',
                description: 'Choices to present as buttons.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Button label.' },
                    description: { type: 'string', description: 'Optional longer description.' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Whether multiple options may be selected.' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'approve_tool',
    description:
      'Request permission from the Discord user before running a tool. ' +
      'Posts an approval message with ✅/❌ reactions and blocks until the ' +
      'user responds. Returns a permission decision.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'The tool requesting permission.' },
        input: { type: 'object', description: 'The input the tool wants to run with.' },
      },
      required: ['tool_name', 'input'],
    },
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a prompt to be re-run automatically in THIS Discord thread on a ' +
      'recurring interval. Use this for any "do X every N minutes/hours" request. ' +
      'You (the agent) exit after each turn, so you cannot sleep-and-loop yourself; ' +
      'instead register the task here and the bot will re-invoke you with this ' +
      'prompt when each interval elapses, posting the result back to this thread. ' +
      'The task repeats until cancelled with cancel_scheduled_task (or until ' +
      'max_runs is reached). Minimum interval is 60 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The instruction to run on each interval, written as a fresh standalone ' +
            'prompt (the future run only sees this text, not the current conversation).',
        },
        interval: {
          type: 'string',
          description: 'How often to repeat, e.g. "10m", "2h", "30s", "1d". Minimum 60s.',
        },
        label: { type: 'string', description: 'Optional short name shown when the task runs.' },
        max_runs: {
          type: 'number',
          description: 'Optional: auto-stop after this many runs. Omit for unlimited.',
        },
      },
      required: ['prompt', 'interval'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description:
      'List recurring tasks scheduled for this thread (their ids, prompts, ' +
      'intervals, and time until next run). Pass scope:"all" to list every ' +
      "thread's tasks.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Omit for this thread, or "all" for every thread.' },
      },
    },
  },
  {
    name: 'cancel_scheduled_task',
    description: 'Cancel/stop a recurring task by its id (from list_scheduled_tasks).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id to cancel.' },
      },
      required: ['id'],
    },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      ok(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'discord-permissions', version: '1.0.0' },
      });
      return;

    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no response

    case 'ping':
      if (!isNotification) ok(id, {});
      return;

    case 'tools/list':
      ok(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOOLS.some((t) => t.name === name)) {
        fail(id, -32602, `Unknown tool: ${name}`);
        return;
      }
      try {
        const result = await callToolEndpoint(name, args);
        ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (err) {
        log(`tools/call ${name} failed:`, err.message);
        // Return as a tool error so the agent can recover rather than killing the session.
        ok(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        });
      }
      return;
    }

    default:
      // Unknown request → method not found; ignore unknown notifications.
      if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
      return;
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

// Serialize handling so responses are written in request order and a blocking
// ask_user_question doesn't interleave with later messages.
let queue = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    log('skipping non-JSON line:', line.slice(0, 120));
    return;
  }
  queue = queue.then(() => handle(msg)).catch((err) => log('handler error:', err));
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
