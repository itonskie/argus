// Fixture: ignores stdin-close and SIGTERM so we can verify the disconnect
// ladder escalates all the way to SIGKILL. Also swallows initialize so the
// caller reaches disconnect via a different path if desired — but for the
// current test, we shortcut to disconnect right after connect().
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
	try {
		const msg = JSON.parse(line);
		if (msg && msg.method === 'initialize' && typeof msg.id !== 'undefined') {
			const response = {
				jsonrpc: '2.0',
				id: msg.id,
				result: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					serverInfo: { name: 'stubborn-server', version: '0.0.0' },
				},
			};
			process.stdout.write(`${JSON.stringify(response)}\n`);
		}
		// All other messages are ignored.
	} catch {
		// Ignore malformed lines.
	}
});

process.on('SIGTERM', () => {
	// Deliberately ignored.
});
process.on('SIGHUP', () => {
	// Deliberately ignored.
});
process.stdin.on('end', () => {
	// Deliberately ignored — do not exit on stdin close.
});

setInterval(() => {}, 60_000);
