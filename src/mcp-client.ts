// The MCP SDK is loaded lazily inside `connect()` — see ADR 2.
// Do NOT add a static `import` of `@modelcontextprotocol/sdk` at module top-level;
// even `import type` at value position would leak into TS emit. Types below are structural.

export type JSONSchema = Record<string, unknown>;

export type ConnectionInfo = {
	path: string;
	transport: 'stdio';
	pid: number;
};

export type Capability = {
	name: string;
	description?: string;
	schema: JSONSchema;
};

export type McpError =
	| { kind: 'server-error'; code: number; message: string; data?: unknown }
	| { kind: 'timeout' }
	| { kind: 'disconnected' };

export type InvokeResult = { ok: true; result: unknown } | { ok: false; error: McpError };

export interface McpClient {
	connect(path: string): Promise<ConnectionInfo>;
	listTools(): Promise<Capability[]>;
	listResources(): Promise<Capability[]>;
	listPrompts(): Promise<Capability[]>;
	invoke(name: string, args: unknown): Promise<InvokeResult>;
	disconnect(): Promise<void>;
	onDisconnect(cb: (reason: McpError) => void): void;
}

const INITIALIZE_TIMEOUT_MS = 5_000;
const GRACEFUL_SHUTDOWN_WAIT_MS = 2_000;
const SIGTERM_WAIT_MS = 1_000;
const SIGKILL_WAIT_MS = 500;

type SdkTransport = {
	pid: number | null;
	onclose?: () => void;
	onerror?: (err: Error) => void;
	close(): Promise<void>;
};

type SdkClient = {
	connect(transport: SdkTransport): Promise<void>;
	listTools(): Promise<{
		tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
	}>;
};

type TimeoutMarker = { __argusTimeout: true };

function isNodeScript(path: string): boolean {
	return /\.(mjs|cjs|js)$/i.test(path);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

function normalizeConnectError(err: unknown): McpError {
	if (
		isRecord(err) &&
		typeof err.kind === 'string' &&
		(err.kind === 'server-error' || err.kind === 'timeout' || err.kind === 'disconnected')
	) {
		return err as McpError;
	}
	const message = err instanceof Error ? err.message : String(err);
	return { kind: 'server-error', code: -32000, message };
}

function withInitializeTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const marker: TimeoutMarker = { __argusTimeout: true };
			reject(marker);
		}, ms);
		timer.unref?.();
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function isTimeoutMarker(err: unknown): err is TimeoutMarker {
	return isRecord(err) && err.__argusTimeout === true;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!pidAlive(pid)) return true;
		await new Promise((r) => {
			const t = setTimeout(r, 25);
			t.unref?.();
		});
	}
	return !pidAlive(pid);
}

function safeSignal(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Already gone — nothing to do.
	}
}

export function createMcpClient(): McpClient {
	let transport: SdkTransport | null = null;
	let client: SdkClient | null = null;
	let connectedPid: number | null = null;
	let disconnectInitiated = false;
	let disconnectFired = false;
	const disconnectListeners: Array<(reason: McpError) => void> = [];

	const fireDisconnect = (reason: McpError): void => {
		if (disconnectFired) return;
		disconnectFired = true;
		for (const listener of disconnectListeners) {
			try {
				listener(reason);
			} catch {
				// Listener errors must not break the client.
			}
		}
	};

	return {
		async connect(inputPath: string): Promise<ConnectionInfo> {
			if (client) {
				throw new Error('mcp-client is already connected');
			}
			disconnectInitiated = false;
			disconnectFired = false;

			const [clientMod, stdioMod] = await Promise.all([
				import('@modelcontextprotocol/sdk/client/index.js'),
				import('@modelcontextprotocol/sdk/client/stdio.js'),
			]);
			const { Client } = clientMod as unknown as {
				Client: new (
					info: { name: string; version: string },
					opts: { capabilities: Record<string, unknown> },
				) => SdkClient;
			};
			const { StdioClientTransport } = stdioMod as unknown as {
				StdioClientTransport: new (params: {
					command: string;
					args?: string[];
					stderr?: 'pipe' | 'ignore' | 'inherit';
				}) => SdkTransport;
			};

			const useNode = isNodeScript(inputPath);
			const command = useNode ? process.execPath : inputPath;
			const args = useNode ? [inputPath] : [];

			const spawnedTransport = new StdioClientTransport({ command, args, stderr: 'pipe' });
			const spawnedClient = new Client({ name: 'argus', version: '0.0.1' }, { capabilities: {} });

			spawnedTransport.onclose = () => {
				if (!disconnectInitiated) {
					fireDisconnect({ kind: 'disconnected' });
				}
			};

			try {
				await withInitializeTimeout(spawnedClient.connect(spawnedTransport), INITIALIZE_TIMEOUT_MS);
			} catch (err: unknown) {
				const capturedPid = typeof spawnedTransport.pid === 'number' ? spawnedTransport.pid : null;
				try {
					await Promise.race([
						spawnedTransport.close(),
						new Promise<void>((r) => {
							const t = setTimeout(r, 500);
							t.unref?.();
						}),
					]);
				} catch {
					// Cleanup errors are swallowed — the caller sees the original failure.
				}
				if (capturedPid !== null && capturedPid > 0 && pidAlive(capturedPid)) {
					safeSignal(capturedPid, 'SIGKILL');
				}
				if (isTimeoutMarker(err)) {
					throw { kind: 'timeout' } satisfies McpError;
				}
				throw normalizeConnectError(err);
			}

			transport = spawnedTransport;
			client = spawnedClient;
			connectedPid = typeof spawnedTransport.pid === 'number' ? spawnedTransport.pid : -1;
			return { path: inputPath, transport: 'stdio', pid: connectedPid };
		},

		async listTools(): Promise<Capability[]> {
			if (!client) {
				throw { kind: 'disconnected' } satisfies McpError;
			}
			const response = await client.listTools();
			return response.tools.map((t) => ({
				name: t.name,
				description: t.description,
				schema: (t.inputSchema ?? {}) as JSONSchema,
			}));
		},

		async listResources(): Promise<Capability[]> {
			throw new Error('not-implemented');
		},

		async listPrompts(): Promise<Capability[]> {
			throw new Error('not-implemented');
		},

		async invoke(_name: string, _args: unknown): Promise<InvokeResult> {
			throw new Error('not-implemented');
		},

		async disconnect(): Promise<void> {
			if (!transport) return;
			disconnectInitiated = true;

			const capturedTransport = transport;
			const capturedPid = connectedPid;
			transport = null;
			client = null;
			connectedPid = null;

			try {
				await Promise.race([
					capturedTransport.close(),
					new Promise<void>((r) => {
						const t = setTimeout(r, GRACEFUL_SHUTDOWN_WAIT_MS);
						t.unref?.();
					}),
				]);
			} catch {
				// close() errors are non-fatal — we escalate below via pid.
			}

			if (capturedPid !== null && capturedPid > 0) {
				if (await waitForPidGone(capturedPid, GRACEFUL_SHUTDOWN_WAIT_MS)) return;
				safeSignal(capturedPid, 'SIGTERM');
				if (await waitForPidGone(capturedPid, SIGTERM_WAIT_MS)) return;
				safeSignal(capturedPid, 'SIGKILL');
				await waitForPidGone(capturedPid, SIGKILL_WAIT_MS);
			}
		},

		onDisconnect(cb: (reason: McpError) => void): void {
			disconnectListeners.push(cb);
		},
	};
}
