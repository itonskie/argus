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

// Clone process.env and null out the vars we care about so tests don't pick up
// whatever the developer has set locally (e.g. NO_COLOR=1 in their shell).
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	const { NO_COLOR, PREFERS_REDUCED_MOTION, ARGUS_ASCII, ...rest } = process.env;
	void NO_COLOR;
	void PREFERS_REDUCED_MOTION;
	void ARGUS_ASCII;
	return { ...rest, ...overrides };
}

const UNICODE_SINGLE_BORDERS = /[─│┌┐└┘├┤┬┴┼]/;
const UNICODE_BOLD_BORDERS = /[━┃┏┓┗┛]/;

describe('app-shell — accessibility (NO_COLOR, ARGUS_ASCII)', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	// design-spec §1: with NO_COLOR, focus indicator becomes a bold border +
	// bold title (no cyan). Ink's `borderStyle="bold"` uses ┏ ┃ ┓ chars, which
	// are visually distinct from the default single-line ┌ │ ┐ — so the focused
	// pane is still identifiable without color.
	it('NO_COLOR=1: focused pane renders bold-style border (┃/━)', async () => {
		instance = render(
			React.createElement(App, {
				path: FIXTURE_ENTRY,
				env: baseEnv({ NO_COLOR: '1' }),
			}),
		);

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).toMatch(UNICODE_BOLD_BORDERS);
		// State still distinguishable by text prefix (design-spec §6).
		expect(frame).toContain('● connected');
	});

	it('default env: no bold-style border chars, single-line only', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY, env: baseEnv() }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).not.toMatch(UNICODE_BOLD_BORDERS);
		expect(frame).toMatch(UNICODE_SINGLE_BORDERS);
	});

	it('ARGUS_ASCII=1: no Unicode box-drawing; ASCII `+ - |` used instead', async () => {
		instance = render(
			React.createElement(App, {
				path: FIXTURE_ENTRY,
				env: baseEnv({ ARGUS_ASCII: '1' }),
			}),
		);

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).not.toMatch(UNICODE_SINGLE_BORDERS);
		expect(frame).not.toMatch(UNICODE_BOLD_BORDERS);
		expect(frame).toMatch(/\+-{2,}\+/); // classic top border
		expect(frame).toContain('|');
	});

	it('NO_COLOR + ARGUS_ASCII: still only classic ASCII borders', async () => {
		instance = render(
			React.createElement(App, {
				path: FIXTURE_ENTRY,
				env: baseEnv({ NO_COLOR: '1', ARGUS_ASCII: '1' }),
			}),
		);

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		const frame = instance?.lastFrame() ?? '';
		expect(frame).not.toMatch(UNICODE_SINGLE_BORDERS);
		expect(frame).not.toMatch(UNICODE_BOLD_BORDERS);
		expect(frame).toMatch(/\+-{2,}\+/);
	});
});
