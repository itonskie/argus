import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app-shell.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

type Instance = ReturnType<typeof render>;

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

async function pressTab(instance: Instance): Promise<void> {
	instance.stdin.write('\t');
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
	// Wait for the tool list to populate (echo is always first).
	await waitFor(() => (instance.lastFrame() ?? '').includes('echo'));
	const target = TOOL_ORDER.indexOf(toolName);
	if (target < 0) throw new Error(`unknown fixture tool: ${toolName}`);
	for (let i = 0; i < target; i++) {
		await pressKey(instance, 'j');
	}
}

describe('app-shell — graceful ladder integration', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('nested-object: type name + age → invoke → Result echoes { user: { name, age } }', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await selectTool(instance, 'nested-object');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Focus should start on the first leaf — user.name.
		const openFrame = instance?.lastFrame() ?? '';
		expect(openFrame).toContain('Form');
		expect(openFrame).toMatch(/user\*?\s*\(object\)/);
		expect(openFrame).toContain('name');
		expect(openFrame).toContain('age');

		await typeText(instance, 'ada');
		await pressTab(instance);
		await typeText(instance, '42');
		await pressReturn(instance);

		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);
		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('Result');
		// echoArgs returns the args as a text block — assert the JSON echoes back.
		expect(frame).toContain('ada');
		expect(frame).toContain('42');
	});

	it('one-of: type JSON into raw-JSON textarea → invoke → Result echoes the value', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await selectTool(instance, 'one-of');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toMatch(/raw JSON — oneOf/);

		// Type a valid oneOf value: a JSON string.
		await typeText(instance, '"hello"');
		await pressReturn(instance);

		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);
		const result = instance?.lastFrame() ?? '';
		expect(result).toContain('Result');
		expect(result).toContain('hello');
	});

	it('one-of: invalid JSON syntax surfaces a per-field error and stays in Form', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await selectTool(instance, 'one-of');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Bad JSON — no closing brace.
		await typeText(instance, '{bad');
		await pressReturn(instance);
		await new Promise((r) => setTimeout(r, 200));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('Form');
		expect(frame).not.toContain('Result');
		expect(frame.toLowerCase()).toMatch(/json|invalid|parse|syntax/);
	});
});
