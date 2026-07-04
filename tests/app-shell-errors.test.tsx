import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app-shell.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));
const HANG_FIXTURE = fileURLToPath(new URL('./fixtures/hang-init-server.mjs', import.meta.url));
const FAIL_LIST_FIXTURE = fileURLToPath(
	new URL('./fixtures/fail-list-tools-server.mjs', import.meta.url),
);

type Instance = ReturnType<typeof render>;

async function waitFor(check: () => boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// Extract the joined text of a specific pane (0 = left, 1 = middle, 2 = right)
// from a rendered Ink frame. Assumes the three-pane layout with `││` as the
// inter-pane border. Newline-agnostic — collapses each pane's wrapped rows
// into a single-line string so wide phrases match regardless of pane width.
function paneText(frame: string, paneIndex: 0 | 1 | 2): string {
	const rows = frame.split('\n');
	const paneRows: string[] = [];
	for (const row of rows) {
		// Body rows start with a wrapping border `│`, then the panes.
		if (!row.startsWith('│')) continue;
		// Split on the internal double-border `││` — three segments emerge.
		// Some rows won't have both dividers (e.g. status bar); skip those.
		const segments = row.split('││');
		if (segments.length < 3) continue;
		const seg = segments[paneIndex] ?? '';
		// Strip leading `│ ` and trailing padding / border.
		const cleaned = seg.replace(/^│?\s*/, '').replace(/\s*│?$/, '');
		if (cleaned.length > 0) paneRows.push(cleaned);
	}
	return paneRows.join(' ').replace(/\s+/g, ' ').trim();
}

async function pressKey(instance: Instance, key: string): Promise<void> {
	instance.stdin.write(key);
	await new Promise((r) => setTimeout(r, 40));
}

async function pressReturn(instance: Instance): Promise<void> {
	instance.stdin.write('\r');
	await new Promise((r) => setTimeout(r, 40));
}

describe('app-shell — error states', () => {
	let instance: Instance | undefined;

	afterEach(async () => {
		if (instance) {
			instance.rerender(React.createElement(React.Fragment));
			instance.unmount();
			instance = undefined;
			await new Promise((r) => setTimeout(r, 200));
		}
	});

	it('initialize timeout: after ~5s, left pane shows the red timeout block; only q works', async () => {
		instance = render(React.createElement(App, { path: HANG_FIXTURE }));

		await waitFor(
			() => {
				const left = paneText(instance?.lastFrame() ?? '', 0);
				return left.includes('server did not respond to initialize within 5s');
			},
			8_000,
			100,
		);

		const frame = instance?.lastFrame() ?? '';
		const left = paneText(frame, 0);
		// design-spec §3.1: red error block with the exact message
		expect(left).toContain('server did not respond to initialize within 5s');
		// design-spec §6: state distinguishable without color — 'error:' prefix
		expect(left.toLowerCase()).toContain('error:');
		// User can only press q to quit — the hint must reflect that
		expect(left).toContain('q to quit');
		// Middle/right panes are disabled — no tools list rendered, no Detail body
		expect(frame).not.toContain('echo');
	}, 12_000);

	it('mid-session crash: killing the child pid switches left pane to server-exited red block within 1s', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('● connected'));

		const frame = instance?.lastFrame() ?? '';
		const match = frame.match(/pid\s+(\d+)/);
		expect(match).not.toBeNull();
		const mcpPid = Number(match?.[1]);
		process.kill(mcpPid, 'SIGKILL');

		await waitFor(
			() => {
				const left = paneText(instance?.lastFrame() ?? '', 0);
				return left.includes('server exited') && left.includes('invocations disabled');
			},
			3_000,
			25,
		);

		const leftAfter = paneText(instance?.lastFrame() ?? '', 0);
		expect(leftAfter).toContain('server exited');
		expect(leftAfter).toContain('invocations disabled');
		expect(leftAfter.toLowerCase()).toContain('error:');
	});

	it('mid-session crash while Form mode is active: form dims, cursor removed, footer says server disconnected — cannot invoke', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Enter form mode on the highlighted echo tool
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));

		// Grab the child pid before we lose it in the frame (the connected block goes away)
		const before = instance?.lastFrame() ?? '';
		const match = before.match(/pid\s+(\d+)/);
		expect(match).not.toBeNull();
		const mcpPid = Number(match?.[1]);
		process.kill(mcpPid, 'SIGKILL');

		await waitFor(
			() => {
				const right = paneText(instance?.lastFrame() ?? '', 2);
				return right.includes('server disconnected — cannot invoke');
			},
			3_000,
			25,
		);

		const rightPane = paneText(instance?.lastFrame() ?? '', 2);
		// design-spec §3.4: form disabled footer
		expect(rightPane).toContain('server disconnected — cannot invoke');
		// Still showing Form title (mode is preserved, just disabled)
		expect(rightPane).toContain('Form');
	});

	it('list-fetch retry works for resources and prompts tabs too', async () => {
		instance = render(React.createElement(App, { path: FAIL_LIST_FIXTURE }));

		// Wait for connect + first-round list failures to settle
		await waitFor(() => (instance?.lastFrame() ?? '').includes('● connected'));
		await waitFor(
			() => {
				const middle = paneText(instance?.lastFrame() ?? '', 1);
				return middle.includes('failed to list tools');
			},
			5_000,
			50,
		);

		// Switch to resources tab — should also show error
		await pressKey(instance, 'r');
		// First 'r' here is now retry-tools (active tab is tools with error).
		// The retry recovers tools; we need to press 't' to move back if we
		// want to switch tabs. Actually — after first 'r' retries tools and
		// tools loads, we need to press 'r' again to switch to resources.
		await waitFor(
			() => {
				const middle = paneText(instance?.lastFrame() ?? '', 1);
				return middle.includes('echo');
			},
			5_000,
			50,
		);

		// Now the active tab (tools) is not in error, so `r` switches to resources
		await pressKey(instance, 'r');
		await waitFor(
			() => {
				const middle = paneText(instance?.lastFrame() ?? '', 1);
				return middle.includes('failed to list resources');
			},
			3_000,
			50,
		);

		// Retry resources by pressing r again (active tab in error)
		await pressKey(instance, 'r');
		await waitFor(
			() => {
				const middle = paneText(instance?.lastFrame() ?? '', 1);
				return middle.includes('greeting');
			},
			5_000,
			50,
		);

		// Switch to prompts (p) — should show error
		await pressKey(instance, 'p');
		await waitFor(
			() => {
				const middle = paneText(instance?.lastFrame() ?? '', 1);
				return middle.includes('failed to list prompts');
			},
			3_000,
			50,
		);

		// Retry prompts
		await pressKey(instance, 'r');
		await waitFor(
			() => {
				const middle = paneText(instance?.lastFrame() ?? '', 1);
				return middle.includes('greet');
			},
			5_000,
			50,
		);
	});

	it('mid-session crash while Result mode is active: current result stays visible; esc returns to disabled Form', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Enter form → type → submit → land in Result mode
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));
		instance.stdin.write('hi');
		await new Promise((r) => setTimeout(r, 80));
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		const before = instance?.lastFrame() ?? '';
		const match = before.match(/pid\s+(\d+)/);
		expect(match).not.toBeNull();
		const mcpPid = Number(match?.[1]);
		process.kill(mcpPid, 'SIGKILL');

		// Left pane flips to red block, but Result is preserved on the right
		await waitFor(
			() => {
				const left = paneText(instance?.lastFrame() ?? '', 0);
				return left.includes('server exited');
			},
			3_000,
			25,
		);
		const afterRight = paneText(instance?.lastFrame() ?? '', 2);
		// Result stays visible — 'hi' echo response is still there
		expect(afterRight).toContain('Result');
		expect(afterRight).toContain('hi');

		// esc returns to Form which is now disabled with the footer
		await new Promise((r) => setTimeout(r, 100));
		instance.stdin.write('\x1b');
		await new Promise((r) => setTimeout(r, 200));
		await waitFor(
			() => {
				const right = paneText(instance?.lastFrame() ?? '', 2);
				return right.includes('server disconnected — cannot invoke');
			},
			3_000,
			50,
		);
	});

	it('list-fetch error: middle pane shows failed to list tools + r to retry; pressing r re-issues the call', async () => {
		instance = render(React.createElement(App, { path: FAIL_LIST_FIXTURE }));

		// First listTools call fails — fixture returns error; UI shows red inline
		await waitFor(
			() => {
				const middle = paneText(instance?.lastFrame() ?? '', 1);
				return middle.includes('failed to list tools') && middle.includes('r to retry');
			},
			5_000,
			50,
		);

		const middlePane = paneText(instance?.lastFrame() ?? '', 1);
		expect(middlePane).toContain('failed to list tools');
		expect(middlePane).toContain('r to retry');

		// Press r to retry — fixture's second listTools call succeeds and returns 'echo'
		await pressKey(instance, 'r');
		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'), 5_000, 50);
		expect(instance?.lastFrame() ?? '').toContain('echo');
	});

	it('invocation error: boom tool surfaces server-error red block in Result mode', async () => {
		instance = render(React.createElement(App, { path: FIXTURE_ENTRY }));

		await waitFor(() => (instance?.lastFrame() ?? '').includes('echo'));

		// Advance to `boom` (second tool in fixture list)
		await pressKey(instance, 'j');
		await waitFor(() => {
			const middle = paneText(instance?.lastFrame() ?? '', 1);
			return middle.includes('boom');
		});

		// Enter Form mode → submit (boom takes no args) → Result mode red block
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Form'));
		await pressReturn(instance);
		await waitFor(() => (instance?.lastFrame() ?? '').includes('Result'), 8_000);

		const right = paneText(instance?.lastFrame() ?? '', 2);
		// design-spec §3.5: error block; §6: 'error:' prefix
		expect(right.toLowerCase()).toContain('error:');
		expect(right).toContain('server-error');
	});
});
