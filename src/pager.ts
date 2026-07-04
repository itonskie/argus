import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

export type PagerCommand = { command: string; args: string[] };

export type SpawnPagerOptions = {
	env?: NodeJS.ProcessEnv;
	// Test hooks — production callers pass none of these.
	stdio?: SpawnOptions['stdio'];
	onChild?: (child: ChildProcess) => void;
};

export type SpawnPagerResult = { exitCode: number | null };

export function resolvePagerCommand(env: NodeJS.ProcessEnv): PagerCommand {
	const raw = typeof env.PAGER === 'string' ? env.PAGER.trim() : '';
	if (raw.length === 0) return { command: 'less', args: [] };
	const parts = raw.split(/\s+/);
	const [command, ...args] = parts;
	return { command: command as string, args };
}

export function spawnPager(
	payload: string,
	options: SpawnPagerOptions = {},
): Promise<SpawnPagerResult> {
	const env = options.env ?? process.env;
	const { command, args } = resolvePagerCommand(env);
	// Default stdio: pipe stdin for the payload, hand stdout + stderr straight
	// to the terminal so the pager owns the screen. Ink resumes rendering once
	// the pager exits (its use of the alt-screen buffer restores prior output).
	const stdio: SpawnOptions['stdio'] = options.stdio ?? ['pipe', 'inherit', 'inherit'];
	return new Promise<SpawnPagerResult>((resolve, reject) => {
		const child = spawn(command, args, { stdio });
		options.onChild?.(child);
		child.on('error', (err) => {
			reject(err);
		});
		child.on('exit', (code) => {
			resolve({ exitCode: code });
		});
		child.stdin?.end(payload);
	});
}
