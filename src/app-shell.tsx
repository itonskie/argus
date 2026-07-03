import { basename } from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
	type Capability,
	type ConnectionInfo,
	createMcpClient,
	type McpClient,
	type McpError,
} from './mcp-client.js';

type ConnectionState =
	| { kind: 'connecting' }
	| { kind: 'connected'; info: ConnectionInfo }
	| { kind: 'error'; error: McpError };

type Pane = 'left' | 'middle' | 'right';

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

export function App({ path }: AppProps): React.ReactElement {
	const { exit } = useApp();
	const clientRef = useRef<McpClient | null>(null);
	const shuttingDownRef = useRef(false);
	const [connState, setConnState] = useState<ConnectionState>({ kind: 'connecting' });
	const [tools, setTools] = useState<Capability[]>([]);
	const [selectedTool, setSelectedTool] = useState(0);
	const [focusedPane, setFocusedPane] = useState<Pane>('middle');

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
				const list = await client.listTools();
				if (cancelled) return;
				setTools(list);
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

	useInput((input, key) => {
		if (input === 'q' || (key.ctrl && input === 'c')) {
			quit();
			return;
		}
		if (input === 'j' && focusedPane === 'middle') {
			setSelectedTool((i) => (tools.length === 0 ? 0 : Math.min(i + 1, tools.length - 1)));
			return;
		}
		if (input === 'k' && focusedPane === 'middle') {
			setSelectedTool((i) => Math.max(i - 1, 0));
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

	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<ConnectionPane path={path} connState={connState} focused={focusedPane === 'left'} />
				<CapabilitiesPane
					tools={tools}
					selectedIndex={selectedTool}
					focused={focusedPane === 'middle'}
					connState={connState}
				/>
				<DetailPane focused={focusedPane === 'right'} />
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

function CapabilitiesPane({
	tools,
	selectedIndex,
	focused,
	connState,
}: {
	tools: Capability[];
	selectedIndex: number;
	focused: boolean;
	connState: ConnectionState;
}): React.ReactElement {
	return (
		<Box
			borderStyle="single"
			borderColor={focused ? 'cyan' : undefined}
			width={22}
			flexDirection="column"
			paddingX={1}
		>
			<Box flexDirection="row">
				<Text bold underline>
					[t]ools
				</Text>
				<Text dimColor> [r]es [p]</Text>
			</Box>
			{connState.kind === 'connecting' && <Text dimColor>loading tools…</Text>}
			{connState.kind !== 'connecting' && tools.length === 0 && (
				<Text dimColor>no tools exposed</Text>
			)}
			{tools.map((tool, i) => {
				const isSelected = i === selectedIndex;
				return (
					<Text key={tool.name} inverse={isSelected && focused} underline={isSelected && !focused}>
						{tool.name}
					</Text>
				);
			})}
		</Box>
	);
}

function DetailPane({ focused }: { focused: boolean }): React.ReactElement {
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
			<Text dimColor>select an item to preview</Text>
		</Box>
	);
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
				: 'h back  q quit';

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
