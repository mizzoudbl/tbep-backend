import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const MODEL_DEFINITIONS = {
  GPT_OSS: { provider: 'nvidia', name: 'openai/gpt-oss-120b' },
  LLAMA_3: { provider: 'nvidia', name: 'meta/llama-3.3-70b-instruct' },
  DEEPSEEK_R1: { provider: 'nvidia', name: 'deepseek-ai/deepseek-r1-0528' },
} as const;

export type ModelKey = keyof typeof MODEL_DEFINITIONS;

// Mapping from key to full id (strongly typed) + frozen
export const MODEL_IDS = Object.freeze(
  Object.fromEntries(Object.entries(MODEL_DEFINITIONS).map(([k, def]) => [k, `${def.provider}:${def.name}`])) as {
    [K in ModelKey]: `${(typeof MODEL_DEFINITIONS)[K]['provider']}:${(typeof MODEL_DEFINITIONS)[K]['name']}`;
  },
);

// Union of full model IDs
export type ModelId = (typeof MODEL_IDS)[ModelKey];

// Array of model id literals for schema building / validation
export const MODEL_ID_LIST = Object.values(MODEL_IDS);

// Default model (can be changed in one place)
// NOTE: Use GPT_OSS for tool calling support - Llama models have limited function calling support
export const DEFAULT_MODEL: ModelId = MODEL_IDS.GPT_OSS;

// Helper to resolve a model id safely by key
export function getModelId(key: ModelKey): ModelId {
  return MODEL_IDS[key];
}

// Schema uses derived literal union of model IDs from single source of truth
export const PromptDtoSchema = z.object({
  model: z.enum(MODEL_ID_LIST).optional(),
  messages: z.array(z.any()).optional(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

export class PromptDto extends createZodDto(PromptDtoSchema) {}
