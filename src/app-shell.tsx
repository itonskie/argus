import { basename } from 'node:path';
import { Box, Text, useApp, useInput, useStdin, useWindowSize } from 'ink';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readUiEnv, type UiEnv } from './env.js';
import type { FormField, FormFieldKind, FormSpec, FormState, SubmitResult } from './form-engine.js';
import {
	type Capability,
	type ConnectionInfo,
	createMcpClient,
	type InvokeResult,
	type JSONSchema,
	type McpClient,
	type McpError,
} from './mcp-client.js';
import { spawnPager } from './pager.js';
import { ResultView, serializeResultForPager } from './result-view.js';
import { Spinner } from './spinner.js';

const MIN_COLUMNS = 80;
const MIN_ROWS = 24;

// design-spec §1: three axes of border style — ARGUS_ASCII takes precedence,
// then NO_COLOR uses bold-style Unicode to distinguish focus without color,
// else the default single-line borders (with cyan focus color).
function borderStyleFor(env: UiEnv, focused: boolean): 'classic' | 'single' | 'bold' {
	if (env.ascii) return 'classic';
	if (env.noColor && focused) return 'bold';
	return 'single';
}

// Focus color — cyan when we have color, undefined otherwise (design-spec §1).
function focusBorderColor(env: UiEnv, focused: boolean): string | undefined {
	if (!focused) return undefined;
	if (env.noColor) return undefined;
	return 'cyan';
}

// Any semantic color goes through this — NO_COLOR strips it, everything else
// passes through unchanged. The paired text prefix (`error:`, `● connected`,
// etc.) is what carries the meaning without color.
function semanticColor(env: UiEnv, color: string): string | undefined {
	return env.noColor ? undefined : color;
}

type ConnectionState =
	| { kind: 'connecting' }
	| { kind: 'connected'; info: ConnectionInfo }
	| { kind: 'error'; error: McpError };

type Pane = 'left' | 'middle' | 'right';

type Tab = 'tools' | 'resources' | 'prompts';

type ListStatus = 'idle' | 'loading' | 'loaded' | 'error';

type TabState = {
	items: Capability[];
	status: ListStatus;
	selectedIndex: number;
	errorMessage?: string;
};

type RightMode =
	| { kind: 'preview' }
	| { kind: 'form'; ctx: FormCtx }
	| { kind: 'invoking'; ctx: FormCtx }
	| { kind: 'result'; ctx: FormCtx; result: InvokeResult };

type FormCtx = {
	tab: Tab;
	tool: Capability;
	schema: JSONSchema;
	spec: FormSpec;
	state: FormState;
	errors: Array<{ path: string[]; message: string }>;
	focusedFieldIndex: number;
};

export type AppProps = {
	path: string;
	// Injectable for tests; production callers omit and we read the live env.
	env?: NodeJS.ProcessEnv;
};

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function normalizeThrown(err: unknown): McpError {
	if (err && typeof err === 'object' && 'kind' in err) {
		const k = (err as { kind: unknown }).kind;
		if (k === 'server-error' || k === 'timeout' || k === 'disconnected') {
			return err as McpError;
		}
	}
	const message = err instanceof Error ? err.message : String(err);
	return { kind: 'server-error', code: -32000, message };
}

function mcpErrorMessage(err: unknown): string {
	const norm = normalizeThrown(err);
	if (norm.kind === 'server-error') return norm.message;
	if (norm.kind === 'timeout') return 'timed out';
	return 'server disconnected';
}

