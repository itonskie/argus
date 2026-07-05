import { describe, expect, it } from 'vitest';
import type { FormField, FormFieldKind, JSONSchema } from '../src/form-engine.js';
import { schemaToForm, submit } from '../src/form-engine.js';

describe('form-engine.schemaToForm — graceful ladder', () => {
	describe('nested object', () => {
		const schema: JSONSchema = {
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
		};

		it('produces a top-level object field with nested primitive fields', () => {
			const spec = schemaToForm(schema);
			expect(spec.fields).toHaveLength(1);
			const userField = spec.fields[0];
			expect(userField?.path).toEqual(['user']);
			expect(userField?.required).toBe(true);
			expect(userField?.fieldKind.kind).toBe('object');
			if (userField?.fieldKind.kind !== 'object') throw new Error('expected object');
			const nested = userField.fieldKind.fields;
			expect(nested).toHaveLength(2);
			expect(nested[0]).toEqual<FormField>({
				path: ['user', 'name'],
				label: 'name',
				required: true,
				fieldKind: { kind: 'string' },
			});
			expect(nested[1]).toEqual<FormField>({
				path: ['user', 'age'],
				label: 'age',
				required: false,
				fieldKind: { kind: 'number' },
			});
		});
	});

	describe('array-of-primitives', () => {
		const cases: Array<{
			label: string;
			itemType: string;
			expectedItemKind: 'string' | 'number' | 'boolean';
		}> = [
			{ label: 'string', itemType: 'string', expectedItemKind: 'string' },
			{ label: 'number', itemType: 'number', expectedItemKind: 'number' },
			{ label: 'integer', itemType: 'integer', expectedItemKind: 'number' },
			{ label: 'boolean', itemType: 'boolean', expectedItemKind: 'boolean' },
		];

		for (const c of cases) {
			it(`maps array<${c.label}> to array-of-primitives`, () => {
				const schema: JSONSchema = {
					type: 'object',
					properties: {
						tags: { type: 'array', items: { type: c.itemType } },
					},
				};
				const spec = schemaToForm(schema);
				expect(spec.fields).toHaveLength(1);
				expect(spec.fields[0]?.fieldKind).toEqual<FormFieldKind>({
					kind: 'array-of-primitives',
					itemKind: c.expectedItemKind,
				});
			});
		}
	});

	describe('raw-JSON fallback', () => {
		const cases: Array<{
			label: string;
			propertySchema: JSONSchema;
			reason: 'array-of-objects' | 'oneOf' | 'anyOf' | 'ref' | 'binary' | 'open-object';
			topLevelExtras?: JSONSchema;
		}> = [
			{
				label: 'array of objects',
				propertySchema: {
					type: 'array',
					items: { type: 'object', properties: { id: { type: 'number' } } },
				},
				reason: 'array-of-objects',
			},
			{
				label: 'oneOf',
				propertySchema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
				reason: 'oneOf',
			},
			{
				label: 'anyOf',
				propertySchema: { anyOf: [{ type: 'string' }, { type: 'number' }] },
				reason: 'anyOf',
			},
			{
				label: '$ref',
				propertySchema: { $ref: '#/$defs/Node' },
				reason: 'ref',
				topLevelExtras: {
					$defs: {
						Node: { type: 'object', properties: { label: { type: 'string' } } },
					},
				},
			},
			{
				label: 'base64 binary',
				propertySchema: { type: 'string', contentEncoding: 'base64' },
				reason: 'binary',
			},
			{
				label: 'binary format string',
				propertySchema: { type: 'string', format: 'binary' },
				reason: 'binary',
			},
			{
				label: 'open object (additionalProperties: {})',
				propertySchema: { type: 'object', additionalProperties: {} },
				reason: 'open-object',
			},
			{
				label: 'open object (additionalProperties: true)',
				propertySchema: { type: 'object', additionalProperties: true },
				reason: 'open-object',
			},
			{
				label: 'open object (patternProperties only)',
				propertySchema: {
					type: 'object',
					patternProperties: { '^x-': { type: 'string' } },
				},
				reason: 'open-object',
			},
			{
				label: 'open object (bare {type:object} with no constraints)',
				propertySchema: { type: 'object' },
				reason: 'open-object',
			},
		];

		for (const c of cases) {
			it(`maps ${c.label} to raw-json with reason=${c.reason}`, () => {
				const schema: JSONSchema = {
					type: 'object',
					properties: { field: c.propertySchema },
					...(c.topLevelExtras ?? {}),
				};
				const spec = schemaToForm(schema);
				expect(spec.fields).toHaveLength(1);
				expect(spec.fields[0]?.fieldKind).toEqual<FormFieldKind>({
					kind: 'raw-json',
					reason: c.reason,
				});
			});
		}
	});

	describe('open-object corner cases', () => {
		it('does NOT treat a closed empty object as open-object', () => {
			// `additionalProperties: false` makes this a truly-closed empty
			// object — the payload must literally be `{}`. Do not fall back.
			const schema: JSONSchema = {
				type: 'object',
				properties: {
					meta: { type: 'object', properties: {}, additionalProperties: false },
				},
			};
			const spec = schemaToForm(schema);
			expect(spec.fields[0]?.fieldKind.kind).toBe('object');
		});

		it('matches the lathe-mcp repro schema — required `data` renders as raw-JSON', () => {
			// Exact reproduction of the schema in issue #16: a required object
			// property with `additionalProperties: {}` used to render as a
			// collapsed object with zero sub-fields (un-fillable).
			const schema: JSONSchema = {
				type: 'object',
				properties: {
					data: {
						type: 'object',
						additionalProperties: {},
						description: 'Resume data object',
					},
					template: { type: 'string' },
				},
				required: ['data', 'template'],
			};
			const spec = schemaToForm(schema);
			expect(spec.fields).toHaveLength(2);
			const dataField = spec.fields.find((f) => f.label === 'data');
			expect(dataField?.required).toBe(true);
			expect(dataField?.fieldKind).toEqual<FormFieldKind>({
				kind: 'raw-json',
				reason: 'open-object',
			});
			expect(dataField?.description).toBe('Resume data object');
		});
	});

	it('does not throw on the full mixed schema (nested + array + raw-json fallbacks side-by-side)', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: {
				user: { type: 'object', properties: { name: { type: 'string' } } },
				tags: { type: 'array', items: { type: 'string' } },
				choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
				blob: { type: 'string', contentEncoding: 'base64' },
			},
		};
		expect(() => schemaToForm(schema)).not.toThrow();
	});
});

