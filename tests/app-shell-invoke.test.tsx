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
	throw new Error(
		`waitFor timed out after ${timeoutMs}ms\nlast frame:\n${JSON.stringify(check.toString())}`,
	);
}

async function pressKey(instance: Instance, key: string): Promise<void> {
	instance.stdin.write(key);
	await new Promise((r) => setTimeout(r, 40));
}

async function pressReturn(instance: Instance): Promise<void> {
	instance.stdin.write('\r');
	await new Promise((r) => setTimeout(r, 40));
}

async function pressTab(instance: Instance): Promise<void> {
	instance.stdin.write('\t');
	await new Promise((r) => setTimeout(r, 40));
}

async function pressEsc(instance: Instance): Promise<void> {
	instance.stdin.write('');
	await new Promise((r) => setTimeout(r, 40));
}

async function typeText(instance: Instance, text: string): Promise<void> {
	for (const ch of text) {
		instance.stdin.write(ch);
		await new Promise((r) => setTimeout(r, 15));
	}
	await new Promise((r) => setTimeout(r, 40));
}

describe('app-shell — Form mode → invoke → Result', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('golden path: highlight echo → Enter → Form mode → type "hello" → Enter → Result mode shows "hello"', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Middle pane is focused by default — Enter to open Form mode
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		let frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('Form');
		// message field label from the echo schema
		expect(frame).toMatch(/message/);

		await typeText(instance, 'hello');
		await pressReturn(instance);

		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('Result');
		expect(frame).toContain('hello');
		// echo returns a single text content block → design-spec §3.5 [text] prefix
		expect(frame).toContain('[text]');
	});

	it('validation error: submitting Form with an empty required field highlights the field and stays in Form mode', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Submit with the field left empty
		await pressReturn(instance);
		await new Promise((r) => setTimeout(r, 200));

		const frame = instance?.lastFrame() ?? '';
		// Still in Form mode — not Result — because validation failed
		expect(frame).toContain('Form');
		expect(frame).not.toContain('Result');
		// error prefix per design-spec §6 (state distinguishable without color)
		expect(frame.toLowerCase()).toMatch(/required|error/);
	});

	it('esc from Form returns to Preview mode', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		await pressEsc(instance);
		await new Promise((r) => setTimeout(r, 150));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).not.toContain('Form');
		// Preview mode pane title is 'Detail'
		expect(frame).toContain('Detail');
	});

	it('esc from Result returns to Form mode with previous field value preserved', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		await typeText(instance, 'world');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		await pressEsc(instance);
		await new Promise((r) => setTimeout(r, 150));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('Form');
		expect(frame).toContain('world');
	});

	it('q in Form mode is ignored (must esc first)', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// q should NOT quit — it should either be swallowed or typed into the field
		await pressKey(instance, 'q');
		await new Promise((r) => setTimeout(r, 150));

		const frame = instance?.lastFrame() ?? '';
		// Still rendering the Form
		expect(frame).toContain('Form');
	});

	it('status bar hints reflect Form mode', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('tab');
		expect(frame).toContain('submit');
		expect(frame).toContain('esc');
	});

	it('status bar hints reflect Result mode', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		await typeText(instance, 'ping');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('j/k scroll');
		expect(frame).toContain('esc');
	});

	it('tab moves focus to the next field in a multi-field form (fixture: prompt "greet" has a "name" arg)', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Switch to prompts tab — 'greet' has one 'name' arg (still primitive)
		await pressKey(instance, 'p');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('greet'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Even a single-field form should not crash on tab; multi-field coverage
		// arrives in Slice 8 fixtures. This is a smoke test for the tab handler.
		await pressTab(instance);
		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('Form');
	});
});
