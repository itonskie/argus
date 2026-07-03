import { basename } from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
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
import { ResultView } from './result-view.js';

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

function initialStateFromSpec(spec: FormSpec): FormState {
	const state: FormState = {};
	for (const field of spec.fields) {
		const key = field.path.join('.');
		if (field.default !== undefined) {
			state[key] = String(field.default);
		} else {
			state[key] = '';
		}
	}
	return state;
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

export function App({ path }: AppProps): React.ReactElement {
	const { exit } = useApp();
	const clientRef = useRef<McpClient | null>(null);
	const shuttingDownRef = useRef(false);
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
					setTools((s) => ({ ...s, status: 'error' }));
				}
				if (resourcesRes.status === 'fulfilled') {
					setResources({
						items: resourcesRes.value,
						status: 'loaded',
						selectedIndex: 0,
					});
				} else {
					setResources((s) => ({ ...s, status: 'error' }));
				}
				if (promptsRes.status === 'fulfilled') {
					setPrompts({
						items: promptsRes.value,
						status: 'loaded',
						selectedIndex: 0,
					});
				} else {
					setPrompts((s) => ({ ...s, status: 'error' }));
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
			const firstInvalid = Math.max(
				0,
				ctx.spec.fields.findIndex((f) =>
					result.errors.some((e) => e.path.join('.') === f.path.join('.')),
				),
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
		setRightMode({ kind: 'result', ctx, result: invokeResult });
		setResultScroll(0);
	};

	useInput((input, key) => {
		// Ctrl-C always quits.
		if (key.ctrl && input === 'c') {
			quit();
			return;
		}

		// Form / invoking mode owns focus completely — route all input here.
		if (rightMode.kind === 'form' || rightMode.kind === 'invoking') {
			const ctx = rightMode.ctx;
			if (rightMode.kind === 'invoking') {
				// Fields are locked while the invocation is in flight.
				return;
			}
			if (key.escape) {
				setRightMode({ kind: 'preview' });
				setFocusedPane('middle');
				return;
			}
			if (key.return) {
				void submitForm(ctx);
				return;
			}
			if (key.tab) {
				const total = ctx.spec.fields.length;
				if (total <= 1) return;
				const delta = key.shift ? -1 : 1;
				const next = (ctx.focusedFieldIndex + delta + total) % total;
				setRightMode({ kind: 'form', ctx: { ...ctx, focusedFieldIndex: next } });
				return;
			}
			// Field editing: text/number/boolean/enum → single-line string input.
			const focused = ctx.spec.fields[ctx.focusedFieldIndex];
			if (!focused) return;
			const key_ = focused.path.join('.');
			const cur = typeof ctx.state[key_] === 'string' ? (ctx.state[key_] as string) : '';
			if (key.backspace || key.delete) {
				const next = cur.slice(0, -1);
				setRightMode({
					kind: 'form',
					ctx: { ...ctx, state: { ...ctx.state, [key_]: next } },
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
					ctx: { ...ctx, state: { ...ctx.state, [key_]: next } },
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

	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<ConnectionPane path={path} connState={connState} focused={focusedPane === 'left'} />
				<CapabilitiesPane
					activeTab={activeTab}
					tabState={activeTabState}
					focused={focusedPane === 'middle'}
					connState={connState}
				/>
				<DetailPane
					focused={focusedPane === 'right'}
					activeTab={activeTab}
					selected={selectedItem}
					scroll={previewScroll}
					rightMode={rightMode}
					resultScroll={resultScroll}
				/>
			</Box>
			<StatusBar focusedPane={focusedPane} connState={connState} rightMode={rightMode} />
		</Box>
	);
}

function ConnectionPane({
	path,
	connState,
	focused,
}: {
	path: string;
	connState: ConnectionState;
	focused: boolean;
}): React.ReactElement {
	return (
		<Box
			borderStyle="single"
			borderColor={focused ? 'cyan' : undefined}
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
					<Text color="green">● connected</Text>
					<Text>pid {connState.info.pid}</Text>
				</>
			)}
			{connState.kind === 'connecting' && <Text color="yellow">● connecting</Text>}
			{connState.kind === 'error' && (
				<Text color="red" bold>
					● {connState.error.kind}
				</Text>
			)}
		</Box>
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
}: {
	activeTab: Tab;
	tabState: TabState;
	focused: boolean;
	connState: ConnectionState;
}): React.ReactElement {
	const kindLabel: Record<Tab, string> = {
		tools: 'tools',
		resources: 'resources',
		prompts: 'prompts',
	};
	const shouldShowLoading = tabState.status === 'loading' || connState.kind === 'connecting';

	return (
		<Box
			borderStyle="single"
			borderColor={focused ? 'cyan' : undefined}
			width={24}
			flexDirection="column"
			paddingX={1}
		>
			<Text bold={focused} underline={focused}>
				Capabilities
			</Text>
			<Box flexDirection="row">
				<TabLabel label="[t]ools " active={activeTab === 'tools'} />
				<TabLabel label="[r]es " active={activeTab === 'resources'} />
				<TabLabel label="[p]rmt" active={activeTab === 'prompts'} />
			</Box>
			{shouldShowLoading && <Text dimColor>loading {kindLabel[activeTab]}…</Text>}
			{!shouldShowLoading && tabState.status === 'error' && (
				<Text color="red" bold>
					failed to list {kindLabel[activeTab]}
				</Text>
			)}
			{!shouldShowLoading && tabState.status === 'loaded' && tabState.items.length === 0 && (
				<Text dimColor italic>
					no {kindLabel[activeTab]} exposed
				</Text>
			)}
			{tabState.items.map((item, i) => {
				const isSelected = i === tabState.selectedIndex;
				return (
					<Text key={item.name} inverse={isSelected && focused} underline={isSelected && !focused}>
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
}: {
	focused: boolean;
	activeTab: Tab;
	selected: Capability | undefined;
	scroll: number;
	rightMode: RightMode;
	resultScroll: number;
}): React.ReactElement {
	const title =
		rightMode.kind === 'form' || rightMode.kind === 'invoking'
			? 'Form'
			: rightMode.kind === 'result'
				? 'Result'
				: 'Detail';
	return (
		<Box
			borderStyle="single"
			borderColor={focused ? 'cyan' : undefined}
			flexGrow={1}
			flexDirection="column"
			paddingX={1}
		>
			<Text bold={focused} underline={focused}>
				{title}
			</Text>
			{rightMode.kind === 'preview' && selected === undefined && (
				<Text dimColor>select an item to preview</Text>
			)}
			{rightMode.kind === 'preview' && selected !== undefined && (
				<PreviewBody activeTab={activeTab} item={selected} scroll={scroll} />
			)}
			{(rightMode.kind === 'form' || rightMode.kind === 'invoking') && (
				<FormBody ctx={rightMode.ctx} invoking={rightMode.kind === 'invoking'} />
			)}
			{rightMode.kind === 'result' && (
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

function fieldKindHint(kind: FormFieldKind): string {
	// raw-json comes first so its `reason` is accessible without further narrowing.
	if (kind.kind === 'raw-json') return `raw JSON (${kind.reason})`;
	if (kind.kind === 'enum') return `enum: ${kind.options.join(' | ')}`;
	if (kind.kind === 'object') return 'object';
	if (kind.kind === 'array-of-primitives') return `array<${kind.itemKind}>`;
	if (kind.kind === 'boolean') return 'boolean (true / false)';
	return kind.kind; // string | number
}

function FormBody({ ctx, invoking }: { ctx: FormCtx; invoking: boolean }): React.ReactElement {
	if (ctx.spec.fields.length === 0) {
		return (
			<>
				<Text bold>{ctx.tool.name}</Text>
				<Text dimColor>(no arguments)</Text>
				<Text dimColor>enter to submit · esc to cancel</Text>
			</>
		);
	}
	const errorByPath = new Map<string, string>();
	for (const e of ctx.errors) errorByPath.set(e.path.join('.'), e.message);

	return (
		<Box flexDirection="column">
			<Text bold>{ctx.tool.name}</Text>
			{ctx.spec.fields.map((field, idx) => (
				<FieldRow
					key={field.path.join('.')}
					field={field}
					value={
						typeof ctx.state[field.path.join('.')] === 'string'
							? (ctx.state[field.path.join('.')] as string)
							: ''
					}
					focused={idx === ctx.focusedFieldIndex && !invoking}
					errorMessage={errorByPath.get(field.path.join('.'))}
					disabled={invoking}
				/>
			))}
			{invoking && (
				<Text color="yellow" bold>
					invoking…
				</Text>
			)}
		</Box>
	);
}

function FieldRow({
	field,
	value,
	focused,
	errorMessage,
	disabled,
}: {
	field: FormField;
	value: string;
	focused: boolean;
	errorMessage?: string;
	disabled: boolean;
}): React.ReactElement {
	const requiredMark = field.required ? '*' : '';
	const hint = fieldKindHint(field.fieldKind);
	const hasError = errorMessage !== undefined;
	const labelColor = hasError ? 'red' : undefined;
	const inputColor = hasError ? 'red' : undefined;
	const cursor = focused && !disabled ? '▎' : '';
	const displayValue = value.length === 0 && !focused ? ' ' : value;
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
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
					{'  '}error: {errorMessage}
				</Text>
			)}
			{field.description && !hasError && (
				<Text dimColor>
					{'  '}
					{field.description}
				</Text>
			)}
		</Box>
	);
}

function StatusBar({
	focusedPane,
	connState,
	rightMode,
}: {
	focusedPane: Pane;
	connState: ConnectionState;
	rightMode: RightMode;
}): React.ReactElement {
	let hints: string;
	if (rightMode.kind === 'form' || rightMode.kind === 'invoking') {
		hints = 'tab/shift-tab fields  enter submit  esc cancel  q quit';
	} else if (rightMode.kind === 'result') {
		hints = 'j/k scroll  esc back to form  h back  q quit';
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
			<Text color={blip.color} bold>
				{blip.text}
			</Text>
		</Box>
	);
}
