#!/usr/bin/env node

// MCP bridge script that connects stdio to our HTTP MCP server
const http = require('http');
const { createInterface } = require('readline');

// Debug: Log environment variables at startup
console.error(`MCP Bridge startup: DISCORD_CHANNEL_ID=${process.env.DISCORD_CHANNEL_ID}, DISCORD_CHANNEL_NAME=${process.env.DISCORD_CHANNEL_NAME}, DISCORD_USER_ID=${process.env.DISCORD_USER_ID}`);

// Function to send a single JSON-RPC message to the HTTP server
function sendToMcpServer(jsonLine) {
  return new Promise((resolve, reject) => {
    // Skip empty lines
    if (!jsonLine.trim()) {
      resolve('');
      return;
    }

    const postData = jsonLine;

    // Add Discord context environment variables as headers
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(postData)
    };

    // Pass Discord environment variables as headers
    if (process.env.DISCORD_CHANNEL_ID) {
      headers['X-Discord-Channel-Id'] = process.env.DISCORD_CHANNEL_ID;
      console.error(`MCP Bridge: Adding Discord headers: channelId=${process.env.DISCORD_CHANNEL_ID}, channelName=${process.env.DISCORD_CHANNEL_NAME}, userId=${process.env.DISCORD_USER_ID}`);
    }
    if (process.env.DISCORD_CHANNEL_NAME) {
      headers['X-Discord-Channel-Name'] = process.env.DISCORD_CHANNEL_NAME;
    }
    if (process.env.DISCORD_USER_ID) {
      headers['X-Discord-User-Id'] = process.env.DISCORD_USER_ID;
    }
    if (process.env.DISCORD_MESSAGE_ID) {
      headers['X-Discord-Message-Id'] = process.env.DISCORD_MESSAGE_ID;
    }

    const options = {
      hostname: 'localhost',
      port: 3001,
      path: '/mcp',
      method: 'POST',
      headers
    };

    const req = http.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        // Handle Server-Sent Events format
        if (responseData.startsWith('event: message\ndata: ')) {
          const jsonData = responseData.replace('event: message\ndata: ', '').trim();
          resolve(jsonData);
        } else {
          resolve(responseData);
        }
      });
    });

    req.on('error', (err) => {
      console.error('MCP Bridge Error:', err);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

// Use readline to process stdin line by line
const rl = createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', async (line) => {
  try {
    const result = await sendToMcpServer(line);
    if (result) {
      process.stdout.write(result + '\n');
    }
  } catch (err) {
    console.error('MCP Bridge Error:', err);
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: `MCP server connection failed: ${err.message}`
      },
      id: null
    }) + '\n');
  }
});

// Handle process termination
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
