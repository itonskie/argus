import { describe, expect, it } from 'vitest';
import { readUiEnv } from '../src/env.js';

describe('readUiEnv', () => {
	it('defaults to all-false when no relevant vars set', () => {
		const flags = readUiEnv({});
		expect(flags).toEqual({ noColor: false, reducedMotion: false, ascii: false });
	});

	it('NO_COLOR: any non-empty value flips noColor on (no-color.org spec)', () => {
		expect(readUiEnv({ NO_COLOR: '1' }).noColor).toBe(true);
		expect(readUiEnv({ NO_COLOR: 'yes' }).noColor).toBe(true);
		expect(readUiEnv({ NO_COLOR: 'true' }).noColor).toBe(true);
	});

	it('NO_COLOR: empty string does NOT enable noColor', () => {
		expect(readUiEnv({ NO_COLOR: '' }).noColor).toBe(false);
	});

	it('PREFERS_REDUCED_MOTION: any non-empty value enables reducedMotion', () => {
		expect(readUiEnv({ PREFERS_REDUCED_MOTION: '1' }).reducedMotion).toBe(true);
		expect(readUiEnv({ PREFERS_REDUCED_MOTION: 'reduce' }).reducedMotion).toBe(true);
		expect(readUiEnv({ PREFERS_REDUCED_MOTION: '' }).reducedMotion).toBe(false);
	});

	it('ARGUS_ASCII: only literal "1" enables ascii mode', () => {
		expect(readUiEnv({ ARGUS_ASCII: '1' }).ascii).toBe(true);
		expect(readUiEnv({ ARGUS_ASCII: 'true' }).ascii).toBe(false);
		expect(readUiEnv({ ARGUS_ASCII: '' }).ascii).toBe(false);
	});

	it('flags combine independently', () => {
		expect(readUiEnv({ NO_COLOR: '1', ARGUS_ASCII: '1', PREFERS_REDUCED_MOTION: '1' })).toEqual({
			noColor: true,
			reducedMotion: true,
			ascii: true,
		});
	});
});
