import type { Schema } from './types.ts';

/**
 * Lightweight JSON Schema validator.
 * Supports the subset of JSON Schema needed for OpenAPI 3.x response validation:
 * object, array, string, number, integer, boolean, enum, required, nullable,
 * oneOf, anyOf, allOf, $ref resolution.
 */

export interface JSONSchemaDefinition {
  type?: string | string[];
  properties?: Record<string, JSONSchemaDefinition>;
  required?: string[];
  items?: JSONSchemaDefinition;
  enum?: unknown[];
  nullable?: boolean;
  oneOf?: JSONSchemaDefinition[];
  anyOf?: JSONSchemaDefinition[];
  allOf?: JSONSchemaDefinition[];
  $ref?: string;
  additionalProperties?: boolean | JSONSchemaDefinition;
  format?: string;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
}

const REF_PREFIX_PATTERN = /^#\//;

export class ValidationError extends Error {
  constructor(
    message: string,
    public path: string[] = [],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class JSONSchemaValidator<T = unknown> implements Schema<T> {
  constructor(
    private schema: JSONSchemaDefinition,
    private definitions: Record<string, JSONSchemaDefinition> = {},
  ) {}

  parse(data: unknown): T {
    this.validate(data, this.schema, []);
    return data as T;
  }

  private resolve(schema: JSONSchemaDefinition): JSONSchemaDefinition {
    if (schema.$ref) {
      const refPath = schema.$ref.replace(REF_PREFIX_PATTERN, '').split('/');
      let resolved: Record<string, unknown> = this.definitions as Record<string, unknown>;
      for (const segment of refPath) {
        if (resolved && typeof resolved === 'object' && segment in resolved) {
          resolved = resolved[segment] as Record<string, unknown>;
        }
        else {
          throw new ValidationError(`Cannot resolve $ref: ${schema.$ref}`);
        }
      }
      return resolved as unknown as JSONSchemaDefinition;
    }
    return schema;
  }

  private validate(
    data: unknown,
    rawSchema: JSONSchemaDefinition,
    path: string[],
  ): void {
    const schema = this.resolve(rawSchema);

    // nullable check
    if (data === null) {
      if (schema.nullable)
        return;
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (types.includes('null'))
        return;
      throw new ValidationError(
        `Expected non-null value at ${pathStr(path)}`,
        path,
      );
    }

    // allOf — data must match ALL schemas
    if (schema.allOf) {
      for (const sub of schema.allOf) {
        this.validate(data, sub, path);
      }
      return;
    }

    // oneOf — data must match exactly ONE schema
    if (schema.oneOf) {
      let matches = 0;
      for (const sub of schema.oneOf) {
        try {
          this.validate(data, sub, path);
          matches++;
        }
        catch {
          // not a match
        }
      }
      if (matches !== 1) {
        throw new ValidationError(
          `Expected exactly one schema to match at ${pathStr(path)}, matched ${matches}`,
          path,
        );
      }
      return;
    }

    // anyOf — data must match at least one schema
    if (schema.anyOf) {
      for (const sub of schema.anyOf) {
        try {
          this.validate(data, sub, path);
          return;
        }
        catch {
          // try next
        }
      }
      throw new ValidationError(
        `Expected at least one schema to match at ${pathStr(path)}`,
        path,
      );
    }

    // enum
    if (schema.enum) {
      if (!schema.enum.includes(data)) {
        throw new ValidationError(
          `Value ${JSON.stringify(data)} not in enum [${schema.enum.map(v => JSON.stringify(v)).join(', ')}] at ${pathStr(path)}`,
          path,
        );
      }
      return;
    }

    // type check
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actualType = getJSONType(data);
      // In JSON Schema, "number" matches integers too
      const matches = types.includes(actualType)
        || (actualType === 'integer' && types.includes('number'));
      if (!matches) {
        throw new ValidationError(
          `Expected ${types.join(' | ')} but got ${actualType} at ${pathStr(path)}`,
          path,
        );
      }
    }

    // string constraints
    if (schema.type === 'string' && typeof data === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        throw new ValidationError(
          `String too short (min ${schema.minLength}) at ${pathStr(path)}`,
          path,
        );
      }
      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        throw new ValidationError(
          `String too long (max ${schema.maxLength}) at ${pathStr(path)}`,
          path,
        );
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
        throw new ValidationError(
          `String does not match pattern ${schema.pattern} at ${pathStr(path)}`,
          path,
        );
      }
    }

    // number constraints
    if (
      (schema.type === 'number' || schema.type === 'integer')
      && typeof data === 'number'
    ) {
      if (schema.minimum !== undefined && data < schema.minimum) {
        throw new ValidationError(
          `Number below minimum ${schema.minimum} at ${pathStr(path)}`,
          path,
        );
      }
      if (schema.maximum !== undefined && data > schema.maximum) {
        throw new ValidationError(
          `Number above maximum ${schema.maximum} at ${pathStr(path)}`,
          path,
        );
      }
    }

    // object
    if (schema.type === 'object' || schema.properties) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new ValidationError(
          `Expected object at ${pathStr(path)}`,
          path,
        );
      }
      const obj = data as Record<string, unknown>;

      // required
      if (schema.required) {
        for (const key of schema.required) {
          if (!(key in obj)) {
            throw new ValidationError(
              `Missing required property "${key}" at ${pathStr(path)}`,
              [...path, key],
            );
          }
        }
      }

      // validate properties
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in obj) {
            this.validate(obj[key], propSchema, [...path, key]);
          }
        }
      }
    }

    // array
    if (schema.type === 'array' || schema.items) {
      if (!Array.isArray(data)) {
        throw new ValidationError(
          `Expected array at ${pathStr(path)}`,
          path,
        );
      }
      if (schema.minItems !== undefined && data.length < schema.minItems) {
        throw new ValidationError(
          `Array too short (min ${schema.minItems}) at ${pathStr(path)}`,
          path,
        );
      }
      if (schema.maxItems !== undefined && data.length > schema.maxItems) {
        throw new ValidationError(
          `Array too long (max ${schema.maxItems}) at ${pathStr(path)}`,
          path,
        );
      }
      if (schema.items) {
        for (let i = 0; i < data.length; i++) {
          this.validate(data[i], schema.items, [...path, String(i)]);
        }
      }
    }
  }
}

function getJSONType(value: unknown): string {
  if (value === null)
    return 'null';
  if (Array.isArray(value))
    return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value; // "string" | "boolean" | "object" | "undefined"
}

function pathStr(path: string[]): string {
  return path.length === 0 ? 'root' : path.join('.');
}
