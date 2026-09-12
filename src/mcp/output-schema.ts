import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PrivateStoryLockedError } from '../store/private-story-access.ts';

// Every Fabulist tool returns a top-level JSON object through `toolResult`.
// Individual tools may replace this permissive baseline with a narrower schema
// when their result is stable enough to describe field by field.
const objectOutputSchema = z.object({}).passthrough();
type UntypedToolRegistrar = (
  name: string,
  config: Record<string, unknown>,
  callback: (...args: never[]) => unknown,
) => unknown;

/**
 * Keeps OpenAI's tool scanner from treating an otherwise well-described MCP
 * tool as incomplete while preserving existing structuredContent shapes.
 */
export function addDefaultOutputSchema(server: McpServer): void {
  // `registerTool` is a generic method, so `Parameters<>` collapses to `never`.
  // The narrow runtime adapter preserves its public generic signature for all
  // call sites while adding the MCP metadata default in one place.
  const register = server.registerTool.bind(server) as unknown as UntypedToolRegistrar;
  const withDefault = (name: string, config: Record<string, unknown>, callback: (...args: never[]) => unknown) => {
    const withPrivateStorageState = async (...args: never[]) => {
      try {
        return await callback(...args);
      } catch (error) {
        if (!(error instanceof PrivateStoryLockedError)) throw error;
        const state = {
          status: 'locked',
          error: 'Private stories are locked.',
          nextStep: 'Open Fabulist in your browser, unlock Private Storage, then retry this tool.',
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(state) }],
          structuredContent: state,
        };
      }
    };
    return register(name, { outputSchema: objectOutputSchema, ...config }, withPrivateStorageState);
  };
  server.registerTool = withDefault as unknown as McpServer['registerTool'];
}