function formatExitDetail(err: McpError): string {
	if (err.kind !== 'disconnected') return '';
	if (typeof err.exitCode === 'number') return `code ${err.exitCode}`;
	if (typeof err.signal === 'string' && err.signal.length > 0) return `signal ${err.signal}`;
	return 'code unknown';
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

type SchemaField = {
	name: string;
	type: string;
	required: boolean;
};

function schemaFields(schema: JSONSchema): SchemaField[] {
	if (!isRecord(schema)) return [];
	const properties = schema.properties;
	if (!isRecord(properties)) return [];
	const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
	const requiredSet = new Set(required.filter((v): v is string => typeof v === 'string'));
	const fields: SchemaField[] = [];
	for (const [name, raw] of Object.entries(properties)) {
		const type = isRecord(raw) && typeof raw.type === 'string' ? (raw.type as string) : 'unknown';
		fields.push({ name, type, required: requiredSet.has(name) });
	}
	return fields;
}

type FocusRow =
	| { kind: 'primitive'; field: FormField }
	| { kind: 'raw-json'; field: FormField }
	| { kind: 'array-item'; field: FormField; index: number }
	| { kind: 'array-add'; field: FormField };

function seedInitialState(fields: FormField[], state: FormState): void {
	for (const field of fields) {
		const key = field.path.join('.');
		const kind = field.fieldKind;
		if (kind.kind === 'object') {
			seedInitialState(kind.fields, state);
			continue;
		}
		if (kind.kind === 'array-of-primitives') {
			state[key] = [''];
			continue;
		}
		if (kind.kind === 'raw-json') {
			state[key] = '';
			continue;
		}
		if (field.default !== undefined) {
			state[key] = String(field.default);
		} else {
			state[key] = '';
		}
	}
}

function initialStateFromSpec(spec: FormSpec): FormState {
	const state: FormState = {};
	seedInitialState(spec.fields, state);
	return state;
}

function collectFocusRows(field: FormField, state: FormState, rows: FocusRow[]): void {
	const kind = field.fieldKind;
	if (kind.kind === 'object') {
		for (const child of kind.fields) collectFocusRows(child, state, rows);
		return;
	}
	if (kind.kind === 'array-of-primitives') {
		const key = field.path.join('.');
		const raw = state[key];
		const arr = Array.isArray(raw) ? (raw as unknown[]) : [];
		for (let i = 0; i < arr.length; i++) {
			rows.push({ kind: 'array-item', field, index: i });
		}
		rows.push({ kind: 'array-add', field });
		return;
	}
	if (kind.kind === 'raw-json') {
		rows.push({ kind: 'raw-json', field });
		return;
	}
	rows.push({ kind: 'primitive', field });
}

function focusRowsForSpec(spec: FormSpec, state: FormState): FocusRow[] {
	const rows: FocusRow[] = [];
	for (const field of spec.fields) collectFocusRows(field, state, rows);
	return rows;
}

function readArray(state: FormState, key: string): string[] {
	const raw = state[key];
	if (!Array.isArray(raw)) return [];
	return raw.map((v) => (typeof v === 'string' ? v : ''));
}

// Inverse of form-engine's assemblePayload: takes a submitted payload and
// pushes each value back into the `FormState` shape the form renders from,
// stringifying primitives / arrays / raw-JSON blobs. Used by arrow-up recall.
function populateStateFromPayload(
	field: FormField,
	payloadNode: Record<string, unknown>,
	state: FormState,
): void {
	const value = payloadNode[field.label];
	const key = field.path.join('.');
	const kind = field.fieldKind;
	if (kind.kind === 'object') {
		if (isRecord(value)) {
			for (const child of kind.fields) populateStateFromPayload(child, value, state);
		}
		return;
	}
	if (kind.kind === 'array-of-primitives') {
		if (Array.isArray(value)) {
			state[key] = value.map((v) => String(v));
		}
		return;
	}
	if (kind.kind === 'raw-json') {
		if (value !== undefined) {
			state[key] = JSON.stringify(value, null, 2);
		}
		return;
	}
	if (value !== undefined) state[key] = String(value);
}

function payloadToFormState(spec: FormSpec, payload: unknown): FormState {
	const state = initialStateFromSpec(spec);
	if (!isRecord(payload)) return state;
	for (const field of spec.fields) populateStateFromPayload(field, payload, state);
	return state;
}

// The focused row's value is considered empty when its underlying `FormState`
// slot is empty string / missing. Only then does ↑ trigger recall — non-empty
// fields must not be clobbered by a stray arrow-key press.
function isFocusedFieldEmpty(row: FocusRow, state: FormState): boolean {
	const key = row.field.path.join('.');
	if (row.kind === 'array-item') {
		const arr = readArray(state, key);
		return (arr[row.index] ?? '') === '';
	}
	if (row.kind === 'array-add') return true;
	const v = state[key];
	return typeof v !== 'string' || v === '';
}

// form-engine is lazy-loaded (ADR 2) — schemaToForm/submit both live behind
// dynamic imports below.
async function loadFormEngine(): Promise<{
	schemaToForm: (schema: JSONSchema) => FormSpec;
	submit: (schema: JSONSchema, state: FormState) => Promise<SubmitResult>;
}> {
	const mod = await import('./form-engine.js');
	return { schemaToForm: mod.schemaToForm, submit: mod.submit };
}

export function App({ path, env }: AppProps): React.ReactElement {
	const { exit } = useApp();
	const { stdin, setRawMode, isRawModeSupported } = useStdin();
	const { columns, rows } = useWindowSize();
	const uiEnv: UiEnv = useMemo(() => readUiEnv(env), [env]);
	const clientRef = useRef<McpClient | null>(null);
	const shuttingDownRef = useRef(false);
	// In-session last-args cache for ↑ recall (design-spec §4.2 / ADR 3).
	// Ref, not state — we don't want re-renders when it moves; recall reads it
	// synchronously inside the keypress handler.
	const lastInvocationRef = useRef<{ tool: string; args: unknown } | null>(null);
	const [connState, setConnState] = useState<ConnectionState>({ kind: 'connecting' });
	const [tools, setTools] = useState<TabState>({
		items: [],
		status: 'loading',
		selectedIndex: 0,
	});
	const [resources, setResources] = useState<TabState>({
		items: [],
		status: 'idle',
		selectedIndex: 0,
	});
	const [prompts, setPrompts] = useState<TabState>({
		items: [],
		status: 'idle',
		selectedIndex: 0,
	});
	const [activeTab, setActiveTab] = useState<Tab>('tools');
	const [focusedPane, setFocusedPane] = useState<Pane>('middle');
	const [previewScroll, setPreviewScroll] = useState(0);
	const [rightMode, setRightMode] = useState<RightMode>({ kind: 'preview' });
	const [resultScroll, setResultScroll] = useState(0);

	useEffect(() => {
		const client = createMcpClient();
		clientRef.current = client;
		let cancelled = false;

		client.onDisconnect((reason) => {
			if (shuttingDownRef.current || cancelled) return;
			setConnState({ kind: 'error', error: reason });
		});

		(async () => {
			try {
				const info = await client.connect(path);
				if (cancelled) return;
				setConnState({ kind: 'connected', info });

				setTools((s) => ({ ...s, status: 'loading' }));
				setResources((s) => ({ ...s, status: 'loading' }));
				setPrompts((s) => ({ ...s, status: 'loading' }));

				const [toolsRes, resourcesRes, promptsRes] = await Promise.allSettled([
					client.listTools(),
					client.listResources(),
					client.listPrompts(),
				]);
				if (cancelled) return;

				if (toolsRes.status === 'fulfilled') {
					setTools({ items: toolsRes.value, status: 'loaded', selectedIndex: 0 });
				} else {
					setTools((s) => ({
						...s,
						status: 'error',
						errorMessage: mcpErrorMessage(toolsRes.reason),
					}));
				}
				if (resourcesRes.status === 'fulfilled') {
					setResources({
						items: resourcesRes.value,
						status: 'loaded',
						selectedIndex: 0,
					});
				} else {
					setResources((s) => ({
						...s,
						status: 'error',
						errorMessage: mcpErrorMessage(resourcesRes.reason),
					}));
				}
				if (promptsRes.status === 'fulfilled') {
					setPrompts({
						items: promptsRes.value,
						status: 'loaded',
						selectedIndex: 0,
					});
				} else {
					setPrompts((s) => ({
						...s,
						status: 'error',
						errorMessage: mcpErrorMessage(promptsRes.reason),
					}));
				}
			} catch (err) {
				if (cancelled) return;
				setConnState({ kind: 'error', error: normalizeThrown(err) });
			}
		})();

		return () => {
			cancelled = true;
			client.disconnect().catch(() => {
				// Cleanup errors on unmount are non-fatal.
			});
		};
	}, [path]);

	const quit = (): void => {
		if (shuttingDownRef.current) return;
		shuttingDownRef.current = true;
		const client = clientRef.current;
		if (client) {
			client
				.disconnect()
				.catch(() => {
					// Swallow — we're exiting anyway.
				})
				.finally(() => {
					exit();
				});
		} else {
			exit();
		}
	};

	const activeTabState =
		activeTab === 'tools' ? tools : activeTab === 'resources' ? resources : prompts;

	const setActiveTabState = (updater: (s: TabState) => TabState): void => {
		if (activeTab === 'tools') setTools(updater);
		else if (activeTab === 'resources') setResources(updater);
		else setPrompts(updater);
	};

	const retryList = async (tab: Tab): Promise<void> => {
		const client = clientRef.current;
		if (!client) return;
		if (connState.kind === 'error') return; // no point retrying against a dead server
		const setter = tab === 'tools' ? setTools : tab === 'resources' ? setResources : setPrompts;
		setter((s) => ({ ...s, status: 'loading', errorMessage: undefined }));
		try {
			const items =
				tab === 'tools'
					? await client.listTools()
					: tab === 'resources'
						? await client.listResources()
						: await client.listPrompts();
			setter({ items, status: 'loaded', selectedIndex: 0 });
		} catch (err) {
			setter((s) => ({
				...s,
				status: 'error',
				errorMessage: mcpErrorMessage(err),
			}));
		}
	};

	const enterFormMode = async (item: Capability, tab: Tab): Promise<void> => {
		const { schemaToForm } = await loadFormEngine();
		let spec: FormSpec;
		try {
			spec = schemaToForm(item.schema);
		} catch (err) {
			// Slice 6/8 boundary: schemas with fallback shapes throw. Surface as a
			// synthetic invocation error rather than crash the app.
			const message = err instanceof Error ? err.message : String(err);
			setRightMode({
				kind: 'result',
				ctx: {
					tab,
					tool: item,
					schema: item.schema,
					spec: { fields: [] },
					state: {},
					errors: [],
					focusedFieldIndex: 0,
				},
				result: {
					ok: false,
					error: { kind: 'server-error', code: -32000, message },
				},
			});
			setFocusedPane('right');
			setResultScroll(0);
			return;
		}
		const state = initialStateFromSpec(spec);
		setRightMode({
			kind: 'form',
			ctx: {
				tab,
				tool: item,
				schema: item.schema,
				spec,
				state,
				errors: [],
				focusedFieldIndex: 0,
			},
		});
		setFocusedPane('right');
	};

	const submitForm = async (ctx: FormCtx): Promise<void> => {
		const { submit } = await loadFormEngine();
		const result = await submit(ctx.schema, ctx.state);
		if (!result.valid) {
			const rows = focusRowsForSpec(ctx.spec, ctx.state);
			const firstInvalid = Math.max(
				0,
				rows.findIndex((row) => {
					const key = row.field.path.join('.');
					return result.errors.some((e) => {
						const errKey = e.path.join('.');
						return errKey === key || errKey.startsWith(`${key}.`);
					});
				}),
			);
			setRightMode({
				kind: 'form',
				ctx: {
					...ctx,
					errors: result.errors,
					focusedFieldIndex: firstInvalid,
				},
			});
			return;
		}
		setRightMode({ kind: 'invoking', ctx });
		const client = clientRef.current;
		let invokeResult: InvokeResult;
		if (!client) {
			invokeResult = { ok: false, error: { kind: 'disconnected' } };
		} else {
			invokeResult = await client.invoke(ctx.tool.name, result.payload);
		}
		if (invokeResult.ok) {
			// Successful invocation seeds the ↑ recall slot for this tool.
			lastInvocationRef.current = { tool: ctx.tool.name, args: result.payload };
		}
		setRightMode({ kind: 'result', ctx, result: invokeResult });
		setResultScroll(0);
	};

	const serverDisconnected = connState.kind === 'error' && connState.error.kind === 'disconnected';
	const initializeErrored = connState.kind === 'error' && connState.error.kind !== 'disconnected';

	useInput((input, key) => {
		// Ctrl-C always quits.
		if (key.ctrl && input === 'c') {
			quit();
			return;
		}

		// Initialize timeout (or other pre-connect error) — design-spec §4.3:
		// only `q` and Ctrl-C work; middle/right panes are disabled/hidden.
		if (initializeErrored) {
			if (input === 'q') quit();
			return;
		}

		// Form / invoking mode owns focus completely — route all input here.
		if (rightMode.kind === 'form' || rightMode.kind === 'invoking') {
			const ctx = rightMode.ctx;
			if (rightMode.kind === 'invoking') {
				// Fields are locked while the invocation is in flight.
				return;
			}
			if (serverDisconnected) {
				// design-spec §3.4: form disabled when server crashed. esc still
				// lets the user retreat to Preview so they can `q` to quit.
				if (key.escape) {
					setRightMode({ kind: 'preview' });
					setFocusedPane('middle');
				}
				return;
			}
			if (key.escape) {
				setRightMode({ kind: 'preview' });
				setFocusedPane('middle');
				return;
			}
			const rows = focusRowsForSpec(ctx.spec, ctx.state);
			if (rows.length === 0) {
				if (key.return) void submitForm(ctx);
				return;
			}
			const focusedRow = rows[Math.min(ctx.focusedFieldIndex, rows.length - 1)];
			if (!focusedRow) return;

			if (key.tab) {
				if (rows.length <= 1) return;
				const delta = key.shift ? -1 : 1;
				const next = (ctx.focusedFieldIndex + delta + rows.length) % rows.length;
				setRightMode({ kind: 'form', ctx: { ...ctx, focusedFieldIndex: next } });
				return;
			}

			// ↑ on an empty focused field → recall the last-invoked args for THIS
			// tool. Non-empty fields ignore ↑ so we never overwrite user input.
			// (design-spec §4.2)
			if (key.upArrow) {
				if (!isFocusedFieldEmpty(focusedRow, ctx.state)) return;
				const last = lastInvocationRef.current;
				if (!last || last.tool !== ctx.tool.name) return;
				const nextState = payloadToFormState(ctx.spec, last.args);
				setRightMode({ kind: 'form', ctx: { ...ctx, state: nextState, errors: [] } });
				return;
			}

			// Enter on the "add row" affordance appends a new empty row and moves
			// focus to it. Enter elsewhere submits.
			if (key.return) {
				if (focusedRow.kind === 'array-add') {
					const arrKey = focusedRow.field.path.join('.');
					const arr = readArray(ctx.state, arrKey);
					const next = [...arr, ''];
					const nextState: FormState = { ...ctx.state, [arrKey]: next };
					// Focus moves to the newly appended item (same position as the old
					// "add" row).
					setRightMode({
						kind: 'form',
						ctx: { ...ctx, state: nextState, focusedFieldIndex: ctx.focusedFieldIndex },
					});
					return;
				}
				void submitForm(ctx);
				return;
			}

			// Field editing.
			const stateKey = focusedRow.field.path.join('.');
			if (focusedRow.kind === 'array-item') {
				const arr = readArray(ctx.state, stateKey);
				const cur = arr[focusedRow.index] ?? '';
				if (key.backspace || key.delete) {
					const nextArr = [...arr];
					nextArr[focusedRow.index] = cur.slice(0, -1);
					setRightMode({
						kind: 'form',
						ctx: { ...ctx, state: { ...ctx.state, [stateKey]: nextArr } },
					});
					return;
				}
				if (input && !key.meta && !key.ctrl) {
					const nextArr = [...arr];
					nextArr[focusedRow.index] = cur + input;
					setRightMode({
						kind: 'form',
						ctx: { ...ctx, state: { ...ctx.state, [stateKey]: nextArr } },
					});
					return;
				}
				return;
			}

			// array-add row without Enter — ignore other input.
			if (focusedRow.kind === 'array-add') return;

			// primitive / raw-json rows edit a plain string.
			const cur = typeof ctx.state[stateKey] === 'string' ? (ctx.state[stateKey] as string) : '';
			if (key.backspace || key.delete) {
				const next = cur.slice(0, -1);
				setRightMode({
					kind: 'form',
					ctx: { ...ctx, state: { ...ctx.state, [stateKey]: next } },
				});
				return;
			}
			if (input && !key.meta && !key.ctrl) {
				// Any printable char (including 'q') is typed into the field. This
				// matches design-spec §5.1: q inside Form is intentionally NOT a quit —
				// so form input containing 'q' does not exit the app.
				const next = cur + input;
				setRightMode({
					kind: 'form',
					ctx: { ...ctx, state: { ...ctx.state, [stateKey]: next } },
				});
				return;
			}
			return;
		}

		// Result mode
		if (rightMode.kind === 'result') {
			if (key.escape) {
				setRightMode({ kind: 'form', ctx: rightMode.ctx });
				return;
			}
			if (input === 'j') {
				setResultScroll((n) => n + 1);
				return;
			}
			if (input === 'k') {
				setResultScroll((n) => Math.max(n - 1, 0));
				return;
			}
			if (input === 'o') {
				const payload = serializeResultForPager(rightMode.result);
				if (payload !== null) {
					// Suspend Ink's stdin handling so the pager owns the terminal:
					// drop raw mode + pause our stream, so keystrokes route to less
					// (via /dev/tty) rather than back into useInput. On pager exit,
					// restore raw mode + resume — Ink re-renders the same result frame
					// because state didn't change.
					if (isRawModeSupported) setRawMode(false);
					stdin.pause();
					spawnPager(payload)
						.catch(() => {
							// Missing binary / spawn failure — silent; user can `esc`
							// back and retry after fixing $PAGER.
						})
						.finally(() => {
							stdin.resume();
							if (isRawModeSupported) setRawMode(true);
						});
				}
				return;
			}
			if (input === 'h') {
				setRightMode({ kind: 'preview' });
				setResultScroll(0);
				setFocusedPane('middle');
				return;
			}
			if (input === 'q') {
				quit();
				return;
			}
			if (input === 't' || input === 'r' || input === 'p') {
				const nextTab: Tab = input === 't' ? 'tools' : input === 'r' ? 'resources' : 'prompts';
				setRightMode({ kind: 'preview' });
				setResultScroll(0);
				setFocusedPane('middle');
				if (nextTab !== activeTab) {
					setActiveTab(nextTab);
					setPreviewScroll(0);
				}
				return;
			}
			return;
		}

		// Preview mode (default) — the pre-Slice-7 key routing.
		if (input === 'q') {
			quit();
			return;
		}

		// `r to retry` (design-spec §3.2): if the currently visible tab failed to
		// list, `r` re-issues that list call instead of switching to the resources
		// tab. Only rebinds when the active tab is actually in error.
		if (input === 'r' && activeTabState.status === 'error' && !serverDisconnected) {
			void retryList(activeTab);
			return;
		}

		if (
			(focusedPane === 'middle' || focusedPane === 'right') &&
			(input === 't' || input === 'r' || input === 'p')
		) {
			const nextTab: Tab = input === 't' ? 'tools' : input === 'r' ? 'resources' : 'prompts';
			if (nextTab !== activeTab) {
				setActiveTab(nextTab);
				setPreviewScroll(0);
			}
			return;
		}

		if (key.return && focusedPane === 'middle') {
			const item = activeTabState.items[activeTabState.selectedIndex];
			if (item) void enterFormMode(item, activeTab);
			return;
		}

		if (input === 'j' && focusedPane === 'middle') {
			setActiveTabState((s) => ({
				...s,
				selectedIndex: s.items.length === 0 ? 0 : Math.min(s.selectedIndex + 1, s.items.length - 1),
			}));
			return;
		}
		if (input === 'k' && focusedPane === 'middle') {
			setActiveTabState((s) => ({ ...s, selectedIndex: Math.max(s.selectedIndex - 1, 0) }));
			return;
		}
		if (input === 'j' && focusedPane === 'right') {
			setPreviewScroll((n) => n + 1);
			return;
		}
		if (input === 'k' && focusedPane === 'right') {
			setPreviewScroll((n) => Math.max(n - 1, 0));
			return;
		}
		if (input === 'h') {
			if (focusedPane === 'middle') setFocusedPane('left');
			else if (focusedPane === 'right') setFocusedPane('middle');
			return;
		}
		if (input === 'l') {
			if (focusedPane === 'left') setFocusedPane('middle');
			else if (focusedPane === 'middle') setFocusedPane('right');
			return;
		}
	});

	const selectedItem =
		activeTabState.items.length > 0 && activeTabState.selectedIndex < activeTabState.items.length
			? activeTabState.items[activeTabState.selectedIndex]
			: undefined;

	// design-spec §2.3: below 80×24 we replace the layout with a single-line
	// gate. State stays mounted (App itself doesn't unmount), so focus /
	// selection are preserved when the terminal grows back.
	if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
		return <SizeGate columns={columns} rows={rows} />;
	}

	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<ConnectionPane
					path={path}
					connState={connState}
					focused={focusedPane === 'left'}
					env={uiEnv}
				/>
				<CapabilitiesPane
					activeTab={activeTab}
					tabState={activeTabState}
					focused={focusedPane === 'middle'}
					connState={connState}
					env={uiEnv}
				/>
				<DetailPane
					focused={focusedPane === 'right'}
					activeTab={activeTab}
					selected={selectedItem}
					scroll={previewScroll}
					rightMode={rightMode}
					resultScroll={resultScroll}
					connState={connState}
					env={uiEnv}
				/>
			</Box>
			<StatusBar
				focusedPane={focusedPane}
				connState={connState}
				rightMode={rightMode}
				env={uiEnv}
			/>
		</Box>
	);
}

