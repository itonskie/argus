import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// The fixture uses the low-level Server so we can hand-author JSON Schema for
// every branch of the graceful ladder (ADR 5): primitives, nested objects,
// arrays of primitives, and every raw-JSON fallback case (array-of-objects,
// oneOf, $ref, binary). McpServer's zod-based registerTool cannot express
// $ref natively.

type ToolDef = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: (args: unknown) => { content: Array<{ type: 'text'; text: string }> };
};

function echoArgs(args: unknown): { content: Array<{ type: 'text'; text: string }> } {
	return { content: [{ type: 'text', text: JSON.stringify(args ?? {}) }] };
}

const tools: ToolDef[] = [
	{
		name: 'echo',
		description: 'Echoes the input message back verbatim.',
		inputSchema: {
			type: 'object',
			properties: {
				message: { type: 'string', description: 'Message to echo back.' },
			},
			required: ['message'],
		},
		handler: (args) => {
			const message =
				typeof args === 'object' && args !== null && 'message' in args
					? String((args as { message: unknown }).message)
					: '';
			return { content: [{ type: 'text', text: message }] };
		},
	},
	{
		name: 'boom',
		description: 'Throws inside the handler — used to exercise the server-error path.',
		inputSchema: { type: 'object', properties: {} },
		handler: () => {
			throw new Error('boom: intentional fixture failure');
		},
	},
	{
		name: 'slow',
		description: 'Never resolves — used to exercise the invoke timeout path.',
		inputSchema: { type: 'object', properties: {} },
		// Handled specially below — never resolves.
		handler: () => ({ content: [] }),
	},
	{
		name: 'nested-object',
		description: 'Accepts a nested user object — exercises the recursive-object branch.',
		inputSchema: {
			type: 'object',
			properties: {
				user: {
					type: 'object',
					properties: {
						name: { type: 'string' },
						age: { type: 'number' },
					},
					required: ['name'],
				},
			},
			required: ['user'],
		},
		handler: echoArgs,
	},
	{
		name: 'array-of-strings',
		description: 'Accepts an array of strings — exercises the array-of-primitives branch.',
		inputSchema: {
			type: 'object',
			properties: {
				tags: { type: 'array', items: { type: 'string' } },
			},
			required: ['tags'],
		},
		handler: echoArgs,
	},
	{
		name: 'array-of-objects',
		description: 'Accepts an array of objects — falls back to a raw-JSON textarea.',
		inputSchema: {
			type: 'object',
			properties: {
				items: {
					type: 'array',
					items: {
						type: 'object',
						properties: { id: { type: 'number' }, name: { type: 'string' } },
						required: ['id'],
					},
				},
			},
			required: ['items'],
		},
		handler: echoArgs,
	},
	{
		name: 'one-of',
		description: 'Accepts a value matching a oneOf union — falls back to a raw-JSON textarea.',
		inputSchema: {
			type: 'object',
			properties: {
				value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
			},
			required: ['value'],
		},
		handler: echoArgs,
	},
	{
		name: 'ref-schema',
		description: 'Accepts a value referenced via $ref — falls back to a raw-JSON textarea.',
		inputSchema: {
			type: 'object',
			properties: {
				node: { $ref: '#/$defs/Node' },
			},
			required: ['node'],
			$defs: {
				Node: {
					type: 'object',
					properties: { label: { type: 'string' } },
					required: ['label'],
				},
			},
		},
		handler: echoArgs,
	},
	{
		name: 'binary-blob',
		description: 'Accepts a base64 blob — falls back to a raw-JSON textarea.',
		inputSchema: {
			type: 'object',
			properties: {
				blob: { type: 'string', contentEncoding: 'base64' },
			},
			required: ['blob'],
		},
		handler: echoArgs,
	},
];

const toolByName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
	{ name: 'argus-test-server-fixture', version: '0.0.0' },
	{ capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	})),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	const tool = toolByName.get(name);
	if (!tool) throw new Error(`unknown tool: ${name}`);
	if (name === 'slow') {
		await new Promise<never>(() => {});
		throw new Error('unreachable');
	}
	return tool.handler(args);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: [
		{
			name: 'greeting',
			uri: 'argus://fixture/greeting',
			description: 'A static greeting resource served by the fixture.',
			mimeType: 'text/plain',
		},
	],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const uri = request.params.uri;
	if (uri !== 'argus://fixture/greeting') {
		throw new Error(`unknown resource: ${uri}`);
	}
	return {
		contents: [{ uri, mimeType: 'text/plain', text: 'hello from argus fixture' }],
	};
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
	prompts: [
		{
			name: 'greet',
			description: 'Renders a greeting for the given name.',
			arguments: [{ name: 'name', description: 'Person to greet.', required: true }],
		},
	],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
	if (request.params.name !== 'greet') {
		throw new Error(`unknown prompt: ${request.params.name}`);
	}
	const name = (request.params.arguments as { name?: unknown } | undefined)?.name ?? '';
	return {
		messages: [
			{
				role: 'user',
				content: { type: 'text', text: `Say hello to ${String(name)}.` },
			},
		],
	};
});

const transport = new StdioServerTransport();
await server.connect(transport);
