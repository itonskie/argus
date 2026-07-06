import { describe, expect, it } from 'vitest';
import type { FormField, FormSpec, FormState } from '../src/form-engine.js';
import { flattenForm } from '../src/form-row-flattener.js';

// Small helpers to build FormSpecs without repeating boilerplate. The tests
// use the same field shapes as tests/form-engine-*.test.ts so a change to the
// FormField contract fails both suites in a coordinated way.
function stringField(name: string, extras: Partial<FormField> = {}): FormField {
	return {
		path: [name],
		label: name,
		required: false,
		fieldKind: { kind: 'string' },
		...extras,
	};
}

function numberField(name: string, extras: Partial<FormField> = {}): FormField {
	return {
		path: [name],
		label: name,
		required: false,
		fieldKind: { kind: 'number' },
		...extras,
	};
}

describe('flattenForm', () => {
	it('flat spec: two string fields → two (label,input) pairs; focus on field 0 anchors row 1', () => {
		// TDD entry-point case from ticket #24.
		const spec: FormSpec = { fields: [stringField('a'), stringField('b')] };
		const state: FormState = {};
		const result = flattenForm(spec, state, 0);

		expect(result.rows).toEqual([
			{ kind: 'field-label', fieldIndex: 0 },
			{ kind: 'field-input', fieldIndex: 0 },
			{ kind: 'field-label', fieldIndex: 1 },
			{ kind: 'field-input', fieldIndex: 1 },
		]);
		expect(result.focusedRowIndex).toBe(1);
	});

	it('flat spec: focus on field 1 anchors that field’s input row', () => {
		const spec: FormSpec = { fields: [stringField('a'), stringField('b')] };
		const result = flattenForm(spec, {}, 1);
		expect(result.focusedRowIndex).toBe(3);
	});

	it('field with description: adds a field-description row after the input', () => {
		const spec: FormSpec = {
			fields: [stringField('a', { description: 'first field' }), stringField('b')],
		};
		const result = flattenForm(spec, {}, 1);

		expect(result.rows).toEqual([
			{ kind: 'field-label', fieldIndex: 0 },
			{ kind: 'field-input', fieldIndex: 0 },
			{ kind: 'field-description', fieldIndex: 0 },
			{ kind: 'field-label', fieldIndex: 1 },
			{ kind: 'field-input', fieldIndex: 1 },
		]);
		// Description row for field 0 shifts field 1's input down by one.
		expect(result.focusedRowIndex).toBe(4);
	});

	it('field with error and description: emits field-error, no field-description (error supersedes)', () => {
		// Matches app-shell FormBody rendering: error and description share a slot
		// and error wins. Flattener mirrors that so the flat height matches what
		// the pane actually paints.
		const spec: FormSpec = {
			fields: [stringField('a', { description: 'first field' }), stringField('b')],
		};
		const state: FormState = { a: '' };
		const result = flattenForm(spec, state, 0, {
			errors: [{ path: ['a'], message: 'required' }],
		});

		expect(result.rows).toEqual([
			{ kind: 'field-label', fieldIndex: 0 },
			{ kind: 'field-input', fieldIndex: 0 },
			{ kind: 'field-error', fieldIndex: 0 },
			{ kind: 'field-label', fieldIndex: 1 },
			{ kind: 'field-input', fieldIndex: 1 },
		]);
		expect(result.focusedRowIndex).toBe(1);
	});

	it('nested object: emits an object-header, then flattens child fields', () => {
		const inner: FormField[] = [stringField('name'), numberField('age')];
		const spec: FormSpec = {
			fields: [
				{
					path: ['user'],
					label: 'user',
					required: true,
					fieldKind: { kind: 'object', fields: inner },
				},
			],
		};
		const result = flattenForm(spec, {}, 0);

		// The parent object field emits an `object-header` row; child fields
		// contribute their own label/input pairs. The focused field (index 0 =
		// the parent) anchors on the header row.
		expect(result.rows).toEqual([
			{ kind: 'object-header', fieldIndex: 0 },
			{ kind: 'field-label', fieldIndex: -1 },
			{ kind: 'field-input', fieldIndex: -1 },
			{ kind: 'field-label', fieldIndex: -1 },
			{ kind: 'field-input', fieldIndex: -1 },
		]);
		expect(result.focusedRowIndex).toBe(0);
	});

	it('array-of-primitives: emits label, one row per item, plus an array-add affordance', () => {
		const spec: FormSpec = {
			fields: [
				{
					path: ['tags'],
					label: 'tags',
					required: false,
					fieldKind: { kind: 'array-of-primitives', itemKind: 'string' },
				},
			],
		};
		const state: FormState = { tags: ['alpha', 'beta'] };
		const result = flattenForm(spec, state, 0);

		expect(result.rows).toEqual([
			{ kind: 'field-label', fieldIndex: 0 },
			{ kind: 'array-item', fieldIndex: 0 },
			{ kind: 'array-item', fieldIndex: 0 },
			{ kind: 'array-add', fieldIndex: 0 },
		]);
		// Focused field points at the label row; scroll-window clamp anchors
		// on the label so the array rows below stay in view when possible.
		expect(result.focusedRowIndex).toBe(0);
	});

	it('array-of-primitives with empty state defaults to zero items + array-add', () => {
		const spec: FormSpec = {
			fields: [
				{
					path: ['tags'],
					label: 'tags',
					required: false,
					fieldKind: { kind: 'array-of-primitives', itemKind: 'string' },
				},
			],
		};
		const result = flattenForm(spec, {}, 0);
		expect(result.rows).toEqual([
			{ kind: 'field-label', fieldIndex: 0 },
			{ kind: 'array-add', fieldIndex: 0 },
		]);
	});

	it('raw-json: emits a label + a single input row (the multi-line textarea is one row for windowing)', () => {
		const spec: FormSpec = {
			fields: [
				{
					path: ['payload'],
					label: 'payload',
					required: true,
					fieldKind: { kind: 'raw-json', reason: 'array-of-objects' },
				},
			],
		};
		const result = flattenForm(spec, {}, 0);

		expect(result.rows).toEqual([
			{ kind: 'field-label', fieldIndex: 0 },
			{ kind: 'field-input', fieldIndex: 0 },
		]);
		expect(result.focusedRowIndex).toBe(1);
	});

	it('focus mapping: adding an array item shifts the focused-row index for a later field', () => {
		// tags has 1 item now → later "notes" field's input row sits at index 4.
		const spec: FormSpec = {
			fields: [
				{
					path: ['tags'],
					label: 'tags',
					required: false,
					fieldKind: { kind: 'array-of-primitives', itemKind: 'string' },
				},
				stringField('notes'),
			],
		};
		let state: FormState = { tags: ['x'] };
		let result = flattenForm(spec, state, 1);
		expect(result.focusedRowIndex).toBe(4); // [tags-label][item][add][notes-label][notes-input]

		// Add a second array item — the index of notes' input row shifts by one.
		state = { tags: ['x', 'y'] };
		result = flattenForm(spec, state, 1);
		expect(result.focusedRowIndex).toBe(5); // [tags-label][item][item][add][notes-label][notes-input]
	});

	it('focus mapping: removing an array item shifts the focused-row index back', () => {
		const spec: FormSpec = {
			fields: [
				{
					path: ['tags'],
					label: 'tags',
					required: false,
					fieldKind: { kind: 'array-of-primitives', itemKind: 'string' },
				},
				stringField('notes'),
			],
		};
		let state: FormState = { tags: ['a', 'b', 'c'] };
		let result = flattenForm(spec, state, 1);
		expect(result.focusedRowIndex).toBe(6);

		state = { tags: ['a'] };
		result = flattenForm(spec, state, 1);
		expect(result.focusedRowIndex).toBe(4);
	});

	it('empty spec: no rows, focusedRowIndex clamps to 0', () => {
		const result = flattenForm({ fields: [] }, {}, 0);
		expect(result.rows).toEqual([]);
		expect(result.focusedRowIndex).toBe(0);
	});

	it('out-of-range focused field index: clamps to the last valid input row', () => {
		const spec: FormSpec = { fields: [stringField('a'), stringField('b')] };
		const result = flattenForm(spec, {}, 42);
		// Clamped to field index 1 → input row at index 3.
		expect(result.focusedRowIndex).toBe(3);
	});
});
