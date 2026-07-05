import { z, type ZodTypeAny } from 'zod';

export function ensureSchemaName(name?: string) {
  if (name && name.trim().length > 0) {
    return name.trim();
  }
  return 'ResponseSchema';
}

export function convertZodSchema(schema: ZodTypeAny): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Failed to convert schema: ${error.message}`
        : 'Failed to convert schema'
    );
  }
}
