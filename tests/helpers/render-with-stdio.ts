import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';

// ink-testing-library hard-codes `columns` to 100 and provides no `rows`, so we
// cannot drive the size-gate or a resize with it. This helper mirrors that
// library's shape but exposes a mutable size + a `resize()` that emits the same
// 'resize' event Ink's `useWindowSize` listens for.

class MockStdout extends EventEmitter {
	columns: number;
	rows: number;
	frames: string[] = [];
	private _lastFrame?: string;

	constructor({ columns, rows }: { columns: number; rows: number }) {
		super();
		this.columns = columns;
		this.rows = rows;
	}

	write = (frame: string): void => {
		this.frames.push(frame);
		this._lastFrame = frame;
	};

	lastFrame = (): string | undefined => this._lastFrame;

	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.emit('resize');
	}
}

class MockStderr extends EventEmitter {
	frames: string[] = [];
	private _lastFrame?: string;
	write = (frame: string): void => {
		this.frames.push(frame);
		this._lastFrame = frame;
	};
	lastFrame = (): string | undefined => this._lastFrame;
}

class MockStdin extends EventEmitter {
	isTTY = true;
	data: string | null = null;

	write = (data: string): void => {
		this.data = data;
		this.emit('readable');
		this.emit('data', data);
	};
	setEncoding(): void {}
	setRawMode(): void {}
	resume(): void {}
	pause(): void {}
	ref(): void {}
	unref(): void {}
	read = (): string | null => {
		const { data } = this;
		this.data = null;
		return data;
	};
}

export type RenderWithStdioOptions = {
	columns: number;
	rows: number;
};

export type RenderWithStdioInstance = {
	rerender: (tree: ReactElement) => void;
	unmount: () => void;
	cleanup: () => void;
	stdout: MockStdout;
	stderr: MockStderr;
	stdin: MockStdin;
	frames: string[];
	lastFrame: () => string | undefined;
};

export function renderWithStdio(
	tree: ReactElement,
	opts: RenderWithStdioOptions,
): RenderWithStdioInstance {
	const stdout = new MockStdout(opts);
	const stderr = new MockStderr();
	const stdin = new MockStdin();

	const instance = inkRender(tree, {
		// biome-ignore lint/suspicious/noExplicitAny: mock stream shape matches what Ink reads.
		stdout: stdout as any,
		// biome-ignore lint/suspicious/noExplicitAny: mock stream shape matches what Ink reads.
		stderr: stderr as any,
		// biome-ignore lint/suspicious/noExplicitAny: mock stream shape matches what Ink reads.
		stdin: stdin as any,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});

	return {
		rerender: instance.rerender,
		unmount: instance.unmount,
		cleanup: instance.cleanup,
		stdout,
		stderr,
		stdin,
		frames: stdout.frames,
		lastFrame: () => stdout.lastFrame(),
	};
}