function SizeGate({ columns, rows }: { columns: number; rows: number }): React.ReactElement {
	return (
		<Text>
			argus requires 80×24 terminal — current: {columns}x{rows}
		</Text>
	);
}

function ConnectionPane({
	path,
	connState,
	focused,
	env,
}: {
	path: string;
	connState: ConnectionState;
	focused: boolean;
	env: UiEnv;
}): React.ReactElement {
	const bStyle = borderStyleFor(env, focused);
	if (connState.kind === 'error') {
		return (
			<Box
				borderStyle={bStyle}
				borderColor={env.noColor ? undefined : focused ? 'cyan' : 'red'}
				width={18}
				flexDirection="column"
				paddingX={1}
			>
				<Text bold={focused} underline={focused} color={semanticColor(env, 'red')}>
					Connection
				</Text>
				<ErrorBlock error={connState.error} env={env} />
				<Text color={semanticColor(env, 'red')}>q to quit</Text>
			</Box>
		);
	}
	return (
		<Box
			borderStyle={bStyle}
			borderColor={focusBorderColor(env, focused)}
			width={18}
			flexDirection="column"
			paddingX={1}
		>
			<Text bold={focused} underline={focused}>
				Connection
			</Text>
			<Text>{truncate(basename(path), 14)}</Text>
			<Text>stdio</Text>
			{connState.kind === 'connected' && (
				<>
					<Text color={semanticColor(env, 'green')}>● connected</Text>
					<Text>pid {connState.info.pid}</Text>
				</>
			)}
			{connState.kind === 'connecting' && (
				<Box flexDirection="row">
					<Spinner env={env} />
					<Text color={semanticColor(env, 'yellow')}> ● connecting</Text>
				</Box>
			)}
		</Box>
	);
}

