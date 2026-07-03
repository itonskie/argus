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

const transport = new StdioServerTransport();
await server.connect(transport);
