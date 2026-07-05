import { Box, Text } from 'ink';
import type React from 'react';
import type { InvokeResult, McpError } from './mcp-client.js';

const LARGE_RESPONSE_HINT_THRESHOLD_KB = 20;
// Above the threshold, only the first N pretty-print lines render inline. The
// full payload is still available via `o → $PAGER` (design-spec §3.5).
const LARGE_RESPONSE_INLINE_LINE_LIMIT = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEmpty(v: unknown): boolean {
	if (v === null || v === undefined) return true;
	if (isRecord(v)) return Object.keys(v).length === 0;
	if (Array.isArray(v)) return v.length === 0;
	return false;
}

type Classified =
	| { kind: 'text'; text: string }
	| { kind: 'base64'; mimeType?: string; sizeBytes: number }
	| { kind: 'json'; value: unknown };

function classifyMcpResult(raw: unknown): Classified {
	if (isRecord(raw) && Array.isArray(raw.content)) {
		const content = raw.content as unknown[];
		if (content.length === 1) {
			const only = content[0];
			if (isRecord(only) && only.type === 'text' && typeof only.text === 'string') {
				return { kind: 'text', text: only.text };
			}
			if (
				isRecord(only) &&
				(only.type === 'image' || only.type === 'audio') &&
				typeof only.data === 'string'
			) {
				const mimeType = typeof only.mimeType === 'string' ? only.mimeType : undefined;
				return { kind: 'base64', mimeType, sizeBytes: only.data.length };
			}
		}
		if (isRecord(raw.structuredContent)) {
			return { kind: 'json', value: raw.structuredContent };
		}
		return { kind: 'json', value: raw };
	}
	return { kind: 'json', value: raw };
}

function scrollLines(lines: React.ReactNode[], scroll: number): React.ReactNode[] {
	const start = Math.min(Math.max(scroll, 0), Math.max(lines.length - 1, 0));
	return lines.slice(start);
}

// Two-space indent per depth. Line-by-line so each token can wear its own color.
function renderJson(value: unknown, indent = 0): React.ReactNode[] {
	const pad = '  '.repeat(indent);
	const out: React.ReactNode[] = [];

	if (value === null) {
		out.push(
			<Text key={`n-${indent}`} color="magenta" bold>
				{pad}null
			</Text>,
		);
		return out;
	}
	if (typeof value === 'boolean') {
		out.push(
			<Text key={`b-${indent}`} color="magenta" bold>
				{pad}
				{String(value)}
			</Text>,
		);
		return out;
	}
	if (typeof value === 'number') {
		out.push(
			<Text key={`num-${indent}`} color="yellow">
				{pad}
				{String(value)}
			</Text>,
		);
		return out;
	}
	if (typeof value === 'string') {
		out.push(<Text key={`s-${indent}`}>{`${pad}"${value}"`}</Text>);
		return out;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			out.push(<Text key={`arr-${indent}`}>{`${pad}[]`}</Text>);
			return out;
		}
		out.push(<Text key={`arr-open-${indent}`}>{`${pad}[`}</Text>);
		value.forEach((item, i) => {
			const childLines = renderJson(item, indent + 1);
			childLines.forEach((line, li) => {
				// Stateless JSON tree — position-based key is fine.
				// biome-ignore lint/suspicious/noArrayIndexKey: array position is the stable identity
				out.push(<Box key={`arr-item-${indent}-${i}-${li}`}>{line}</Box>);
			});
		});
		out.push(<Text key={`arr-close-${indent}`}>{`${pad}]`}</Text>);
		return out;
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) {
			out.push(<Text key={`obj-${indent}`}>{`${pad}{}`}</Text>);
			return out;
		}
		out.push(<Text key={`obj-open-${indent}`}>{`${pad}{`}</Text>);
		for (const [k, v] of entries) {
			const childPad = '  '.repeat(indent + 1);
			// Primitive value → single line "key: value"
			if (v === null || typeof v !== 'object') {
				const valueText =
					v === null
						? 'null'
						: typeof v === 'string'
							? `"${v}"`
							: typeof v === 'boolean' || typeof v === 'number'
								? String(v)
								: JSON.stringify(v);
				const valueColor: 'yellow' | 'magenta' | undefined =
					typeof v === 'number'
						? 'yellow'
						: v === null || typeof v === 'boolean'
							? 'magenta'
							: undefined;
				out.push(
					<Box key={`obj-kv-${indent}-${k}`} flexDirection="row">
						<Text color="cyan" bold>{`${childPad}"${k}"`}</Text>
						<Text>: </Text>
						<Text color={valueColor} bold={valueColor === 'magenta'}>
							{valueText}
						</Text>
					</Box>,
				);
			} else {
				out.push(
					<Text key={`obj-k-${indent}-${k}`}>
						<Text color="cyan" bold>{`${childPad}"${k}"`}</Text>
						<Text>: </Text>
					</Text>,
				);
				const childLines = renderJson(v, indent + 1);
				childLines.forEach((line, li) => {
					// biome-ignore lint/suspicious/noArrayIndexKey: line position within a stable object key is stable
					out.push(<Box key={`obj-v-${indent}-${k}-${li}`}>{line}</Box>);
				});
			}
		}
		out.push(<Text key={`obj-close-${indent}`}>{`${pad}}`}</Text>);
		return out;
	}
	out.push(<Text key={`fallback-${indent}`}>{`${pad}${String(value)}`}</Text>);
	return out;
}

