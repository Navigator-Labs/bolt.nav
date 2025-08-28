import { createScopedLogger } from '~/utils/logger';
import { MCPService } from '~/lib/services/mcpService';

const logger = createScopedLogger('api.mcp-check');

export async function loader() {
  try {
    // Create a request-scoped MCP service instance
    const mcpService = MCPService.createRequestInstance();
    const serverTools = await mcpService.checkServersAvailabilities();

    return Response.json(serverTools);
  } catch (error) {
    logger.error('Error checking MCP servers:', error);
    return Response.json({ error: 'Failed to check MCP servers' }, { status: 500 });
  }
}
