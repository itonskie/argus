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
	uri?: string;
	mimeType?: string;
};

export type McpError =
	| { kind: 'server-error'; code: number; message: string; data?: unknown }
	| { kind: 'timeout' }
	| { kind: 'disconnected'; exitCode?: number | null; signal?: NodeJS.Signals | null };

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
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_WAIT_MS = 2_000;
const SIGTERM_WAIT_MS = 1_000;
const SIGKILL_WAIT_MS = 500;

type SdkTransport = {
	pid: number | null;
	onclose?: () => void;
	onerror?: (err: Error) => void;
	close(): Promise<void>;
	// SDK-internal — reached into to capture (exitCode, signal) on unexpected
	// child exit. The SDK's `onclose` callback discards both, so this is our
	// only hook. Guarded — if the SDK ever renames or removes this field the
	// exit-info capture degrades to `undefined` rather than breaking.
	_process?: {
		on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	};
};

type SdkPromptArgument = {
	name: string;
	description?: string;
	required?: boolean;
};

type SdkCallToolResult = {
	content?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
};

type SdkClient = {
	connect(transport: SdkTransport): Promise<void>;
	listTools(): Promise<{
		tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
	}>;
	listResources(): Promise<{
		resources: Array<{
			name: string;
			description?: string;
			uri: string;
			mimeType?: string;
		}>;
	}>;
	listPrompts(): Promise<{
		prompts: Array<{
			name: string;
			description?: string;
			arguments?: SdkPromptArgument[];
		}>;
	}>;
	callTool(params: { name: string; arguments?: unknown }): Promise<SdkCallToolResult>;
};

function promptArgsToSchema(args: SdkPromptArgument[] | undefined): JSONSchema {
	const properties: Record<string, JSONSchema> = {};
	const required: string[] = [];
	for (const arg of args ?? []) {
		const field: JSONSchema = { type: 'string' };
		if (typeof arg.description === 'string' && arg.description.length > 0) {
			field.description = arg.description;
		}
		properties[arg.name] = field;
		if (arg.required === true) required.push(arg.name);
	}
	const schema: JSONSchema = { type: 'object', properties };
	if (required.length > 0) schema.required = required;
	return schema;
}

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

function normalizeInvokeError(err: unknown): McpError {
	// SDK's McpError shape: { code: number, message: string, data?: unknown }.
	// We surface those directly. Anything else becomes a generic server-error.
	if (isRecord(err) && typeof err.code === 'number' && typeof err.message === 'string') {
		return {
			kind: 'server-error',
			code: err.code,
			message: err.message,
			data: err.data,
		};
	}
	const message = err instanceof Error ? err.message : String(err);
	return { kind: 'server-error', code: -32000, message };
}

function extractErrorMessage(result: { content?: unknown }): string {
	// isError: true results ship the error text as a `text` content block.
	if (Array.isArray(result.content)) {
		for (const block of result.content) {
			if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
				return block.text;
			}
		}
	}
	return 'tool returned an error';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

export type McpClientOptions = {
	invokeTimeoutMs?: number;
};

export function createMcpClient(options: McpClientOptions = {}): McpClient {
	const invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
	let transport: SdkTransport | null = null;
	let client: SdkClient | null = null;
	let connectedPid: number | null = null;
	let disconnectInitiated = false;
	let disconnectFired = false;
	let capturedExitCode: number | null | undefined;
	let capturedSignal: NodeJS.Signals | null | undefined;
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
			capturedExitCode = undefined;
			capturedSignal = undefined;

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
					const reason: McpError = { kind: 'disconnected' };
					if (capturedExitCode !== undefined) reason.exitCode = capturedExitCode;
					if (capturedSignal !== undefined) reason.signal = capturedSignal;
					fireDisconnect(reason);
				}
			};

			try {
				await withTimeout(spawnedClient.connect(spawnedTransport), INITIALIZE_TIMEOUT_MS);
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
			// The SDK's `onclose` callback discards the child's exit info; hook
			// the underlying process here so `disconnected` errors can carry
			// `exitCode` / `signal` for the UI (design-spec §3.1 red block).
			const childProcess = spawnedTransport._process;
			if (childProcess && typeof childProcess.on === 'function') {
				childProcess.on('exit', (code, signal) => {
					capturedExitCode = code;
					capturedSignal = signal;
				});
			}
			return { path: inputPath, transport: 'stdio', pid: connectedPid };
		},

		async listTools(): Promise<Capability[]> {
			if (!client) {
				throw { kind: 'disconnected' } satisfies McpError;
			}
			try {
				const response = await client.listTools();
				return response.tools.map((t) => ({
					name: t.name,
					description: t.description,
					schema: (t.inputSchema ?? {}) as JSONSchema,
				}));
			} catch (err) {
				throw normalizeInvokeError(err);
			}
		},

		async listResources(): Promise<Capability[]> {
			if (!client) {
				throw { kind: 'disconnected' } satisfies McpError;
			}
			try {
				const response = await client.listResources();
				return response.resources.map((r) => {
					const cap: Capability = {
						name: r.name,
						schema: {},
						uri: r.uri,
					};
					if (typeof r.description === 'string') cap.description = r.description;
					if (typeof r.mimeType === 'string') cap.mimeType = r.mimeType;
					return cap;
				});
			} catch (err) {
				throw normalizeInvokeError(err);
			}
		},

		async listPrompts(): Promise<Capability[]> {
			if (!client) {
				throw { kind: 'disconnected' } satisfies McpError;
			}
			try {
				const response = await client.listPrompts();
				return response.prompts.map((p) => {
					const cap: Capability = {
						name: p.name,
						schema: promptArgsToSchema(p.arguments),
					};
					if (typeof p.description === 'string') cap.description = p.description;
					return cap;
				});
			} catch (err) {
				throw normalizeInvokeError(err);
			}
		},

		async invoke(name: string, args: unknown): Promise<InvokeResult> {
			if (!client) {
				return { ok: false, error: { kind: 'disconnected' } };
			}
			const activeClient = client;
			try {
				const result = await withTimeout(
					activeClient.callTool({ name, arguments: args as Record<string, unknown> | undefined }),
					invokeTimeoutMs,
				);
				if (result && result.isError === true) {
					return {
						ok: false,
						error: {
							kind: 'server-error',
							code: -32603, // ErrorCode.InternalError — tool handler surfaced an error
							message: extractErrorMessage(result),
						},
					};
				}
				return { ok: true, result };
			} catch (err: unknown) {
				if (isTimeoutMarker(err)) {
					return { ok: false, error: { kind: 'timeout' } };
				}
				if (disconnectFired) {
					return { ok: false, error: { kind: 'disconnected' } };
				}
				return { ok: false, error: normalizeInvokeError(err) };
			}
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
