// ajv is loaded lazily inside `submit()` — see ADR 2.
// Do NOT add a static `import` of `ajv` at module top-level;
// `import type` at value position would also leak into TS emit.
// Types below are structural.

export type JSONSchema = Record<string, unknown>;

export type FormFieldKind =
	| { kind: 'string' | 'number' | 'boolean' }
	| { kind: 'enum'; options: string[] }
	| { kind: 'object'; fields: FormField[] }
	| {
			kind: 'array-of-primitives';
			itemKind: 'string' | 'number' | 'boolean';
	  }
	| {
			kind: 'raw-json';
			reason: 'array-of-objects' | 'oneOf' | 'anyOf' | 'ref' | 'binary';
	  };

export type FormField = {
	path: string[];
	label: string;
	required: boolean;
	fieldKind: FormFieldKind;
	default?: unknown;
	description?: string;
};

export type FormSpec = { fields: FormField[] };

export type FormState = Record<string, unknown>;

export type SubmitResult =
	| { valid: true; payload: unknown }
	| {
			valid: false;
			errors: Array<{ path: string[]; message: string }>;
	  };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function primitiveItemKind(itemsSchema: unknown): 'string' | 'number' | 'boolean' | null {
	if (!isRecord(itemsSchema)) return null;
	const t = itemsSchema.type;
	if (t === 'string') return 'string';
	if (t === 'number' || t === 'integer') return 'number';
	if (t === 'boolean') return 'boolean';
	return null;
}

function classifyProperty(
	propSchema: unknown,
	propertyName: string,
	pathPrefix: string[],
): FormFieldKind {
	if (!isRecord(propSchema)) {
		throw new Error(`property "${propertyName}" schema is not an object`);
	}
	if ('$ref' in propSchema) return { kind: 'raw-json', reason: 'ref' };
	if ('oneOf' in propSchema) return { kind: 'raw-json', reason: 'oneOf' };
	if ('anyOf' in propSchema) return { kind: 'raw-json', reason: 'anyOf' };
	if (Array.isArray(propSchema.enum)) {
		const options = propSchema.enum.map((v) => String(v));
		return { kind: 'enum', options };
	}
	const type = propSchema.type;
	if (type === 'string') {
		if (propSchema.contentEncoding === 'base64' || propSchema.format === 'binary') {
			return { kind: 'raw-json', reason: 'binary' };
		}
		return { kind: 'string' };
	}
	if (type === 'number' || type === 'integer') return { kind: 'number' };
	if (type === 'boolean') return { kind: 'boolean' };
	if (type === 'object') {
		return {
			kind: 'object',
			fields: fieldsFromObjectSchema(propSchema, [...pathPrefix, propertyName]),
		};
	}
	if (type === 'array') {
		const items = propSchema.items;
		const itemPrim = primitiveItemKind(items);
		if (itemPrim !== null) {
			return { kind: 'array-of-primitives', itemKind: itemPrim };
		}
		return { kind: 'raw-json', reason: 'array-of-objects' };
	}
	throw new Error(`property "${propertyName}" has unsupported schema type ${JSON.stringify(type)}`);
}

function fieldsFromObjectSchema(schema: JSONSchema, pathPrefix: string[]): FormField[] {
	const props = isRecord(schema.properties) ? schema.properties : {};
	const requiredSet = new Set(
		Array.isArray(schema.required)
			? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string')
			: [],
	);
	const fields: FormField[] = [];
	for (const [name, propSchema] of Object.entries(props)) {
		const fieldKind = classifyProperty(propSchema, name, pathPrefix);
		const field: FormField = {
			path: [...pathPrefix, name],
			label: name,
			required: requiredSet.has(name),
			fieldKind,
		};
		if (isRecord(propSchema)) {
			if ('default' in propSchema) field.default = propSchema.default;
			if (typeof propSchema.description === 'string') {
				field.description = propSchema.description;
			}
		}
		fields.push(field);
	}
	return fields;
}

export function schemaToForm(schema: JSONSchema): FormSpec {
	if (!isRecord(schema) || schema.type !== 'object') {
		throw new Error(
			`top-level schema must be an object schema — got type ${JSON.stringify(schema?.type)}`,
		);
	}
	return { fields: fieldsFromObjectSchema(schema, []) };
}