// Returns the payload to hand to `$PAGER` when the user presses `o`. Mirrors
// the on-screen classification (design-spec §3.5): text results pipe as raw
// text, base64 as a metadata line, everything else as pretty JSON. Returns
// null for errors and empty responses — nothing worth paging.
export function serializeResultForPager(result: InvokeResult): string | null {
	if (!result.ok) return null;
	const payload = result.result;
	if (isEmpty(payload)) return null;
	const classified = classifyMcpResult(payload);
	if (classified.kind === 'text') return classified.text;
	if (classified.kind === 'base64') {
		const mime = classified.mimeType ?? 'application/octet-stream';
		return `${mime} — ${classified.sizeBytes} bytes (base64)`;
	}
	return JSON.stringify(classified.value, null, 2);
}

function errorBlock(error: McpError): React.ReactNode {
	if (error.kind === 'timeout') {
		return (
			<Text color="red" bold>
				error: invocation timed out after 30s
			</Text>
		);
	}
	if (error.kind === 'disconnected') {
		return (
			<Text color="red" bold>
				error: server disconnected
			</Text>
		);
	}
	return (
		<>
			<Text color="red" bold>
				error: server-error ({error.code})
			</Text>
			<Text color="red">{error.message}</Text>
		</>
	);
}

export function ResultView({
	result,
	scroll,
}: {
	result: InvokeResult;
	scroll: number;
}): React.ReactElement {
	if (!result.ok) {
		return <Box flexDirection="column">{errorBlock(result.error)}</Box>;
	}
	const payload = result.result;
	if (isEmpty(payload)) {
		return (
			<Text dimColor italic>
				(empty response)
			</Text>
		);
	}
	const classified = classifyMcpResult(payload);

	if (classified.kind === 'text') {
		const bytes = Buffer.byteLength(classified.text, 'utf8');
		const kb = Math.round(bytes / 1024);
		const lines: React.ReactNode[] = [
			<Text key="prefix" bold>
				[text]
			</Text>,
			<Text key="content">{classified.text}</Text>,
		];
		if (kb >= LARGE_RESPONSE_HINT_THRESHOLD_KB) {
			lines.unshift(
				<Text key="warn" color="yellow" bold>
					warning: response is {kb} KB — press o to open in $PAGER
				</Text>,
			);
		}
		return <Box flexDirection="column">{scrollLines(lines, scroll)}</Box>;
	}
	if (classified.kind === 'base64') {
		const kb = Math.round(classified.sizeBytes / 1024);
		return (
			<Box flexDirection="column">
				<Text bold>[base64]</Text>
				<Text>
					{classified.mimeType ?? 'application/octet-stream'} — {kb} KB
				</Text>
			</Box>
		);
	}
	const jsonLines = renderJson(classified.value);
	const bytes = Buffer.byteLength(JSON.stringify(classified.value), 'utf8');
	const kb = Math.round(bytes / 1024);
	const lines: React.ReactNode[] = [];
	if (kb >= LARGE_RESPONSE_HINT_THRESHOLD_KB) {
		lines.push(
			<Text key="warn" color="yellow" bold>
				warning: response is {kb} KB — press o to open in $PAGER
			</Text>,
		);
		lines.push(...jsonLines.slice(0, LARGE_RESPONSE_INLINE_LINE_LIMIT));
	} else {
		lines.push(...jsonLines);
	}
	return <Box flexDirection="column">{scrollLines(lines, scroll)}</Box>;
}
