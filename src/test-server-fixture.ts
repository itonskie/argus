import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
	name: 'argus-test-server-fixture',
	version: '0.0.0',
});

server.registerTool(
	'echo',
	{
		description: 'Echoes the input message back verbatim.',
		inputSchema: {
			message: z.string().describe('Message to echo back.'),
		},
	},
	({ message }) => ({
		content: [{ type: 'text', text: message }],
	}),
);

server.registerResource(
	'greeting',
	'argus://fixture/greeting',
	{
		description: 'A static greeting resource served by the fixture.',
		mimeType: 'text/plain',
	},
	async (uri) => ({
		contents: [
			{
				uri: uri.href,
				mimeType: 'text/plain',
				text: 'hello from argus fixture',
			},
		],
	}),
);

server.registerPrompt(
	'greet',
	{
		description: 'Renders a greeting for the given name.',
		argsSchema: {
			name: z.string().describe('Person to greet.'),
		},
	},
	({ name }) => ({
		messages: [
			{
				role: 'user',
				content: { type: 'text', text: `Say hello to ${name}.` },
			},
		],
	}),
);

const transport = new StdioServerTransport();
await server.connect(transport);
