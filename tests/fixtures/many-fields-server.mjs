// Fixture: exposes a single tool with many schema fields so the right-pane
// preview exceeds any 80×24 viewport. Used by the right-pane scroll test to
// force a real scroll window in Preview mode.
import { createInterface } from 'node:readline';

const FIELD_COUNT = 25;

const properties = {};
for (let i = 0; i < FIELD_COUNT; i++) {
	properties[`field_${String(i).padStart(2, '0')}`] = { type: 'string' };
}

const tools = [
	{
		name: 'many-fields',
		description: 'A tool with many fields, used to exercise right-pane scrolling.',
		inputSchema: { type: 'object', properties, required: [] },
	},
];

const rl = createInterface({ input: process.stdin });

function respond(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
	process.stdout.write(
		`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`,
	);
}

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
			serverInfo: { name: 'many-fields-server', version: '0.0.0' },
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
	if (msg.method === 'tools/call') {
		respond(msg.id, { content: [{ type: 'text', text: JSON.stringify(msg.params?.arguments ?? {}) }] });
		return;
	}
	respondError(msg.id, -32601, `method not implemented: ${msg.method}`);
});

process.stdin.on('end', () => {
	process.exit(0);
});

setInterval(() => {}, 60_000);