describe('form-engine.submit — graceful ladder', () => {
	describe('nested object', () => {
		const schema: JSONSchema = {
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
		};

		it('assembles nested object from dotted-path state', async () => {
			const result = await submit(schema, {
				'user.name': 'ada',
				'user.age': '42',
			});
			expect(result).toEqual({
				valid: true,
				payload: { user: { name: 'ada', age: 42 } },
			});
		});

		it('flags a missing required nested field', async () => {
			const result = await submit(schema, { 'user.age': '10' });
			expect(result.valid).toBe(false);
			if (result.valid) throw new Error('expected invalid');
			// The missing property is `name` inside `user`.
			expect(result.errors.some((e) => e.path.join('.') === 'user.name')).toBe(true);
		});
	});

	describe('array-of-primitives', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: {
				tags: { type: 'array', items: { type: 'string' } },
			},
			required: ['tags'],
		};

		it('assembles a string array from array-valued state', async () => {
			const result = await submit(schema, { tags: ['a', 'b', 'c'] });
			expect(result).toEqual({ valid: true, payload: { tags: ['a', 'b', 'c'] } });
		});

		it('coerces each item for array<number>', async () => {
			const numSchema: JSONSchema = {
				type: 'object',
				properties: {
					counts: { type: 'array', items: { type: 'number' } },
				},
				required: ['counts'],
			};
			const result = await submit(numSchema, { counts: ['1', '2', '3'] });
			expect(result).toEqual({ valid: true, payload: { counts: [1, 2, 3] } });
		});

		it('drops empty-string rows so users can leave an add-row blank', async () => {
			const result = await submit(schema, { tags: ['a', '', 'c'] });
			expect(result).toEqual({ valid: true, payload: { tags: ['a', 'c'] } });
		});
	});

	describe('raw-JSON fields', () => {
		const oneOfSchema: JSONSchema = {
			type: 'object',
			properties: {
				value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
			},
			required: ['value'],
		};

		it('parses and validates a raw-JSON value that matches the schema', async () => {
			const result = await submit(oneOfSchema, { value: '"hello"' });
			expect(result).toEqual({ valid: true, payload: { value: 'hello' } });
		});

		it('reports a syntax error on malformed JSON before ajv runs', async () => {
			const result = await submit(oneOfSchema, { value: '{ bad json' });
			expect(result.valid).toBe(false);
			if (result.valid) throw new Error('expected invalid');
			const err = result.errors.find((e) => e.path.join('.') === 'value');
			expect(err).toBeDefined();
			expect(err?.message.toLowerCase()).toMatch(/json|parse|syntax/);
		});

		it('reports an ajv validation error when parsed JSON does not match schema', async () => {
			// Arrays match neither `string` nor `number` and cannot be coerced.
			const result = await submit(oneOfSchema, { value: '[1,2,3]' });
			expect(result.valid).toBe(false);
			if (result.valid) throw new Error('expected invalid');
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it('parses an array-of-objects raw-JSON payload', async () => {
			const schema: JSONSchema = {
				type: 'object',
				properties: {
					items: {
						type: 'array',
						items: {
							type: 'object',
							properties: { id: { type: 'number' } },
							required: ['id'],
						},
					},
				},
				required: ['items'],
			};
			const result = await submit(schema, {
				items: '[{"id":1},{"id":2}]',
			});
			expect(result).toEqual({
				valid: true,
				payload: { items: [{ id: 1 }, { id: 2 }] },
			});
		});

		describe('open-object raw-JSON', () => {
			const schema: JSONSchema = {
				type: 'object',
				properties: {
					data: { type: 'object', additionalProperties: {} },
					template: { type: 'string' },
				},
				required: ['data', 'template'],
			};

			it('parses a JSON object typed into the raw-JSON field', async () => {
				const result = await submit(schema, {
					data: '{"name":"ada","age":42}',
					template: 'basic',
				});
				expect(result).toEqual({
					valid: true,
					payload: {
						data: { name: 'ada', age: 42 },
						template: 'basic',
					},
				});
			});

			it('flags a missing required open-object field', async () => {
				const result = await submit(schema, { template: 'basic' });
				expect(result.valid).toBe(false);
				if (result.valid) throw new Error('expected invalid');
				expect(result.errors.some((e) => e.path.join('.') === 'data')).toBe(true);
			});

			it('reports a JSON syntax error before ajv runs', async () => {
				const result = await submit(schema, {
					data: '{not-json',
					template: 'basic',
				});
				expect(result.valid).toBe(false);
				if (result.valid) throw new Error('expected invalid');
				const err = result.errors.find((e) => e.path.join('.') === 'data');
				expect(err).toBeDefined();
				expect(err?.message.toLowerCase()).toMatch(/json|parse|syntax/);
			});

			it('rejects a non-object JSON payload for a required object field', async () => {
				// Typing `42` — valid JSON but not an object; ajv should reject.
				const result = await submit(schema, {
					data: '42',
					template: 'basic',
				});
				expect(result.valid).toBe(false);
			});
		});

		it('resolves $ref and validates against the referenced schema', async () => {
			const schema: JSONSchema = {
				type: 'object',
				properties: { node: { $ref: '#/$defs/Node' } },
				required: ['node'],
				$defs: {
					Node: {
						type: 'object',
						properties: { label: { type: 'string' } },
						required: ['label'],
					},
				},
			};
			const good = await submit(schema, { node: '{"label":"root"}' });
			expect(good).toEqual({
				valid: true,
				payload: { node: { label: 'root' } },
			});
			const bad = await submit(schema, { node: '{}' });
			expect(bad.valid).toBe(false);
		});
	});
});
