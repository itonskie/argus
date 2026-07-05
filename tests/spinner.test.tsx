import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiEnv } from '../src/env.js';
import { Spinner } from '../src/spinner.js';

type Instance = ReturnType<typeof render>;

const DEFAULT_ENV: UiEnv = { noColor: false, reducedMotion: false, ascii: false };

describe('Spinner', () => {
	let instance: Instance | undefined;

	afterEach(() => {
		if (instance) {
			instance.unmount();
			instance = undefined;
		}
	});

	it('default env: renders a braille glyph (design-spec §5.2)', () => {
		instance = render(React.createElement(Spinner, { env: DEFAULT_ENV }));
		expect(instance.lastFrame() ?? '').toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	});

	it('ascii env: renders one of | / - \\', () => {
		instance = render(React.createElement(Spinner, { env: { ...DEFAULT_ENV, ascii: true } }));
		const frame = instance.lastFrame() ?? '';
		expect(frame).toMatch(/[|/\-\\]/);
		// No braille under ascii
		expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	});

	it('reducedMotion env: renders static "…"', () => {
		instance = render(
			React.createElement(Spinner, { env: { ...DEFAULT_ENV, reducedMotion: true } }),
		);
		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('…');
		expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		expect(frame).not.toMatch(/[|/\-\\]/);
	});

	it('reducedMotion wins over ascii (both set)', () => {
		instance = render(
			React.createElement(Spinner, {
				env: { ...DEFAULT_ENV, reducedMotion: true, ascii: true },
			}),
		);
		const frame = instance.lastFrame() ?? '';
		expect(frame).toContain('…');
	});
});
