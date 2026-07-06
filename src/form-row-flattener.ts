import type { FormField, FormSpec, FormState } from './form-engine.js';

// engineering-spec §2.7. Turns a FormSpec + FormState + focused-field index
// into the flat, ordered row list scroll-window operates over. Kept pure so
// tests remain table-driven — no React, no Ink, no side effects.

export type FocusRowKind =
	| 'field-label'
	| 'field-input'
	| 'field-error'
	| 'field-description'
	| 'array-item'
	| 'array-add'
	| 'object-header';

export type FocusRow = {
	kind: FocusRowKind;
	// Index into `FormSpec.fields`. Set to -1 for rows that belong to a nested
	// field the flat index cannot address (e.g., an object's child fields —
	// they're not top-level entries in FormSpec.fields).
	fieldIndex: number;
};

export type FlattenedForm = {
	rows: FocusRow[];
	focusedRowIndex: number;
};

export type FlattenOptions = {
	// Submit-time errors keyed by field path. If a field's path (joined with
	// '.') is present, an error row is emitted for it in place of the description.
	errors?: Array<{ path: string[]; message: string }>;
};

function pathKey(path: string[]): string {
	return path.join('.');
}

function collectFieldRows(
	field: FormField,
	fieldIndex: number,
	state: FormState,
	rows: FocusRow[],
	errorByPath: Map<string, string>,
	// -1 for top-level fields, -1 also for nested children — nested children
	// are not addressable by focused-field index, so their rows carry -1.
	ownerIndex: number,
): number | undefined {
	const kind = field.fieldKind;
	const key = pathKey(field.path);
	const hasError = errorByPath.has(key);

	if (kind.kind === 'object') {
		rows.push({ kind: 'object-header', fieldIndex: ownerIndex });
		const anchor = rows.length - 1;
		for (const child of kind.fields) {
			collectFieldRows(child, fieldIndex, state, rows, errorByPath, -1);
		}
		return anchor;
	}

	if (kind.kind === 'array-of-primitives') {
		rows.push({ kind: 'field-label', fieldIndex: ownerIndex });
		const anchor = rows.length - 1;
		const raw = state[key];
		const items = Array.isArray(raw) ? (raw as unknown[]) : [];
		for (let i = 0; i < items.length; i++) {
			rows.push({ kind: 'array-item', fieldIndex: ownerIndex });
		}
		rows.push({ kind: 'array-add', fieldIndex: ownerIndex });
		if (hasError) rows.push({ kind: 'field-error', fieldIndex: ownerIndex });
		else if (field.description) {
			rows.push({ kind: 'field-description', fieldIndex: ownerIndex });
		}
		return anchor;
	}

	// raw-json: label + one input row. Multi-line textareas are still one
	// windowing row so the scroll math matches the visible frame.
	if (kind.kind === 'raw-json') {
		rows.push({ kind: 'field-label', fieldIndex: ownerIndex });
		rows.push({ kind: 'field-input', fieldIndex: ownerIndex });
		const anchor = rows.length - 1;
		if (hasError) rows.push({ kind: 'field-error', fieldIndex: ownerIndex });
		else if (field.description) {
			rows.push({ kind: 'field-description', fieldIndex: ownerIndex });
		}
		return anchor;
	}

	// Primitive: label + input (+ error XOR description).
	rows.push({ kind: 'field-label', fieldIndex: ownerIndex });
	rows.push({ kind: 'field-input', fieldIndex: ownerIndex });
	const anchor = rows.length - 1;
	if (hasError) rows.push({ kind: 'field-error', fieldIndex: ownerIndex });
	else if (field.description) {
		rows.push({ kind: 'field-description', fieldIndex: ownerIndex });
	}
	return anchor;
}

export function flattenForm(
	spec: FormSpec,
	state: FormState,
	focusedFieldIndex: number,
	options: FlattenOptions = {},
): FlattenedForm {
	const rows: FocusRow[] = [];
	const errorByPath = new Map<string, string>();
	for (const e of options.errors ?? []) errorByPath.set(pathKey(e.path), e.message);

	const anchors: number[] = [];
	for (let i = 0; i < spec.fields.length; i++) {
		const field = spec.fields[i];
		if (!field) continue;
		const anchor = collectFieldRows(field, i, state, rows, errorByPath, i);
		anchors.push(anchor ?? rows.length - 1);
	}

	if (spec.fields.length === 0) {
		return { rows, focusedRowIndex: 0 };
	}

	const clampedFieldIndex = Math.max(0, Math.min(focusedFieldIndex, spec.fields.length - 1));
	const focusedRowIndex = anchors[clampedFieldIndex] ?? 0;
	return { rows, focusedRowIndex };
}
