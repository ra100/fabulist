import { z } from 'zod';

export const playBodySchema = z.object({
  input: z.string().trim().min(1, 'input required'),
  overrideIntegrity: z.boolean().optional(),
}).strict();
