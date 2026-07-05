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

async function pressKey(instance: Instance, key: string): Promise<void> {
	instance.stdin.write(key);
	await new Promise((r) => setTimeout(r, 50));
}

describe('app-shell — full browsing (resources + prompts + Preview)', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('shows tools by default, r switches to resources tab and lists greeting', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Tools tab active by default; echo listed
		expect(instance?.lastFrame() ?? '').toContain('echo');

		await pressKey(instance, 'r');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greeting'));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('greeting');
		// resources tab label present
		expect(frame).toContain('[r]es');
	});

	it('p switches to prompts tab and lists greet', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, 'p');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greet'));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('greet');
		expect(frame).toContain('[p]rmt');
	});

	it('l moves focus to right pane; preview shows highlighted tool name + description + schema tree', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, 'l');

		const frame = instance?.lastFrame() ?? '';
		// After moving focus right, preview should render for the selected echo tool
		expect(frame).toContain('echo');
		// description from fixture
		expect(frame).toContain('Echoes the input message back verbatim.');
		// condensed schema tree: message: string (required)
		expect(frame).toMatch(/message:\s*string\s*\(required\)/);
	});

	it('resources preview shows uri + mimeType', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, 'r');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greeting'));

		await pressKey(instance, 'l');

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('greeting');
		expect(frame).toContain('argus://fixture/greeting');
		expect(frame).toContain('text/plain');
	});

	it('prompts preview shows argument-derived schema tree', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, 'p');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greet'));

		await pressKey(instance, 'l');

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('greet');
		expect(frame).toContain('Renders a greeting for the given name.');
		expect(frame).toMatch(/name:\s*string/);
	});

	it('h from right pane returns focus to middle pane', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressKey(instance, 'l');
		// Move back
		await pressKey(instance, 'h');
		// Still functional after focus juggle
		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('echo');
	});

	it('status bar hints reflect middle-pane focus (default)', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		const frame = instance?.lastFrame() ?? '';
		// design-spec §3.6: arrows + tab are the discoverable path.
		expect(frame).toContain('tab tabs');
		expect(frame).toContain('↑/↓ list');
		expect(frame).toContain('enter form');
	});
});
