import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app-shell.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

type Instance = ReturnType<typeof render>;

async function waitFor(check: () => boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('app-shell tracer bullet', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('renders three-pane skeleton with fixture path, connected status, and echo tool', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => {
			const frame = instance?.lastFrame() ?? '';
			return frame.includes('● connected') && frame.includes('echo');
		});

		const frame = instance?.lastFrame() ?? '';
		// Fixture basename shown in Connection pane, truncated with … at pane width
		const shortName = basename(FIXTURE_ENTRY).slice(0, 13);
		expect(frame).toContain(shortName);
		// stdio transport label
		expect(frame).toContain('stdio');
		// Connection status blip
		expect(frame).toContain('● connected');
		// echo tool from fixture listed in Capabilities pane
		expect(frame).toContain('echo');
		// [t]ools tab label
		expect(frame).toContain('[t]ools');
		// Status bar hints for middle pane (design-spec §3.6)
		expect(frame).toContain('↑/↓ list');
	});

	it('state markers are textual (● / pid / [t] / label) — distinguishable without color', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => {
			const frame = instance?.lastFrame() ?? '';
			return frame.includes('● connected') && frame.includes('echo');
		});

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('● connected');
		expect(frame).toMatch(/pid\s+\d+/);
		expect(frame).toContain('[t]ools');
	});

	it('j / k on the middle pane do not crash the render (single-tool list)', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		instance.stdin.write('j');
		await new Promise((r) => setTimeout(r, 25));
		expect(instance?.lastFrame() ?? '').toContain('echo');

		instance.stdin.write('k');
		await new Promise((r) => setTimeout(r, 25));
		expect(instance?.lastFrame() ?? '').toContain('echo');
	});

	it('q triggers disconnect: the spawned mcp-server child pid is gone after quit', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => /pid\s+\d+/.test(instance?.lastFrame() ?? ''));

		const frame = instance?.lastFrame() ?? '';
		const match = frame.match(/pid\s+(\d+)/);
		expect(match).not.toBeNull();
		const mcpPid = Number(match?.[1]);
		expect(mcpPid).toBeGreaterThan(0);
		expect(pidAlive(mcpPid)).toBe(true);

		// q → quit() → mcp-client.disconnect() → useApp().exit()
		instance.stdin.write('q');

		const start = Date.now();
		while (Date.now() - start < 5_000) {
			if (!pidAlive(mcpPid)) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(pidAlive(mcpPid)).toBe(false);
	});
});