// Ajv is imported dynamically — no top-level import (ADR 2). Structural types
// let us describe just the surface we use without leaking a value import.
type AjvErrorObject = {
	instancePath: string;
	schemaPath?: string;
	keyword: string;
	params?: Record<string, unknown>;
	message?: string;
};
type AjvValidateFn = ((data: unknown) => boolean) & {
	errors?: AjvErrorObject[] | null;
};
type AjvInstance = { compile(schema: unknown): AjvValidateFn };
type AjvCtor = new (opts: Record<string, unknown>) => AjvInstance;

let ajvInstance: AjvInstance | null = null;

async function getAjv(): Promise<AjvInstance> {
	if (ajvInstance) return ajvInstance;
	const mod: unknown = await import('ajv');
	const modRecord = isRecord(mod) ? mod : {};
	const AjvClass = (modRecord.default ?? mod) as AjvCtor;
	ajvInstance = new AjvClass({
		coerceTypes: true,
		useDefaults: true,
		allErrors: true,
		strict: false,
	});
	return ajvInstance;
}

type ParseError = { path: string[]; message: string };

function assembleFieldValue(
	field: FormField,
	state: FormState,
	errors: ParseError[],
): { present: boolean; value: unknown } {
	const key = field.path.join('.');
	const raw = state[key];

	if (field.fieldKind.kind === 'object') {
		const nested: Record<string, unknown> = {};
		let anyPresent = false;
		for (const child of field.fieldKind.fields) {
			const child_ = assembleFieldValue(child, state, errors);
			if (child_.present) {
				anyPresent = true;
				nested[child.label] = child_.value;
			}
		}
		return anyPresent ? { present: true, value: nested } : { present: false, value: undefined };
	}

	if (field.fieldKind.kind === 'array-of-primitives') {
		if (!Array.isArray(raw)) return { present: false, value: undefined };
		// Drop empty-string rows so users can leave an add-row blank without
		// producing "" items that then fail type coercion.
		const items = (raw as unknown[]).filter((v) => !(typeof v === 'string' && v === ''));
		if (items.length === 0) return { present: false, value: undefined };
		return { present: true, value: items };
	}

	if (field.fieldKind.kind === 'raw-json') {
		if (typeof raw !== 'string' || raw.trim().length === 0) {
			return { present: false, value: undefined };
		}
		try {
			return { present: true, value: JSON.parse(raw) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ path: field.path, message: `invalid JSON: ${message}` });
			return { present: false, value: undefined };
		}
	}

	// Primitives: string / number / boolean / enum — the state value is a raw
	// string. Empty string means "field not provided".
	if (raw === undefined) return { present: false, value: undefined };
	if (typeof raw === 'string' && raw === '') return { present: false, value: undefined };
	return { present: true, value: raw };
}

function assemblePayload(
	spec: FormSpec,
	state: FormState,
	errors: ParseError[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of spec.fields) {
		const { present, value } = assembleFieldValue(field, state, errors);
		if (present) out[field.label] = value;
	}
	return out;
}

function ajvErrorToPath(err: AjvErrorObject): string[] {
	if (
		err.keyword === 'required' &&
		isRecord(err.params) &&
		typeof err.params.missingProperty === 'string'
	) {
		const parent = err.instancePath.replace(/^\//, '');
		const parentSegs = parent.length === 0 ? [] : parent.split('/');
		return [...parentSegs, err.params.missingProperty];
	}
	const instancePath = err.instancePath.replace(/^\//, '');
	return instancePath.length === 0 ? [] : instancePath.split('/');
}

export async function submit(schema: JSONSchema, state: FormState): Promise<SubmitResult> {
	// Rebuild the spec so submit() is stateless w.r.t. caller-side spec drift.
	const spec = schemaToForm(schema);
	const parseErrors: ParseError[] = [];
	const payload = assemblePayload(spec, state, parseErrors);
	if (parseErrors.length > 0) {
		return { valid: false, errors: parseErrors };
	}
	const ajv = await getAjv();
	const validate = ajv.compile(schema);
	const ok = validate(payload);
	if (ok) return { valid: true, payload };
	const errors = (validate.errors ?? []).map((e) => ({
		path: ajvErrorToPath(e),
		message: e.message ?? 'invalid',
	}));
	return { valid: false, errors };
}