function ErrorBlock({ error, env }: { error: McpError; env: UiEnv }): React.ReactElement {
	// design-spec §3.1 wording, matched verbatim: `error:` prefix pairs with red
	// text so state is distinguishable without color (design-spec §6).
	const color = semanticColor(env, 'red');
	if (error.kind === 'timeout') {
		return (
			<Text color={color} bold>
				error: server did not respond to initialize within 5s
			</Text>
		);
	}
	if (error.kind === 'disconnected') {
		return (
			<Text color={color} bold>
				error: server exited ({formatExitDetail(error)}) — invocations disabled
			</Text>
		);
	}
	return (
		<Text color={color} bold>
			error: {error.message}
		</Text>
	);
}

function TabLabel({ label, active }: { label: string; active: boolean }): React.ReactElement {
	if (active) {
		return (
			<Text bold underline>
				{label}
			</Text>
		);
	}
	return <Text dimColor>{label}</Text>;
}

function CapabilitiesPane({
	activeTab,
	tabState,
	focused,
	connState,
	env,
}: {
	activeTab: Tab;
	tabState: TabState;
	focused: boolean;
	connState: ConnectionState;
	env: UiEnv;
}): React.ReactElement {
	const kindLabel: Record<Tab, string> = {
		tools: 'tools',
		resources: 'resources',
		prompts: 'prompts',
	};
	const shouldShowLoading = tabState.status === 'loading' || connState.kind === 'connecting';
	// design-spec §4.3: pane is disabled/hidden when initialize errored (pre-connect
	// failure). Mid-session `disconnected` leaves the list visible so the user can
	// still read what they were browsing.
	const disabledByInitError = connState.kind === 'error' && connState.error.kind !== 'disconnected';
	const redColor = semanticColor(env, 'red');

	return (
		<Box
			borderStyle={borderStyleFor(env, focused)}
			borderColor={focusBorderColor(env, focused)}
			width={24}
			flexDirection="column"
			paddingX={1}
		>
			<Text bold={focused} underline={focused} dimColor={disabledByInitError}>
				Capabilities
			</Text>
			{!disabledByInitError && (
				<Box flexDirection="row">
					<TabLabel label="[t]ools " active={activeTab === 'tools'} />
					<TabLabel label="[r]es " active={activeTab === 'resources'} />
					<TabLabel label="[p]rmt" active={activeTab === 'prompts'} />
				</Box>
			)}
			{!disabledByInitError && shouldShowLoading && (
				<Box flexDirection="row">
					<Spinner env={env} />
					<Text dimColor> loading {kindLabel[activeTab]}…</Text>
				</Box>
			)}
			{!disabledByInitError && !shouldShowLoading && tabState.status === 'error' && (
				<>
					<Text color={redColor} bold>
						failed to list {kindLabel[activeTab]}: {tabState.errorMessage ?? 'unknown error'}
					</Text>
					<Text color={redColor}>r to retry</Text>
				</>
			)}
			{!disabledByInitError &&
				!shouldShowLoading &&
				tabState.status === 'loaded' &&
				tabState.items.length === 0 && (
					<Text dimColor italic>
						no {kindLabel[activeTab]} exposed
					</Text>
				)}
			{!disabledByInitError &&
				tabState.items.map((item, i) => {
					const isSelected = i === tabState.selectedIndex;
					return (
						<Text
							key={item.name}
							inverse={isSelected && focused}
							underline={isSelected && !focused}
						>
							{item.name}
						</Text>
					);
				})}
		</Box>
	);
}

