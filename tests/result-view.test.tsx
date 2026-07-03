import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { InvokeResult } from '../src/mcp-client.js';
import { ResultView } from '../src/result-view.js';

function frameOf(result: InvokeResult, scroll = 0): string {
	const instance = render(React.createElement(ResultView, { result, scroll }));
	const frame = instance.lastFrame() ?? '';
	instance.unmount();
	return frame;
}

describe('ResultView', () => {
	it('renders "(empty response)" for null', () => {
		const frame = frameOf({ ok: true, result: null });
		expect(frame).toContain('(empty response)');
	});

	it('renders "(empty response)" for {}', () => {
		const frame = frameOf({ ok: true, result: {} });
		expect(frame).toContain('(empty response)');
	});

	it('renders a [text] prefix for a single-text-block MCP result', () => {
		const frame = frameOf({
			ok: true,
			result: { content: [{ type: 'text', text: 'hello world' }] },
		});
		expect(frame).toContain('[text]');
		expect(frame).toContain('hello world');
	});

	it('renders a [base64] prefix for a single image content block', () => {
		const frame = frameOf({
			ok: true,
			result: {
				content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
			},
		});
		expect(frame).toContain('[base64]');
		expect(frame).toContain('image/png');
	});

	it('pretty-prints structuredContent JSON', () => {
		const frame = frameOf({
			ok: true,
			result: {
				content: [],
				structuredContent: { total: 42, name: 'x' },
			},
		});
		// keys, numbers, strings all present
		expect(frame).toContain('total');
		expect(frame).toContain('42');
		expect(frame).toContain('"x"');
	});

	it('renders an "invocation timed out" red block on timeout', () => {
		const frame = frameOf({ ok: false, error: { kind: 'timeout' } });
		expect(frame).toContain('error:');
		expect(frame).toContain('timed out');
	});

	it('renders a "server disconnected" red block on disconnected', () => {
		const frame = frameOf({ ok: false, error: { kind: 'disconnected' } });
		expect(frame).toContain('error:');
		expect(frame).toContain('disconnected');
	});

	it('renders server-error message and code', () => {
		const frame = frameOf({
			ok: false,
			error: { kind: 'server-error', code: -32603, message: 'boom went the tool' },
		});
		expect(frame).toContain('error:');
		expect(frame).toContain('-32603');
		expect(frame).toContain('boom went the tool');
	});

	it('shows a size-warning banner when the pretty-printed JSON is >= 20 KB', () => {
		// Build a payload whose JSON serialization is comfortably over 20 KB.
		const big: Record<string, string> = {};
		for (let i = 0; i < 300; i++) big[`key_${i}`] = 'x'.repeat(100);
		const frame = frameOf({ ok: true, result: { content: [], structuredContent: big } });
		expect(frame.toLowerCase()).toContain('warning');
		expect(frame).toContain('KB');
	});
});
