import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app-shell.js';
import { renderWithStdio } from './helpers/render-with-stdio.js';

const MANY_TOOLS_ENTRY = fileURLToPath(
	new URL('./fixtures/many-tools-server.mjs', import.meta.url),
);

type Instance = ReturnType<typeof renderWithStdio>;

async function waitFor(check: () => boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function pressKey(instance: Instance, key: string): Promise<void> {
	instance.stdin.write(key);
	await new Promise((r) => setTimeout(r, 50));
}

describe('app-shell — middle-pane stable frame + internal scroll', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('at 80×24 with 30 tools: ↓ N indicator visible, ↑ blank, top item still in frame', async () => {
		instance = renderWithStdio(React.createElement(App, { path: MANY_TOOLS_ENTRY }), {
			columns: 80,
			rows: 24,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-00'));

		const frame = instance.lastFrame() ?? '';
		// Viewport at 24 rows = 17 list rows. 30 tools → 13 hidden below.
		expect(frame).toMatch(/↓ 13\b/);
		// Nothing hidden above yet — no `↑ N` line rendered.
		expect(frame).not.toMatch(/↑ \d/);
		// Top item visible; last item beyond the viewport must not be in the frame.
		expect(frame).toContain('tool-00');
		expect(frame).not.toContain('tool-29');
	});

	it('pressing j past the last visible row scrolls the window down one', async () => {
		instance = renderWithStdio(React.createElement(App, { path: MANY_TOOLS_ENTRY }), {
			columns: 80,
			rows: 24,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-00'));

		// Viewport = 17 rows. selection starts at 0, visible = tool-00 .. tool-16.
		// 17 j-presses → selection at index 17, one row below the bottom edge →
		// window scrolls down by 1 → tool-00 slides out, tool-17 slides in.
		for (let i = 0; i < 17; i++) {
			await pressKey(instance, 'j');
		}
		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-17'));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('tool-17');
		expect(frame).not.toContain('tool-00');
		// One row hidden above, 12 below.
		expect(frame).toMatch(/↑ 1\b/);
		expect(frame).toMatch(/↓ 12\b/);
	});

	it('scrolling all the way to the bottom hides the ↓ indicator', async () => {
		instance = renderWithStdio(React.createElement(App, { path: MANY_TOOLS_ENTRY }), {
			columns: 80,
			rows: 24,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-00'));

		// 29 j-presses → selection at index 29 (last item) → window scrolls
		// so tool-29 is the last visible row.
		for (let i = 0; i < 29; i++) {
			await pressKey(instance, 'j');
		}
		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-29'));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('tool-29');
		// 30 total − 17 visible = 13 hidden above; 0 hidden below.
		expect(frame).toMatch(/↑ 13\b/);
		expect(frame).not.toMatch(/↓ \d/);
	});

	it('ARGUS_ASCII=1: indicators fall back to ^ N / v N', async () => {
		instance = renderWithStdio(
			React.createElement(App, { path: MANY_TOOLS_ENTRY, env: { ARGUS_ASCII: '1' } }),
			{ columns: 80, rows: 24 },
		);

		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-00'));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toMatch(/v 13\b/);
		expect(frame).not.toContain('↓');
		expect(frame).not.toContain('↑');
	});
});