function DetailPane({
	focused,
	activeTab,
	selected,
	scroll,
	rightMode,
	resultScroll,
	connState,
	env,
}: {
	focused: boolean;
	activeTab: Tab;
	selected: Capability | undefined;
	scroll: number;
	rightMode: RightMode;
	resultScroll: number;
	connState: ConnectionState;
	env: UiEnv;
}): React.ReactElement {
	// design-spec §4.3: an initialize-time error hides right-pane content — the
	// user should only see the left-pane red block. Mid-session `disconnected`
	// keeps the pane visible but the FormBody dims and shows a footer.
	const initializeErrored = connState.kind === 'error' && connState.error.kind !== 'disconnected';
	const disconnected = connState.kind === 'error' && connState.error.kind === 'disconnected';
	const title =
		rightMode.kind === 'form' || rightMode.kind === 'invoking'
			? 'Form'
			: rightMode.kind === 'result'
				? 'Result'
				: 'Detail';
	return (
		<Box
			borderStyle={borderStyleFor(env, focused)}
			borderColor={focusBorderColor(env, focused)}
			flexGrow={1}
			flexDirection="column"
			paddingX={1}
		>
			<Text bold={focused} underline={focused} dimColor={initializeErrored}>
				{title}
			</Text>
			{!initializeErrored && rightMode.kind === 'preview' && selected === undefined && (
				<Text dimColor>select an item to preview</Text>
			)}
			{!initializeErrored && rightMode.kind === 'preview' && selected !== undefined && (
				<PreviewBody activeTab={activeTab} item={selected} scroll={scroll} />
			)}
			{!initializeErrored && (rightMode.kind === 'form' || rightMode.kind === 'invoking') && (
				<FormBody
					ctx={rightMode.ctx}
					invoking={rightMode.kind === 'invoking'}
					disconnected={disconnected}
					env={env}
				/>
			)}
			{!initializeErrored && rightMode.kind === 'result' && (
				<ResultView result={rightMode.result} scroll={resultScroll} />
			)}
		</Box>
	);
}

