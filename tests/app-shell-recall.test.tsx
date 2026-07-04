import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app-shell.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

type Instance = ReturnType<typeof render>;

// Up-arrow escape sequence — ink decodes this into `key.upArrow`.
const UP = '\x1b[A';
// Shift-tab (backwards focus) — matches ink's `key.tab + key.shift`.
const SHIFT_TAB = '\x1b[Z';

async function waitFor(check: () => boolean, timeoutMs = 8_000, intervalMs = 25): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function pressKey(instance: Instance, key: string): Promise<void> {
	instance.stdin.write(key);
	await new Promise((r) => setTimeout(r, 40));
}

async function pressReturn(instance: Instance): Promise<void> {
	instance.stdin.write('\r');
	await new Promise((r) => setTimeout(r, 40));
}

async function pressEsc(instance: Instance): Promise<void> {
	instance.stdin.write('\x1b');
	await new Promise((r) => setTimeout(r, 40));
}

async function pressBackspace(instance: Instance, times: number): Promise<void> {
	for (let i = 0; i < times; i++) {
		instance.stdin.write('\x7f');
		await new Promise((r) => setTimeout(r, 15));
	}
	await new Promise((r) => setTimeout(r, 40));
}

async function typeText(instance: Instance, text: string): Promise<void> {
	for (const ch of text) {
		instance.stdin.write(ch);
		await new Promise((r) => setTimeout(r, 15));
	}
	await new Promise((r) => setTimeout(r, 40));
}

// Order matches the tool list in src/test-server-fixture.ts.
const TOOL_ORDER = [
	'echo',
	'boom',
	'slow',
	'nested-object',
	'array-of-strings',
	'array-of-objects',
	'one-of',
	'ref-schema',
	'binary-blob',
];

async function selectTool(instance: Instance, toolName: string): Promise<void> {
	await waitFor(() => (instance.lastFrame() ?? '').includes('echo'));
	const target = TOOL_ORDER.indexOf(toolName);
	if (target < 0) throw new Error(`unknown fixture tool: ${toolName}`);
	for (let i = 0; i < target; i++) {
		await pressKey(instance, 'j');
	}
}

describe('app-shell — arrow-up recall', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('primitive field: invoke echo("hello") → esc → clear → up repopulates "hello"', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		await typeText(instance, 'hello');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		await pressEsc(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Sanity: the field still shows "hello" (Esc preserves state per Slice 8).
		expect(instance?.lastFrame() ?? '').toContain('hello');

		// Clear the field — 5 backspaces removes "hello".
		await pressBackspace(instance, 5);
		let frame = instance?.lastFrame() ?? '';
		expect(frame).not.toContain('hello');

		// Empty field + up-arrow → recall.
		await pressKey(instance, UP);
		frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('Form');
		expect(frame).toContain('hello');
	});

	it('up-arrow on a non-empty field is a no-op (does not overwrite user input)', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// First invocation seeds the last-args ref.
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));
		await typeText(instance, 'first');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);
		await pressEsc(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Field currently has "first". Pressing up-arrow should NOT recall — field is not empty.
		await pressKey(instance, UP);
		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('first');
	});

	it('tool mismatch: after echo invocation, switching to nested-object + up-arrow does not recall echo args', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Invoke echo with a distinctive value.
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));
		await typeText(instance, 'sentinel-echo-value');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		// Back to preview, then navigate to nested-object.
		await pressEsc(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));
		await pressEsc(instance);
		await waitFor(() => !(instance?.lastFrame() ?? '').includes('Form'));

		await selectTool(instance, 'nested-object');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Empty focused field on a different tool → up-arrow must not paste echo's args.
		await pressKey(instance, UP);
		const frame = instance?.lastFrame() ?? '';
		expect(frame).not.toContain('sentinel-echo-value');
	});

	it('array-of-primitives: recall repopulates the array items', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await selectTool(instance, 'array-of-strings');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// First row is [0]; type value.
		await typeText(instance, 'alpha');
		// Move to add-row via tab, add a second row, type value.
		await pressKey(instance, '\t');
		await pressReturn(instance);
		await typeText(instance, 'beta');
		await pressReturn(instance); // submit
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		await pressEsc(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Clear focused (second) array row.
		await pressBackspace(instance, 4);
		// Focus first row via shift-tab.
		await pressKey(instance, SHIFT_TAB);
		await pressBackspace(instance, 5);

		let frame = instance?.lastFrame() ?? '';
		expect(frame).not.toContain('alpha');
		expect(frame).not.toContain('beta');

		await pressKey(instance, UP);
		frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('alpha');
		expect(frame).toContain('beta');
	});

	it('raw-JSON: recall restores the stringified value into the textarea', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await selectTool(instance, 'array-of-objects');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Schema requires items[i].id — pick a payload ajv will accept.
		await typeText(instance, '[{"id":4242}]');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		await pressEsc(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Clear the textarea.
		await pressBackspace(instance, 30);
		let frame = instance?.lastFrame() ?? '';
		expect(frame).not.toContain('4242');

		await pressKey(instance, UP);
		frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('4242');
	});

	it('cache survives Esc back to Preview and re-entering Form: clear + up-arrow still recalls', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));
		await typeText(instance, 'persist');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		// Esc all the way back to Preview, then re-enter Form.
		await pressEsc(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));
		await pressEsc(instance);
		await waitFor(() => !(instance?.lastFrame() ?? '').includes('Form'));
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Fresh Form — field starts empty.
		await pressKey(instance, UP);
		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('persist');
	});

	it('no on-disk state: app-shell source has no fs-write / persist APIs (ADR 3 gate)', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(
			fileURLToPath(new URL('../src/app-shell.tsx', import.meta.url)),
			'utf8',
		);
		expect(src).not.toMatch(/fs\.writeFile|writeFileSync|createWriteStream/);
	});
});
