# ADR 5: Field-level "graceful ladder" fallback for unsupported schema shapes

**Status:** Accepted
**Date:** 2026-07-03

## Context

MCP tool schemas are arbitrary JSON Schema. Rendering every possible shape as native form fields — `oneOf`, `anyOf`, `$ref` chains, arrays of arbitrary objects, base64 binary — is a large amount of code and a lot of UX surface. Skipping any of them means some tools become uninvokable in argus.

The obvious extremes both fail:
- **Whole-form fallback to raw JSON textarea when any field is unsupported.** Simple to build, but a single `oneOf` field turns the entire form into a JSON blob — the user loses form UX on all the primitive fields they didn't need help with. Defeats the form-engine's purpose on any non-trivial schema.
- **Support every JSON Schema construct natively.** Best UX, but the code volume is prohibitive for MVP and every construct is a testing surface.

## Decision

Ship a **field-level ladder**: the form-engine walks the schema and decides per-field whether to render a real input or a raw-JSON textarea. Other fields in the same form stay as real inputs.

**Rendered as real form fields:**
- primitives: `string`, `number`, `boolean`, `enum`
- nested `object` (recursively — each nested field walks the ladder independently)
- arrays of primitives

**Rendered as raw-JSON textareas (per field):**
- arrays of objects
- `oneOf` / `anyOf`
- `$ref` (and by extension, self-referential schemas)
- base64 / binary strings

**On submit, ajv validates the entire assembled payload** — raw-JSON fields are parsed, merged into the payload object, and the whole thing goes through the same validator regardless of how each field got there. Users still get a proper error if the raw JSON they typed doesn't match the schema.

## Alternatives Considered

- **Whole-form JSON fallback.** Rejected — reason above.
- **Native support for `oneOf` / `anyOf` via a discriminator dropdown.** Rejected for MVP — it's the right long-term move but pushes the ladder's complexity into the walker. Ship the fallback first, upgrade specific fallback cases later without breaking the interface.
- **Native support for `$ref` via inlining.** Deferred — `$ref` resolution needs recursion handling, cycles, etc. Fallback ships now, native support can replace it later.

## Consequences

- The form-engine's public interface (`schemaToForm`, `submit`) is stable across future upgrades — moving a case from "raw-JSON fallback" to "native field" is an internal change with no callers affected.
- The `FormFieldKind` union includes a `raw-json` variant with a `reason` field. The UI uses `reason` to show the user *why* this field fell back ("array of objects", "oneOf") so it doesn't feel arbitrary.
- Test coverage stays tractable: the ladder rules are enumerable, the test-server fixture ([ADR 6](6-in-repo-test-server-fixture.md)) exposes one of each fallback case.
- Users who hit a fallback aren't blocked — they can still invoke the tool. Better than "unsupported schema, sorry."