function PreviewBody({
	activeTab,
	item,
	scroll,
}: {
	activeTab: Tab;
	item: Capability;
	scroll: number;
}): React.ReactElement {
	const description = item.description ?? '';
	const hasDescription = description.length > 0;
	const fields = schemaFields(item.schema);
	const metadataLines: string[] = [];
	if (activeTab === 'resources') {
		if (item.uri) metadataLines.push(`uri: ${item.uri}`);
		if (item.mimeType) metadataLines.push(`mimeType: ${item.mimeType}`);
	}

	const bodyLines: React.ReactNode[] = [];
	bodyLines.push(
		<Text key="name" bold>
			{item.name}
		</Text>,
	);
	bodyLines.push(
		hasDescription ? (
			<Text key="desc">{description}</Text>
		) : (
			<Text key="desc" dimColor>
				(no description provided)
			</Text>
		),
	);
	for (const line of metadataLines) {
		bodyLines.push(<Text key={`meta-${line}`}>{line}</Text>);
	}
	if (fields.length > 0) {
		bodyLines.push(<Text key="fields-header">Args:</Text>);
		for (const f of fields) {
			const req = f.required ? ' (required)' : '';
			const marker = f.required ? '' : '?';
			bodyLines.push(
				<Text key={`f-${f.name}`}>
					{'  '}
					{f.name}
					{marker}: {f.type}
					{req}
				</Text>,
			);
		}
	}

	const start = Math.min(scroll, Math.max(bodyLines.length - 1, 0));
	const visible = bodyLines.slice(start);
	return <>{visible}</>;
}

