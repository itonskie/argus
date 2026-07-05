import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app-shell.js';
import { renderWithStdio } from './helpers/render-with-stdio.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));
const MANY_TOOLS_ENTRY = fileURLToPath(
	new URL('./fixtures/many-tools-server.mjs', import.meta.url),
);

// Ink decodes these ANSI sequences into `key.upArrow`, etc.
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';

type InkInstance = ReturnType<typeof render>;
type StdioInstance = ReturnType<typeof renderWithStdio>;

async function waitFor(check: () => boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function pressKey(instance: InkInstance | StdioInstance, key: string): Promise<void> {
	instance.stdin.write(key);
	await new Promise((r) => setTimeout(r, 50));
}

describe('app-shell — arrow-key aliases + tab/shift-tab cycles', () => {
	let instance: InkInstance | StdioInstance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	// TDD entry point (per issue #22): downArrow decrements/increments selection
	// exactly like `j` does today. Uses the many-tools fixture so the scroll
	// indicator N proves the selection actually moved.
	it('↓ in middle pane advances selection just like j (parity)', async () => {
		instance = renderWithStdio(React.createElement(App, { path: MANY_TOOLS_ENTRY }), {
			columns: 80,
			rows: 24,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-00'));

		// 17 down-arrow presses = 17 j presses. Selection goes from 0 to 17,
		// window scrolls down by 1 → ↑ 1 / ↓ 12 (matches app-shell-middle-scroll's j test).
		for (let i = 0; i < 17; i++) {
			await pressKey(instance, DOWN);
		}
		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-17'));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('tool-17');
		expect(frame).not.toContain('tool-00');
		expect(frame).toMatch(/↑ 1\b/);
		expect(frame).toMatch(/↓ 12\b/);
	});

	it('↑ in middle pane moves selection back just like k (parity)', async () => {
		instance = renderWithStdio(React.createElement(App, { path: MANY_TOOLS_ENTRY }), {
			columns: 80,
			rows: 24,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-00'));

		// Advance 17 with j (proven working), then ↑ once brings selection back
		// to 16 which is inside the window — no scroll change on this step.
		for (let i = 0; i < 17; i++) {
			await pressKey(instance, 'j');
		}
		await waitFor(() => (instance?.lastFrame() ?? '').includes('tool-17'));

		await pressKey(instance, UP);
		const frame = instance.lastFrame() ?? '';
		// tool-16 is inside the window; tool-17 is still visible; window did not scroll.
		expect(frame).toContain('tool-16');
		expect(frame).toContain('tool-17');
		expect(frame).toMatch(/↑ 1\b/);
		expect(frame).toMatch(/↓ 12\b/);
	});

	it('→ from middle pane moves focus to right pane (parity with l)', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, RIGHT);
		const frame = instance?.lastFrame() ?? '';
		// Right-pane preview shows the description for the selected tool.
		expect(frame).toContain('Echoes the input message back verbatim.');
	});

	it('← from right pane moves focus back to middle (parity with h)', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, RIGHT);
		await pressKey(instance, LEFT);
		// Still rendering; echo still listed.
		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('echo');
	});

	it('← from middle pane moves focus to left pane (parity with h)', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Focus starts on middle. Left arrow → left pane; hints collapse to `q quit` only.
		await pressKey(instance, LEFT);
		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('echo');
		// Only left-pane hint should be present now.
		expect(frame).toContain('q quit');
		expect(frame).not.toContain('list');
	});

	it('tab from middle pane cycles capability tabs tools → resources → prompts → tools', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, TAB);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greeting'));
		expect(instance?.lastFrame() ?? '').toContain('greeting');

		await pressKey(instance, TAB);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greet'));
		expect(instance?.lastFrame() ?? '').toContain('greet');

		await pressKey(instance, TAB);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));
		expect(instance?.lastFrame() ?? '').toContain('echo');
	});

	it('shift+tab from middle pane cycles tabs in reverse', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// tools → prompts (reverse)
		await pressKey(instance, SHIFT_TAB);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greet'));
		expect(instance?.lastFrame() ?? '').toContain('greet');

		// prompts → resources
		await pressKey(instance, SHIFT_TAB);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greeting'));
		expect(instance?.lastFrame() ?? '').toContain('greeting');

		// resources → tools
		await pressKey(instance, SHIFT_TAB);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));
		expect(instance?.lastFrame() ?? '').toContain('echo');
	});

	it('tab from right-pane Preview cycles capability tabs', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Move focus to right pane.
		await pressKey(instance, 'l');
		await waitFor(() =>
			(instance?.lastFrame() ?? '').includes('Echoes the input message back verbatim.'),
		);

		await pressKey(instance, TAB);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greeting'));
		expect(instance?.lastFrame() ?? '').toContain('greeting');
	});

	it('all existing vim keys still work: j k h l t r p', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// j / k on the middle pane — no crash, echo still visible.
		await pressKey(instance, 'j');
		await pressKey(instance, 'k');
		expect(instance?.lastFrame() ?? '').toContain('echo');

		// l → right pane, h → back.
		await pressKey(instance, 'l');
		await pressKey(instance, 'h');
		expect(instance?.lastFrame() ?? '').toContain('echo');

		// t / r / p tabs still cycle.
		await pressKey(instance, 'r');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greeting'));
		await pressKey(instance, 'p');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greet'));
		await pressKey(instance, 't');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));
		expect(instance?.lastFrame() ?? '').toContain('echo');
	});

	it('middle-pane status-bar hint advertises arrows + tab, drops vim keys', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		const frame = instance?.lastFrame() ?? '';
		// design-spec §3.6, focus = middle pane, preview
		expect(frame).toContain('←/→ panes');
		expect(frame).toContain('↑/↓ list');
		expect(frame).toContain('tab tabs');
		expect(frame).toContain('enter form');
		expect(frame).toContain('q quit');
		// vim keys must not be advertised.
		expect(frame).not.toContain('h/l panes');
		expect(frame).not.toContain('j/k list');
		expect(frame).not.toContain('t/r/p tabs');
	});

	it('right-pane preview status-bar hint advertises arrows + tab, drops vim keys', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, 'l');
		await waitFor(() =>
			(instance?.lastFrame() ?? '').includes('Echoes the input message back verbatim.'),
		);

		const frame = instance?.lastFrame() ?? '';
		// design-spec §3.6, focus = right pane, preview
		expect(frame).toContain('←/→ panes');
		expect(frame).toContain('↑/↓ scroll');
		expect(frame).toContain('tab tabs');
		expect(frame).toContain('q quit');
		// vim keys must not be advertised.
		expect(frame).not.toContain('h back');
		expect(frame).not.toContain('j/k scroll');
		expect(frame).not.toContain('t/r/p tabs');
	});
});
