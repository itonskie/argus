# @itonskie/argus

## 0.1.3

### Patch Changes

- 106fb24: Fix #16 — tools with open-ended object schemas are now invokable. Both nested open-object properties (`{ additionalProperties: {} }`, `additionalProperties: true`, `patternProperties`, bare `{ type: "object" }`) and top-level open-object `inputSchema` shapes now render as a raw-JSON textarea instead of an un-fillable empty object.