function primitiveHint(kind: FormFieldKind): string {
	if (kind.kind === 'enum') return `enum: ${kind.options.join(' | ')}`;
	if (kind.kind === 'boolean') return 'boolean (true / false)';
	return kind.kind; // string | number
}

function FormBody({
	ctx,
	invoking,
	disconnected,
	env,
}: {
	ctx: FormCtx;
	invoking: boolean;
	disconnected: boolean;
	env: UiEnv;
}): React.ReactElement {
	// design-spec §3.4: server-crash form-disabled state renders the same as
	// invoking (fields dim, no cursor) but with the explicit disconnected footer.
	const locked = invoking || disconnected;
	const redColor = semanticColor(env, 'red');
	const yellowColor = semanticColor(env, 'yellow');
	if (ctx.spec.fields.length === 0) {
		return (
			<>
				<Text bold>{ctx.tool.name}</Text>
				<Text dimColor>(no arguments)</Text>
				{disconnected ? (
					<Text color={redColor} bold>
						server disconnected — cannot invoke
					</Text>
				) : (
					<Text dimColor>enter to submit · esc to cancel</Text>
				)}
			</>
		);
	}
	const errorByPath = new Map<string, string>();
	for (const e of ctx.errors) errorByPath.set(e.path.join('.'), e.message);

	const rows = focusRowsForSpec(ctx.spec, ctx.state);
	const focusedRowIndex = Math.min(ctx.focusedFieldIndex, rows.length - 1);
	// Build a set of (field-path, focus-index) so nested renderers can look up
	// focus state without threading indices through every recursion level.
	const focusIndexByRowKey = new Map<string, number>();
	for (let idx = 0; idx < rows.length; idx++) {
		const row = rows[idx];
		if (row) focusIndexByRowKey.set(rowKey(row), idx);
	}

	const rowProps: RowProps = {
		state: ctx.state,
		errorByPath,
		focusedIndex: focusedRowIndex,
		focusIndexByRowKey,
		invoking: locked,
	};

	return (
		<Box flexDirection="column">
			<Text bold>{ctx.tool.name}</Text>
			{ctx.spec.fields.map((field) => (
				<FieldTree key={field.path.join('.')} field={field} depth={0} rowProps={rowProps} />
			))}
			{invoking && !disconnected && (
				<Box flexDirection="row">
					<Spinner env={env} />
					<Text color={yellowColor} bold>
						{' '}
						invoking…
					</Text>
				</Box>
			)}
			{disconnected && (
				<Text color={redColor} bold>
					server disconnected — cannot invoke
				</Text>
			)}
		</Box>
	);
}

function rowKey(row: FocusRow): string {
	if (row.kind === 'array-item') return `array-item:${row.field.path.join('.')}:${row.index}`;
	if (row.kind === 'array-add') return `array-add:${row.field.path.join('.')}`;
	if (row.kind === 'raw-json') return `raw-json:${row.field.path.join('.')}`;
	return `primitive:${row.field.path.join('.')}`;
}

type RowProps = {
	state: FormState;
	errorByPath: Map<string, string>;
	focusedIndex: number;
	focusIndexByRowKey: Map<string, number>;
	invoking: boolean;
};

function indent(depth: number): string {
	return '  '.repeat(depth);
}

function FieldTree({
	field,
	depth,
	rowProps,
}: {
	field: FormField;
	depth: number;
	rowProps: RowProps;
}): React.ReactElement {
	const kind = field.fieldKind;
	const requiredMark = field.required ? '*' : '';
	const stateKey = field.path.join('.');
	const errorMessage = rowProps.errorByPath.get(stateKey);

	if (kind.kind === 'object') {
		return (
			<Box flexDirection="column">
				<Text>
					{indent(depth)}
					<Text bold>
						{field.label}
						{requiredMark}
					</Text>
					<Text dimColor> (object)</Text>
				</Text>
				{kind.fields.map((child) => (
					<FieldTree
						key={child.path.join('.')}
						field={child}
						depth={depth + 1}
						rowProps={rowProps}
					/>
				))}
			</Box>
		);
	}

	if (kind.kind === 'array-of-primitives') {
		const items = readArray(rowProps.state, stateKey);
		return (
			<Box flexDirection="column">
				<Text>
					{indent(depth)}
					<Text bold>
						{field.label}
						{requiredMark}
					</Text>
					<Text dimColor> (array&lt;{kind.itemKind}&gt;)</Text>
				</Text>
				{items.map((value, i) => {
					const key = `array-item:${stateKey}:${i}`;
					const rowIdx = rowProps.focusIndexByRowKey.get(key) ?? -1;
					const focused = rowIdx === rowProps.focusedIndex && !rowProps.invoking;
					return (
						<ArrayItemRow
							key={key}
							depth={depth + 1}
							index={i}
							value={value}
							focused={focused}
							disabled={rowProps.invoking}
						/>
					);
				})}
				<AddRowAffordance
					depth={depth + 1}
					focused={
						(rowProps.focusIndexByRowKey.get(`array-add:${stateKey}`) ?? -1) ===
							rowProps.focusedIndex && !rowProps.invoking
					}
				/>
				{errorMessage !== undefined && (
					<Text color="red">
						{indent(depth + 1)}error: {errorMessage}
					</Text>
				)}
			</Box>
		);
	}

	if (kind.kind === 'raw-json') {
		const value =
			typeof rowProps.state[stateKey] === 'string' ? (rowProps.state[stateKey] as string) : '';
		const rowIdx = rowProps.focusIndexByRowKey.get(`raw-json:${stateKey}`) ?? -1;
		const focused = rowIdx === rowProps.focusedIndex && !rowProps.invoking;
		return (
			<RawJsonRow
				field={field}
				reason={kind.reason}
				value={value}
				depth={depth}
				focused={focused}
				disabled={rowProps.invoking}
				errorMessage={errorMessage}
			/>
		);
	}

	// Primitive (string / number / boolean / enum).
	const value =
		typeof rowProps.state[stateKey] === 'string' ? (rowProps.state[stateKey] as string) : '';
	const rowIdx = rowProps.focusIndexByRowKey.get(`primitive:${stateKey}`) ?? -1;
	const focused = rowIdx === rowProps.focusedIndex && !rowProps.invoking;
	return (
		<PrimitiveRow
			field={field}
			value={value}
			depth={depth}
			focused={focused}
			disabled={rowProps.invoking}
			errorMessage={errorMessage}
		/>
	);
}

