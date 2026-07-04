import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/pager.js', () => ({
	spawnPager: vi.fn().mockResolvedValue({ exitCode: 0 }),
	resolvePagerCommand: vi.fn().mockReturnValue({ command: 'cat', args: [] }),
}));

import { App } from '../src/app-shell.js';
import { spawnPager } from '../src/pager.js';

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
	await new Promise((r) => setTimeout(r, 40));
}

async function pressReturn(instance: Instance): Promise<void> {
	instance.stdin.write('\r');
	await new Promise((r) => setTimeout(r, 40));
}

async function typeText(instance: Instance, text: string): Promise<void> {
	for (const ch of text) {
		instance.stdin.write(ch);
		await new Promise((r) => setTimeout(r, 15));
	}
	await new Promise((r) => setTimeout(r, 40));
}

describe('app-shell — Result mode `o` opens response in $PAGER', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		vi.mocked(spawnPager).mockClear();
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('pressing `o` in Result mode calls spawnPager with the raw payload piped as stdin', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		await typeText(instance, 'hello world');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		// Press `o` — should call spawnPager with the raw serialized payload.
		await pressKey(instance, 'o');
		await new Promise((r) => setTimeout(r, 150));

		expect(vi.mocked(spawnPager)).toHaveBeenCalledTimes(1);
		const firstCall = vi.mocked(spawnPager).mock.calls[0];
		expect(firstCall).toBeDefined();
		const [payload] = firstCall as [string, ...unknown[]];
		// echo returned `hello world` in a text content block — the "raw" payload
		// piped to the pager should carry that text somewhere in it.
		expect(payload).toContain('hello world');
	});

	it('status bar hints in Result mode advertise `o open in $PAGER`', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		await typeText(instance, 'ping');
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toContain('o open in $PAGER');
	});
});
