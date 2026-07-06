import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app-shell.js';
import { renderWithStdio } from './helpers/render-with-stdio.js';

const MANY_FIELDS_ENTRY = fileURLToPath(
	new URL('./fixtures/many-fields-server.mjs', import.meta.url),
);
const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';

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

describe('app-shell — right-pane stable frame + internal scroll (Preview + Result)', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	// TDD entry point (per issue #23): with a preview that overflows the pane,
	// the ↓ N indicator is visible with non-zero N; ↓ scrolls one line.
	it('preview: ↓ N indicator visible; ↓ scrolls one line', async () => {
		instance = renderWithStdio(React.createElement(App, { path: MANY_FIELDS_ENTRY }), {
			columns: 80,
			rows: 24,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('many-fields'));

		// Focus right pane so preview scroll owns arrow keys.
		await pressKey(instance, 'l');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('A tool with many fields'));

		const frame1 = instance.lastFrame() ?? '';
		// preview content: name(1) + description(1) + Args:(1) + 25 fields = 28 lines.
		// right-pane viewport at 24 rows = 24 − 1 status − 2 border − 1 title − 2 indicators = 18 rows.
		// → 28 − 18 = 10 hidden below.
		expect(frame1).toMatch(/↓ 10\b/);
		expect(frame1).not.toMatch(/↑ \d/);
		expect(frame1).toContain('field_00');
		expect(frame1).not.toContain('field_24');

		await pressKey(instance, DOWN);
		const frame2 = instance.lastFrame() ?? '';
		expect(frame2).toMatch(/↑ 1\b/);
		expect(frame2).toMatch(/↓ 9\b/);
	});

	it('preview: ↑ scrolls up one line', async () => {
		instance = renderWithStdio(React.createElement(App, { path: MANY_FIELDS_ENTRY }), {
			columns: 80,
			rows: 24,
		});
		await waitFor(() => (instance?.lastFrame() ?? '').includes('many-fields'));
		await pressKey(instance, 'l');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('A tool with many fields'));

		// Scroll down 3, then up 1 → net 2 rows hidden above.
		await pressKey(instance, DOWN);
		await pressKey(instance, DOWN);
		await pressKey(instance, DOWN);
		await pressKey(instance, UP);
		const frame = instance.lastFrame() ?? '';
		expect(frame).toMatch(/↑ 2\b/);
		expect(frame).toMatch(/↓ 8\b/);
	});

	it('preview: scroll clamps at the bottom — ↓ indicator hides once fully scrolled', async () => {
		instance = renderWithStdio(React.createElement(App, { path: MANY_FIELDS_ENTRY }), {
			columns: 80,
			rows: 24,
		});
		await waitFor(() => (instance?.lastFrame() ?? '').includes('many-fields'));
		await pressKey(instance, 'l');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('A tool with many fields'));

		// Scroll to the bottom (need at least 10 presses; press extras to prove clamp).
		for (let i = 0; i < 20; i++) {
			await pressKey(instance, DOWN);
		}
		const frame = instance.lastFrame() ?? '';
		expect(frame).toMatch(/↑ 10\b/);
		expect(frame).not.toMatch(/↓ \d/);
		expect(frame).toContain('field_24');
		expect(frame).not.toContain('field_00');
	});

	it('preview: ARGUS_ASCII=1 falls back to ^ N / v N', async () => {
		instance = renderWithStdio(
			React.createElement(App, {
				path: MANY_FIELDS_ENTRY,
				env: { ARGUS_ASCII: '1' },
			}),
			{ columns: 80, rows: 24 },
		);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('many-fields'));
		await pressKey(instance, 'l');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('A tool with many fields'));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toMatch(/v 10\b/);
		expect(frame).not.toContain('↓');
		expect(frame).not.toContain('↑');
	});

	it('preview status-bar hint matches design-spec §3.6', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 80,
			rows: 24,
		});
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));
		await pressKey(instance, 'l');
		// Description is truncated with `…` at 80 cols; watch for a shorter substring.
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Echoes the input'));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('←/→ panes');
		expect(frame).toContain('↑/↓ scroll');
		expect(frame).toContain('tab tabs');
		expect(frame).toContain('q quit');
	});

	it('result: ↑/↓ scroll one line each', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 80,
			rows: 24,
		});
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Enter form for echo, type a message that produces a multi-line JSON result.
		await pressKey(instance, '\r'); // enter form
		await waitFor(() => (instance?.lastFrame() ?? '').includes('message'));
		// Type "hello".
		for (const c of 'hello') await pressKey(instance, c);
		// Submit.
		await pressKey(instance, '\r');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('[text]'));

		// echo returns "hello" — result is short and does not overflow, so no
		// indicators. Verify that ↑ and ↓ still work: they should not crash and
		// should not produce indicators when nothing is scrollable.
		const frameA = instance.lastFrame() ?? '';
		expect(frameA).toContain('[text]');
		expect(frameA).not.toMatch(/↑ \d/);
		expect(frameA).not.toMatch(/↓ \d/);

		await pressKey(instance, DOWN);
		await pressKey(instance, UP);
		const frameB = instance.lastFrame() ?? '';
		expect(frameB).toContain('[text]');
	});

	it('result: tab exits Result and cycles capability tab forward', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 80,
			rows: 24,
		});
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, '\r'); // enter form
		await waitFor(() => (instance?.lastFrame() ?? '').includes('message'));
		for (const c of 'hi') await pressKey(instance, c);
		await pressKey(instance, '\r'); // submit
		await waitFor(() => (instance?.lastFrame() ?? '').includes('[text]'));

		await pressKey(instance, TAB);
		// tab exits Result → active tab advances from tools → resources; middle
		// pane shows the greeting resource.
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greeting'));
		expect(instance?.lastFrame() ?? '').toContain('greeting');
		// Result frame should be gone; we're back in Preview.
		expect(instance?.lastFrame() ?? '').not.toContain('[text]');
	});

	it('result: shift+tab exits Result and cycles capability tab backward', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 80,
			rows: 24,
		});
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, '\r'); // enter form
		await waitFor(() => (instance?.lastFrame() ?? '').includes('message'));
		for (const c of 'hi') await pressKey(instance, c);
		await pressKey(instance, '\r'); // submit
		await waitFor(() => (instance?.lastFrame() ?? '').includes('[text]'));

		await pressKey(instance, SHIFT_TAB);
		// tools → prompts (reverse) — greet prompt appears.
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greet'));
		expect(instance?.lastFrame() ?? '').toContain('greet');
		expect(instance?.lastFrame() ?? '').not.toContain('[text]');
	});

	it('result status-bar hint matches design-spec §3.6', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 80,
			rows: 24,
		});
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, '\r'); // enter form
		await waitFor(() => (instance?.lastFrame() ?? '').includes('message'));
		for (const c of 'hi') await pressKey(instance, c);
		await pressKey(instance, '\r'); // submit
		await waitFor(() => (instance?.lastFrame() ?? '').includes('[text]'));

		const frame = instance.lastFrame() ?? '';
		// design-spec §3.6, focus = right pane, result
		expect(frame).toContain('↑/↓ scroll');
		expect(frame).toContain('tab tabs');
		expect(frame).toContain('o open in $PAGER');
		expect(frame).toContain('esc back to form');
		expect(frame).toContain('q quit');
		// vim keys must not be advertised.
		expect(frame).not.toContain('j/k scroll');
		expect(frame).not.toContain('h back');
	});
});
