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

// Slice 6 covers top-level primitives only. Nested objects, arrays, and
// raw-JSON fallback cases (oneOf/anyOf/$ref/binary) throw the marker below —
// Slice 8 replaces these throws with proper handling. The interface stays
// stable across the upgrade.
const NOT_IMPLEMENTED_MARKER = 'not implemented in Slice 6';

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function classifyProperty(propSchema: unknown, propertyName: string): FormFieldKind {
	if (!isRecord(propSchema)) {
		throw new Error(
			`property "${propertyName}" schema is not an object — ${NOT_IMPLEMENTED_MARKER}`,
		);
	}
	if ('$ref' in propSchema) {
		throw new Error(`property "${propertyName}" uses $ref — ${NOT_IMPLEMENTED_MARKER}`);
	}
	if ('oneOf' in propSchema) {
		throw new Error(`property "${propertyName}" uses oneOf — ${NOT_IMPLEMENTED_MARKER}`);
	}
	if ('anyOf' in propSchema) {
		throw new Error(`property "${propertyName}" uses anyOf — ${NOT_IMPLEMENTED_MARKER}`);
	}
	if (Array.isArray(propSchema.enum)) {
		const options = propSchema.enum.map((v) => String(v));
		return { kind: 'enum', options };
	}
	const type = propSchema.type;
	if (type === 'string') {
		if (propSchema.contentEncoding === 'base64' || propSchema.format === 'binary') {
			throw new Error(`property "${propertyName}" is binary — ${NOT_IMPLEMENTED_MARKER}`);
		}
		return { kind: 'string' };
	}
	if (type === 'number' || type === 'integer') return { kind: 'number' };
	if (type === 'boolean') return { kind: 'boolean' };
	if (type === 'object') {
		throw new Error(`property "${propertyName}" is a nested object — ${NOT_IMPLEMENTED_MARKER}`);
	}
	if (type === 'array') {
		throw new Error(`property "${propertyName}" is an array — ${NOT_IMPLEMENTED_MARKER}`);
	}
	throw new Error(
		`property "${propertyName}" has unsupported schema type ${JSON.stringify(type)} — ${NOT_IMPLEMENTED_MARKER}`,
	);
}

export function schemaToForm(schema: JSONSchema): FormSpec {
	if (!isRecord(schema) || schema.type !== 'object') {
		throw new Error(
			`top-level schema must be an object schema — got type ${JSON.stringify(schema?.type)}`,
		);
	}
	const props = isRecord(schema.properties) ? schema.properties : {};
	const requiredSet = new Set(
		Array.isArray(schema.required)
			? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string')
			: [],
	);

	const fields: FormField[] = [];
	for (const [name, propSchema] of Object.entries(props)) {
		const fieldKind = classifyProperty(propSchema, name);
		const field: FormField = {
			path: [name],
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
	return { fields };
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

function assemblePayload(state: FormState): Record<string, unknown> {
	// Top-level primitives only in Slice 6: keys are single-segment.
	// Empty strings are treated as "field not provided" — form inputs default to
	// '' when the user hasn't typed anything, and we don't want that to shadow
	// schema defaults or force required-field errors when the user meant to omit.
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(state)) {
		if (value === undefined) continue;
		if (typeof value === 'string' && value === '') continue;
		out[key] = value;
	}
	return out;
}

function ajvErrorToPath(err: AjvErrorObject): string[] {
	if (
		err.keyword === 'required' &&
		isRecord(err.params) &&
		typeof err.params.missingProperty === 'string'
	) {
		return [err.params.missingProperty];
	}
	const instancePath = err.instancePath.replace(/^\//, '');
	return instancePath.length === 0 ? [] : instancePath.split('/');
}

export async function submit(schema: JSONSchema, state: FormState): Promise<SubmitResult> {
	const payload = assemblePayload(state);
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
