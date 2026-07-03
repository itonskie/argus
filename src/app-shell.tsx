import { basename } from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
	type Capability,
	type ConnectionInfo,
	createMcpClient,
	type JSONSchema,
	type McpClient,
	type McpError,
} from './mcp-client.js';

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

	useInput((input, key) => {
		if (input === 'q' && focusedPane !== 'right') {
			quit();
			return;
		}
		if (key.ctrl && input === 'c') {
			quit();
			return;
		}
		if (focusedPane === 'right' && input === 'q') {
			// Right pane Preview allows q per design-spec §5.1 (no form input at risk this slice).
			quit();
			return;
		}

		// Tab switching (t / r / p) is allowed on middle and right panes (Preview mode).
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
				/>
			</Box>
			<StatusBar focusedPane={focusedPane} connState={connState} />
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
}: {
	focused: boolean;
	activeTab: Tab;
	selected: Capability | undefined;
	scroll: number;
}): React.ReactElement {
	return (
		<Box
			borderStyle="single"
			borderColor={focused ? 'cyan' : undefined}
			flexGrow={1}
			flexDirection="column"
			paddingX={1}
		>
			<Text bold={focused} underline={focused}>
				Detail
			</Text>
			{selected === undefined && <Text dimColor>select an item to preview</Text>}
			{selected !== undefined && (
				<PreviewBody activeTab={activeTab} item={selected} scroll={scroll} />
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

function StatusBar({
	focusedPane,
	connState,
}: {
	focusedPane: Pane;
	connState: ConnectionState;
}): React.ReactElement {
	const hints =
		focusedPane === 'left'
			? 'q quit'
			: focusedPane === 'middle'
				? 'h/l panes  j/k list  t/r/p tabs  enter form  q quit'
				: 'h back  j/k scroll  t/r/p tabs  q quit';

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
