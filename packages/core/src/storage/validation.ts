/**
 * Composable field validators for JSON store data.
 *
 * Each validator returns a descriptive error string if the field is invalid,
 * or `undefined` if the field passes validation. Compose them with nullish
 * coalescing (`??`) for short-circuit validation chains.
 */

type Obj = Record<string, unknown>;

/**
 * Validates that `value` is a non-null object (not an array).
 * Returns the value cast to `Obj` on success, or an error string.
 */
export function validateObject(value: unknown, context: string): Obj | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${context} is not an object`;
  }
  return value as Obj;
}

/** Validates a required non-empty string field. */
export function requiredString(obj: Obj, field: string, context: string): string | undefined {
  if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
    return `${context} is missing a valid "${field}" (string)`;
  }
  return undefined;
}

/** Validates an optional string field (must be string if present). */
export function optionalString(obj: Obj, field: string, context: string): string | undefined {
  if (obj[field] !== undefined && typeof obj[field] !== 'string') {
    return `${context} has invalid "${field}" (string expected)`;
  }
  return undefined;
}

/** Validates a required field whose value must be in `validValues`. */
export function requiredEnum(
  obj: Obj,
  field: string,
  validValues: Set<string>,
  context: string,
): string | undefined {
  if (typeof obj[field] !== 'string' || !validValues.has(obj[field] as string)) {
    return `${context} has invalid "${field}": ${JSON.stringify(obj[field])}`;
  }
  return undefined;
}

/** Validates a required finite number field. */
export function requiredFiniteNumber(obj: Obj, field: string, context: string): string | undefined {
  if (typeof obj[field] !== 'number' || !Number.isFinite(obj[field] as number)) {
    return `${context} is missing a valid "${field}" (finite number)`;
  }
  return undefined;
}

/** Validates an optional finite number field (must be finite number if present). */
export function optionalFiniteNumber(obj: Obj, field: string, context: string): string | undefined {
  if (obj[field] !== undefined && (typeof obj[field] !== 'number' || !Number.isFinite(obj[field] as number))) {
    return `${context} has invalid "${field}" (finite number expected)`;
  }
  return undefined;
}

/** Validates an optional boolean field (must be boolean if present). */
export function optionalBoolean(obj: Obj, field: string, context: string): string | undefined {
  if (obj[field] !== undefined && typeof obj[field] !== 'boolean') {
    return `${context} has invalid "${field}" (boolean expected)`;
  }
  return undefined;
}
