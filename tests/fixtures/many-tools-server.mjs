// Fixture: exposes 30 no-op tools so the middle-pane list exceeds any 80×24
// viewport. Used by the middle-pane scroll test to force a real scroll window.
import { createInterface } from 'node:readline';

const TOOL_COUNT = 30;

const rl = createInterface({ input: process.stdin });

function respond(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
	process.stdout.write(
		`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`,
	);
}

function toolName(i) {
	return `tool-${String(i).padStart(2, '0')}`;
}

const tools = Array.from({ length: TOOL_COUNT }, (_v, i) => ({
	name: toolName(i),
	description: `no-op scroll fixture tool #${i}`,
	inputSchema: { type: 'object', properties: {} },
}));

rl.on('line', (line) => {
	if (line.trim().length === 0) return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return;
	if (typeof msg.id === 'undefined') return;
	if (msg.method === 'initialize') {
		respond(msg.id, {
			protocolVersion: '2025-06-18',
			capabilities: { tools: {}, resources: {}, prompts: {} },
			serverInfo: { name: 'many-tools-server', version: '0.0.0' },
		});
		return;
	}
	if (msg.method === 'tools/list') {
		respond(msg.id, { tools });
		return;
	}
	if (msg.method === 'resources/list') {
		respond(msg.id, { resources: [] });
		return;
	}
	if (msg.method === 'prompts/list') {
		respond(msg.id, { prompts: [] });
		return;
	}
	respondError(msg.id, -32601, `method not implemented: ${msg.method}`);
});

process.stdin.on('end', () => {
	process.exit(0);
});

setInterval(() => {}, 60_000);
