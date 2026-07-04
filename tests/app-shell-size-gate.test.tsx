import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app-shell.js';
import { renderWithStdio } from './helpers/render-with-stdio.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

async function waitFor(check: () => boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('app-shell — terminal size gate + resize', () => {
	let instance: ReturnType<typeof renderWithStdio> | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('72x20: renders the single-line "requires 80×24" gate; three-pane layout hidden', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 72,
			rows: 20,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('requires 80×24'));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('argus requires 80×24 terminal — current: 72x20');
		expect(frame).not.toContain('Connection');
		expect(frame).not.toContain('Capabilities');
		expect(frame).not.toContain('Detail');
	});

	it('72x20 → 80x24: resize brings the three-pane layout back', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 72,
			rows: 20,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('requires 80×24'));

		instance.stdout.resize(80, 24);

		await waitFor(() => (instance?.lastFrame() ?? '').includes('Connection'));
		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('Connection');
		expect(frame).toContain('Capabilities');
	});

	it('wide terminal (200x60): three-pane layout renders without truncation', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 200,
			rows: 60,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('Connection');
		expect(frame).toContain('Capabilities');
		expect(frame).toContain('Detail');
		// design-spec §2.3: preview description renders in full at wide widths.
		expect(frame).toContain('Echoes the input message back verbatim.');
	});

	it('resize during use preserves middle-pane selection', async () => {
		instance = renderWithStdio(React.createElement(App, { path: FIXTURE_ENTRY }), {
			columns: 100,
			rows: 30,
		});

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Advance selection to `boom` (second tool in the fixture) and confirm
		// the right-pane Preview updates to boom's description.
		instance.stdin.write('j');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Throws inside the handler'));

		// Resize to a much larger terminal; the boom preview must still be there.
		instance.stdout.resize(200, 60);
		await new Promise((r) => setTimeout(r, 150));

		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('Throws inside the handler — used to exercise the server-error path.');

		// And shrinking back inside the supported range keeps selection too.
		instance.stdout.resize(80, 24);
		await new Promise((r) => setTimeout(r, 150));
		const smaller = instance.lastFrame() ?? '';
		expect(smaller).toContain('boom');
	});
});
