// Fixture: the first `tools/list` call returns a JSON-RPC error; the second
// call returns a single `echo` tool. Used to exercise the list-fetch retry
// path (design-spec §3.2 error state + `r to retry`).
import { createInterface } from 'node:readline';

let toolsListCalls = 0;
let resourcesListCalls = 0;
let promptsListCalls = 0;

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
	// notifications (no id) are ignored
	if (typeof msg.id === 'undefined') return;
	if (msg.method === 'initialize') {
		respond(msg.id, {
			protocolVersion: '2025-06-18',
			capabilities: { tools: {}, resources: {}, prompts: {} },
			serverInfo: { name: 'fail-list-tools-server', version: '0.0.0' },
		});
		return;
	}
	if (msg.method === 'tools/list') {
		toolsListCalls += 1;
		if (toolsListCalls === 1) {
			respondError(msg.id, -32000, 'simulated tools list failure');
		} else {
			respond(msg.id, {
				tools: [
					{
						name: 'echo',
						description: 'Echoes the input.',
						inputSchema: {
							type: 'object',
							properties: { message: { type: 'string' } },
							required: ['message'],
						},
					},
				],
			});
		}
		return;
	}
	if (msg.method === 'resources/list') {
		resourcesListCalls += 1;
		if (resourcesListCalls === 1) {
			respondError(msg.id, -32000, 'simulated resources list failure');
		} else {
			respond(msg.id, {
				resources: [
					{
						name: 'greeting',
						uri: 'argus://fixture/greeting',
						description: 'A retry-recovered greeting resource.',
						mimeType: 'text/plain',
					},
				],
			});
		}
		return;
	}
	if (msg.method === 'prompts/list') {
		promptsListCalls += 1;
		if (promptsListCalls === 1) {
			respondError(msg.id, -32000, 'simulated prompts list failure');
		} else {
			respond(msg.id, {
				prompts: [
					{
						name: 'greet',
						description: 'A retry-recovered greet prompt.',
						arguments: [{ name: 'name', required: true }],
					},
				],
			});
		}
		return;
	}
	respondError(msg.id, -32601, `method not implemented: ${msg.method}`);
});

process.stdin.on('end', () => {
	process.exit(0);
});

setInterval(() => {}, 60_000);
