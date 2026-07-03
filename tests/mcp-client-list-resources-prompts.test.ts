import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpClient, type McpClient } from '../src/mcp-client.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

describe('mcp-client — listResources + listPrompts', () => {
	let client: McpClient | undefined;

	afterEach(async () => {
		if (client) {
			try {
				await client.disconnect();
			} catch {
				// ignore
			}
			client = undefined;
		}
	});

	it('listResources returns the fixture "greeting" resource with uri and mimeType', async () => {
		client = createMcpClient();
		await client.connect(FIXTURE_ENTRY);

		const resources = await client.listResources();
		const greeting = resources.find((r) => r.name === 'greeting');

		expect(greeting).toBeDefined();
		expect(greeting?.uri).toBe('argus://fixture/greeting');
		expect(greeting?.mimeType).toBe('text/plain');
		expect(typeof greeting?.description).toBe('string');
		expect((greeting?.description ?? '').length).toBeGreaterThan(0);
		expect(greeting?.schema).toBeDefined();
	});

	it('listPrompts returns the fixture "greet" prompt with a schema derived from its arguments', async () => {
		client = createMcpClient();
		await client.connect(FIXTURE_ENTRY);

		const prompts = await client.listPrompts();
		const greet = prompts.find((p) => p.name === 'greet');

		expect(greet).toBeDefined();
		expect(typeof greet?.description).toBe('string');
		expect((greet?.description ?? '').length).toBeGreaterThan(0);

		const schema = (greet?.schema ?? {}) as {
			type?: string;
			properties?: Record<string, { type?: string; description?: string }>;
			required?: string[];
		};
		expect(schema.type).toBe('object');
		expect(schema.properties?.name?.type).toBe('string');
		expect(schema.required).toContain('name');
	});

	it('throws { kind: "disconnected" } if list is called before connect', async () => {
		client = createMcpClient();
		let resourcesErr: unknown;
		try {
			await client.listResources();
		} catch (err) {
			resourcesErr = err;
		}
		expect(resourcesErr).toEqual({ kind: 'disconnected' });

		let promptsErr: unknown;
		try {
			await client.listPrompts();
		} catch (err) {
			promptsErr = err;
		}
		expect(promptsErr).toEqual({ kind: 'disconnected' });
	});
});
