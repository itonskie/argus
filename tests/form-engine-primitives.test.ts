import { describe, expect, it } from 'vitest';
import type { FormField, JSONSchema } from '../src/form-engine.js';
import { schemaToForm, submit } from '../src/form-engine.js';

describe('form-engine.schemaToForm — primitives', () => {
	it('returns a single string FormField for { name: string, required: [name] }', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
		};

		const spec = schemaToForm(schema);

		expect(spec.fields).toHaveLength(1);
		expect(spec.fields[0]).toEqual<FormField>({
			path: ['name'],
			label: 'name',
			required: true,
			fieldKind: { kind: 'string' },
		});
	});

	it('preserves default and description on a FormField', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: {
				count: {
					type: 'number',
					default: 3,
					description: 'How many to fetch.',
				},
			},
		};

		const spec = schemaToForm(schema);

		expect(spec.fields).toEqual<FormField[]>([
			{
				path: ['count'],
				label: 'count',
				required: false,
				fieldKind: { kind: 'number' },
				default: 3,
				description: 'How many to fetch.',
			},
		]);
	});

	it('maps primitive property types to the matching FormFieldKind', () => {
		const cases: Array<{
			label: string;
			schema: JSONSchema;
			expected: FormField['fieldKind'];
		}> = [
			{
				label: 'string',
				schema: { type: 'object', properties: { v: { type: 'string' } } },
				expected: { kind: 'string' },
			},
			{
				label: 'number',
				schema: { type: 'object', properties: { v: { type: 'number' } } },
				expected: { kind: 'number' },
			},
			{
				label: 'integer',
				schema: { type: 'object', properties: { v: { type: 'integer' } } },
				expected: { kind: 'number' },
			},
			{
				label: 'boolean',
				schema: { type: 'object', properties: { v: { type: 'boolean' } } },
				expected: { kind: 'boolean' },
			},
			{
				label: 'enum',
				schema: {
					type: 'object',
					properties: { v: { type: 'string', enum: ['a', 'b', 'c'] } },
				},
				expected: { kind: 'enum', options: ['a', 'b', 'c'] },
			},
		];

		for (const c of cases) {
			const spec = schemaToForm(c.schema);
			expect(spec.fields[0]?.fieldKind, c.label).toEqual(c.expected);
		}
	});

	it('marks non-required properties as required: false', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: {
				a: { type: 'string' },
				b: { type: 'string' },
			},
			required: ['a'],
		};

		const spec = schemaToForm(schema);

		expect(spec.fields.find((f) => f.label === 'a')?.required).toBe(true);
		expect(spec.fields.find((f) => f.label === 'b')?.required).toBe(false);
	});
});

describe('form-engine.submit — primitives', () => {
	it('returns { valid: true, payload } for a well-formed state', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
		};

		const result = await submit(schema, { name: 'x' });

		expect(result).toEqual({ valid: true, payload: { name: 'x' } });
	});

	it('flags a missing required field', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
		};

		const result = await submit(schema, {});

		expect(result.valid).toBe(false);
		if (result.valid) throw new Error('expected invalid result');
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toEqual(['name']);
		expect(result.errors[0]?.message).toMatch(/required/i);
	});

	it('flags a wrong-typed number field', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { count: { type: 'number' } },
			required: ['count'],
		};

		const result = await submit(schema, { count: 'not-a-number' });

		expect(result.valid).toBe(false);
		if (result.valid) throw new Error('expected invalid result');
		expect(result.errors[0]?.path).toEqual(['count']);
	});

	it('coerces stringified booleans and numbers from raw form input', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: {
				active: { type: 'boolean' },
				count: { type: 'number' },
			},
			required: ['active', 'count'],
		};

		const result = await submit(schema, { active: 'true', count: '42' });

		expect(result).toEqual({
			valid: true,
			payload: { active: true, count: 42 },
		});
	});

	it('flags an enum value not in options', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] } },
			required: ['color'],
		};

		const result = await submit(schema, { color: 'purple' });

		expect(result.valid).toBe(false);
		if (result.valid) throw new Error('expected invalid result');
		expect(result.errors[0]?.path).toEqual(['color']);
	});

	it('accepts an enum value that is in options', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] } },
			required: ['color'],
		};

		const result = await submit(schema, { color: 'green' });

		expect(result).toEqual({ valid: true, payload: { color: 'green' } });
	});

	it('omits an optional field that was not provided', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { hint: { type: 'string' } },
		};

		const result = await submit(schema, {});

		expect(result).toEqual({ valid: true, payload: {} });
	});

	it('applies a default value when the field was not provided', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { count: { type: 'number', default: 5 } },
		};

		const result = await submit(schema, {});

		expect(result).toEqual({ valid: true, payload: { count: 5 } });
	});

	it('treats empty-string input as "field not provided" for optional fields', async () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { note: { type: 'string' } },
		};

		const result = await submit(schema, { note: '' });

		expect(result).toEqual({ valid: true, payload: {} });
	});
});
