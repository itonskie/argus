import { describe, expect, it } from 'vitest';
import { resolvePagerCommand, spawnPager } from '../src/pager.js';

describe('pager', () => {
	it('resolvePagerCommand: falls back to `less` when PAGER is unset or empty', () => {
		expect(resolvePagerCommand({})).toEqual({ command: 'less', args: [] });
		expect(resolvePagerCommand({ PAGER: '' })).toEqual({ command: 'less', args: [] });
		expect(resolvePagerCommand({ PAGER: '   ' })).toEqual({ command: 'less', args: [] });
	});

	it('resolvePagerCommand: uses PAGER when set, splitting on whitespace for flags', () => {
		expect(resolvePagerCommand({ PAGER: 'more' })).toEqual({ command: 'more', args: [] });
		expect(resolvePagerCommand({ PAGER: 'less -R' })).toEqual({ command: 'less', args: ['-R'] });
	});

	it('pipes the payload to stdin of $PAGER (PAGER=cat, payload echoed to stdout)', async () => {
		const captured: string[] = [];
		const result = await spawnPager('hello from argus', {
			env: { PAGER: 'cat' },
			// Route cat's stdout to a pipe so the test can read what stdin echoed.
			stdio: ['pipe', 'pipe', 'ignore'],
			onChild: (child) => {
				child.stdout?.setEncoding('utf8');
				child.stdout?.on('data', (chunk: string) => captured.push(chunk));
			},
		});
		expect(result.exitCode).toBe(0);
		expect(captured.join('')).toBe('hello from argus');
	});
});