function PrimitiveRow({
	field,
	value,
	depth,
	focused,
	disabled,
	errorMessage,
}: {
	field: FormField;
	value: string;
	depth: number;
	focused: boolean;
	disabled: boolean;
	errorMessage?: string;
}): React.ReactElement {
	const requiredMark = field.required ? '*' : '';
	const hint = primitiveHint(field.fieldKind);
	const hasError = errorMessage !== undefined;
	const labelColor = hasError ? 'red' : undefined;
	const inputColor = hasError ? 'red' : undefined;
	const cursor = focused && !disabled ? '▎' : '';
	const displayValue = value.length === 0 && !focused ? ' ' : value;
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Text>{indent(depth)}</Text>
				<Text color={labelColor} inverse={focused} bold={focused}>
					{field.label}
					{requiredMark}
				</Text>
				<Text> ({hint}): </Text>
				<Text color={inputColor} dimColor={disabled}>
					{displayValue}
					{cursor}
				</Text>
			</Box>
			{hasError && (
				<Text color="red">
					{indent(depth + 1)}error: {errorMessage}
				</Text>
			)}
			{field.description && !hasError && (
				<Text dimColor>
					{indent(depth + 1)}
					{field.description}
				</Text>
			)}
		</Box>
	);
}

function RawJsonRow({
	field,
	reason,
	value,
	depth,
	focused,
	disabled,
	errorMessage,
}: {
	field: FormField;
	reason: 'array-of-objects' | 'oneOf' | 'anyOf' | 'ref' | 'binary' | 'open-object';
	value: string;
	depth: number;
	focused: boolean;
	disabled: boolean;
	errorMessage?: string;
}): React.ReactElement {
	const requiredMark = field.required ? '*' : '';
	const hasError = errorMessage !== undefined;
	const labelColor = hasError ? 'red' : undefined;
	const inputColor = hasError ? 'red' : undefined;
	const cursor = focused && !disabled ? '▎' : '';
	const displayValue = value.length === 0 && !focused ? ' ' : value;
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Text>{indent(depth)}</Text>
				<Text color={labelColor} inverse={focused} bold={focused}>
					{field.label}
					{requiredMark}
				</Text>
				<Text dimColor> (raw JSON — {reason})</Text>
			</Box>
			<Box flexDirection="row">
				<Text>{indent(depth + 1)}</Text>
				<Text color={inputColor} dimColor={disabled}>
					{displayValue}
					{cursor}
				</Text>
			</Box>
			{hasError && (
				<Text color="red">
					{indent(depth + 1)}error: {errorMessage}
				</Text>
			)}
		</Box>
	);
}

function ArrayItemRow({
	depth,
	index,
	value,
	focused,
	disabled,
}: {
	depth: number;
	index: number;
	value: string;
	focused: boolean;
	disabled: boolean;
}): React.ReactElement {
	const cursor = focused && !disabled ? '▎' : '';
	const displayValue = value.length === 0 && !focused ? ' ' : value;
	return (
		<Box flexDirection="row">
			<Text>{indent(depth)}</Text>
			<Text inverse={focused} bold={focused}>
				[{index}]
			</Text>
			<Text>: </Text>
			<Text dimColor={disabled}>
				{displayValue}
				{cursor}
			</Text>
		</Box>
	);
}

function AddRowAffordance({
	depth,
	focused,
}: {
	depth: number;
	focused: boolean;
}): React.ReactElement {
	return (
		<Box flexDirection="row">
			<Text>{indent(depth)}</Text>
			<Text dimColor inverse={focused} bold={focused}>
				[+ add row — enter to append]
			</Text>
		</Box>
	);
}

function StatusBar({
	focusedPane,
	connState,
	rightMode,
	env,
}: {
	focusedPane: Pane;
	connState: ConnectionState;
	rightMode: RightMode;
	env: UiEnv;
}): React.ReactElement {
	let hints: string;
	if (rightMode.kind === 'form' || rightMode.kind === 'invoking') {
		hints = 'tab/shift-tab fields  enter submit  esc cancel  ↑ last args  q quit';
	} else if (rightMode.kind === 'result') {
		hints = 'j/k scroll  o open in $PAGER  esc back to form  h back  q quit';
	} else if (focusedPane === 'left') {
		hints = 'q quit';
	} else if (focusedPane === 'middle') {
		hints = 'h/l panes  j/k list  t/r/p tabs  enter form  q quit';
	} else {
		hints = 'h back  j/k scroll  t/r/p tabs  q quit';
	}

	const blip =
		connState.kind === 'connected'
			? { text: '● connected', color: 'green' as const }
			: connState.kind === 'connecting'
				? { text: '● connecting', color: 'yellow' as const }
				: { text: '● disconnected', color: 'red' as const };

	return (
		<Box flexDirection="row" justifyContent="space-between" paddingX={1}>
			<Text dimColor>{hints}</Text>
			<Text color={semanticColor(env, blip.color)} bold>
				{blip.text}
			</Text>
		</Box>
	);
}
