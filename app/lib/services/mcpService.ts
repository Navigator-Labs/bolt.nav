import {
  experimental_createMCPClient,
  type ToolSet,
  type Message,
  type DataStreamWriter,
  convertToCoreMessages,
  formatDataStreamPart,
} from 'ai';
import { Experimental_StdioMCPTransport } from 'ai/mcp-stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { ToolCallAnnotation } from '~/types/context';
import {
  TOOL_EXECUTION_APPROVAL,
  TOOL_EXECUTION_DENIED,
  TOOL_EXECUTION_ERROR,
  TOOL_NO_EXECUTE_FUNCTION,
} from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('mcp-service');

export const stdioServerConfigSchema = z
  .object({
    type: z.enum(['stdio']).optional(),
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
  })
  .transform((data) => ({
    ...data,
    type: 'stdio' as const,
  }));
export type STDIOServerConfig = z.infer<typeof stdioServerConfigSchema>;

export const sseServerConfigSchema = z
  .object({
    type: z.enum(['sse']).optional(),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string()).optional(),
  })
  .transform((data) => ({
    ...data,
    type: 'sse' as const,
  }));
export type SSEServerConfig = z.infer<typeof sseServerConfigSchema>;

export const streamableHTTPServerConfigSchema = z
  .object({
    type: z.enum(['streamable-http']).optional(),
    url: z.string().url('URL must be a valid URL format'),
    headers: z.record(z.string()).optional(),
  })
  .transform((data) => ({
    ...data,
    type: 'streamable-http' as const,
  }));

export type StreamableHTTPServerConfig = z.infer<typeof streamableHTTPServerConfigSchema>;

export const mcpServerConfigSchema = z.union([
  stdioServerConfigSchema,
  sseServerConfigSchema,
  streamableHTTPServerConfigSchema,
]);
export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
});
export type MCPConfig = z.infer<typeof mcpConfigSchema>;

export type MCPClient = {
  tools: () => Promise<ToolSet>;
  close: () => Promise<void>;
} & {
  serverName: string;
};

export type ToolCall = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type MCPServerTools = Record<string, MCPServer>;

export type MCPServerAvailable = {
  status: 'available';
  tools: ToolSet;
  client: MCPClient;
  config: MCPServerConfig;
};
export type MCPServerUnavailable = {
  status: 'unavailable';
  error: string;
  client: MCPClient | null;
  config: MCPServerConfig;
};
export type MCPServer = MCPServerAvailable | MCPServerUnavailable;

// Global configuration cache (read-only after initialization)
let globalConfig: MCPConfig | null = null;
let globalMetadataCache: {
  toolsWithoutExecute: ToolSet;
  toolNamesToServerNames: Map<string, string>;
  mcpToolsPerServer: MCPServerTools;
} | null = null;

/*
 * Note: We don't cache clients globally in Cloudflare Workers
 * due to I/O isolation between requests
 */

export class MCPService {
  private _tools: ToolSet = {};
  private _toolsWithoutExecute: ToolSet = {};
  private _mcpToolsPerServer: MCPServerTools = {};
  private _toolNamesToServerNames = new Map<string, string>();
  private _config: MCPConfig = {
    mcpServers: {},
  };
  private _clients: MCPClient[] = [];
  private _forceCreateClients: boolean = false;
  private _lazyClients = new Map<string, MCPClient>();

  constructor(config?: MCPConfig) {
    if (config) {
      this._config = config;
    } else if (globalConfig) {
      this._config = globalConfig;

      // Use cached metadata if available
      if (globalMetadataCache) {
        this._toolsWithoutExecute = { ...globalMetadataCache.toolsWithoutExecute };
        this._toolNamesToServerNames = new Map(globalMetadataCache.toolNamesToServerNames);
        this._mcpToolsPerServer = { ...globalMetadataCache.mcpToolsPerServer };

        // Note: _tools will be populated lazily when needed
      }
    }
  }

  // Static method to update global configuration (called once at startup)
  static async updateGlobalConfig(config: MCPConfig): Promise<MCPServerTools> {
    globalConfig = config;

    const service = new MCPService(config);
    service._forceCreateClients = true; // Force creation for metadata extraction
    await service._createClients();

    // Cache only the metadata (not the clients with I/O objects)
    globalMetadataCache = {
      toolsWithoutExecute: { ...service._toolsWithoutExecute },
      toolNamesToServerNames: new Map(service._toolNamesToServerNames),
      mcpToolsPerServer: { ...service._mcpToolsPerServer },
    };

    /*
     * Close the clients after extracting metadata
     * In Cloudflare, each request will create its own clients
     */
    await service._closeClients();

    return globalMetadataCache.mcpToolsPerServer;
  }

  // Create a request-scoped instance
  static createRequestInstance(): MCPService {
    return new MCPService();
  }

  private _validateServerConfig(serverName: string, config: any): MCPServerConfig {
    const hasStdioField = config.command !== undefined;
    const hasUrlField = config.url !== undefined;

    if (hasStdioField && hasUrlField) {
      throw new Error(`cannot have "command" and "url" defined for the same server.`);
    }

    if (!config.type && hasStdioField) {
      config.type = 'stdio';
    }

    if (hasUrlField && !config.type) {
      throw new Error(`missing "type" field, only "sse" and "streamable-http" are valid options.`);
    }

    if (!['stdio', 'sse', 'streamable-http'].includes(config.type)) {
      throw new Error(`provided "type" is invalid, only "stdio", "sse" or "streamable-http" are valid options.`);
    }

    // Check for type/field mismatch
    if (config.type === 'stdio' && !hasStdioField) {
      throw new Error(`missing "command" field.`);
    }

    if (['sse', 'streamable-http'].includes(config.type) && !hasUrlField) {
      throw new Error(`missing "url" field.`);
    }

    try {
      return mcpServerConfigSchema.parse(config);
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        const errorMessages = validationError.errors.map((err) => `${err.path.join('.')}: ${err.message}`).join('; ');
        throw new Error(`Invalid configuration for server "${serverName}": ${errorMessages}`);
      }

      throw validationError;
    }
  }

  async updateConfig(config: MCPConfig) {
    logger.debug('updating config', JSON.stringify(config));
    this._config = config;
    await this._createClients();

    return this._mcpToolsPerServer;
  }

  private async _createStreamableHTTPClient(
    serverName: string,
    config: StreamableHTTPServerConfig,
  ): Promise<MCPClient> {
    logger.debug(`Creating Streamable-HTTP client for ${serverName} with URL: ${config.url}`);

    const client = await experimental_createMCPClient({
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
      }),
    });

    return Object.assign(client, { serverName });
  }

  private async _createSSEClient(serverName: string, config: SSEServerConfig): Promise<MCPClient> {
    logger.debug(`Creating SSE client for ${serverName} with URL: ${config.url}`);

    const client = await experimental_createMCPClient({
      transport: config,
    });

    return Object.assign(client, { serverName });
  }

  private async _createStdioClient(serverName: string, config: STDIOServerConfig): Promise<MCPClient> {
    logger.debug(
      `Creating STDIO client for '${serverName}' with command: '${config.command}' ${config.args?.join(' ') || ''}`,
    );

    /*
     * Note: STDIO transport won't work in Cloudflare Workers environment
     * This should only be used in Node.js environments
     */
    const client = await experimental_createMCPClient({ transport: new Experimental_StdioMCPTransport(config) });

    return Object.assign(client, { serverName });
  }

  private _registerTools(serverName: string, tools: ToolSet) {
    for (const [toolName, tool] of Object.entries(tools)) {
      if (this._tools[toolName]) {
        const existingServerName = this._toolNamesToServerNames.get(toolName);

        if (existingServerName && existingServerName !== serverName) {
          logger.warn(`Tool conflict: "${toolName}" from "${serverName}" overrides tool from "${existingServerName}"`);
        }
      }

      this._tools[toolName] = tool;
      this._toolsWithoutExecute[toolName] = { ...tool, execute: undefined };
      this._toolNamesToServerNames.set(toolName, serverName);
    }
  }

  private async _createMCPClient(serverName: string, serverConfig: MCPServerConfig): Promise<MCPClient> {
    const validatedConfig = this._validateServerConfig(serverName, serverConfig);

    if (validatedConfig.type === 'stdio') {
      // Check if we're in a Node.js environment (not Cloudflare Workers)
      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        return await this._createStdioClient(serverName, serverConfig as STDIOServerConfig);
      } else {
        // STDIO won't work in Cloudflare Workers - skip or use alternative
        logger.warn(`STDIO transport is not supported in Cloudflare Workers environment for server: ${serverName}`);
        throw new Error('STDIO transport not supported in this environment');
      }
    } else if (validatedConfig.type === 'sse') {
      return await this._createSSEClient(serverName, serverConfig as SSEServerConfig);
    } else {
      return await this._createStreamableHTTPClient(serverName, serverConfig as StreamableHTTPServerConfig);
    }
  }

  private async _createClients() {
    await this._closeClients();

    /*
     * Skip client creation if we're using cached metadata
     * Clients will be created lazily when tools are executed
     */
    if (globalMetadataCache && this._config === globalConfig && !this._forceCreateClients) {
      return;
    }

    const createClientPromises = Object.entries(this._config?.mcpServers || []).map(async ([serverName, config]) => {
      let client: MCPClient | null = null;

      try {
        client = await this._createMCPClient(serverName, config);
        this._clients.push(client);

        try {
          const tools = await client.tools();

          this._registerTools(serverName, tools);

          this._mcpToolsPerServer[serverName] = {
            status: 'available',
            client,
            tools,
            config,
          };
        } catch (error) {
          logger.error(`Failed to get tools from server ${serverName}:`, error);
          this._mcpToolsPerServer[serverName] = {
            status: 'unavailable',
            error: 'could not retrieve tools from server',
            client,
            config,
          };
        }
      } catch (error) {
        logger.error(`Failed to initialize MCP client for server: ${serverName}`, error);
        this._mcpToolsPerServer[serverName] = {
          status: 'unavailable',
          error: (error as Error).message,
          client,
          config,
        };
      }
    });

    await Promise.allSettled(createClientPromises);
  }

  async checkServersAvailabilities() {
    // For request-scoped instances, just return the cached state
    if (globalMetadataCache && this._config === globalConfig) {
      return this._mcpToolsPerServer;
    }

    // Otherwise, check availability (this should rarely happen)
    this._tools = {};
    this._toolsWithoutExecute = {};
    this._toolNamesToServerNames.clear();

    const checkPromises = Object.entries(this._mcpToolsPerServer).map(async ([serverName, server]) => {
      let client = server.client;

      try {
        logger.debug(`Checking MCP server "${serverName}" availability: start`);

        if (!client) {
          client = await this._createMCPClient(serverName, this._config?.mcpServers[serverName]);
          this._clients.push(client);
        }

        try {
          const tools = await client.tools();

          this._registerTools(serverName, tools);

          this._mcpToolsPerServer[serverName] = {
            status: 'available',
            client,
            tools,
            config: server.config,
          };
        } catch (error) {
          logger.error(`Failed to get tools from server ${serverName}:`, error);
          this._mcpToolsPerServer[serverName] = {
            status: 'unavailable',
            error: 'could not retrieve tools from server',
            client,
            config: server.config,
          };
        }

        logger.debug(`Checking MCP server "${serverName}" availability: end`);
      } catch (error) {
        logger.error(`Failed to connect to server ${serverName}:`, error);
        this._mcpToolsPerServer[serverName] = {
          status: 'unavailable',
          error: 'could not connect to server',
          client,
          config: server.config,
        };
      }
    });

    await Promise.allSettled(checkPromises);

    return this._mcpToolsPerServer;
  }

  private async _closeClients(): Promise<void> {
    const closePromises = this._clients.map(async (client) => {
      try {
        await client.close();
      } catch (error) {
        logger.error(`Error closing client:`, error);
      }
    });

    await Promise.allSettled(closePromises);
    this._clients = [];
    this._lazyClients.clear();
    this._tools = {};
    this._toolsWithoutExecute = {};
    this._mcpToolsPerServer = {};
    this._toolNamesToServerNames.clear();
  }

  // Public method to cleanup request-scoped resources
  async cleanup(): Promise<void> {
    logger.debug('Cleaning up request-scoped MCP clients');
    await this._closeClients();
  }

  isValidToolName(toolName: string): boolean {
    // Check in toolsWithoutExecute since _tools might be empty for lazy-loaded clients
    return toolName in this._toolsWithoutExecute || this._toolNamesToServerNames.has(toolName);
  }

  processToolCall(toolCall: ToolCall, dataStream: DataStreamWriter): void {
    const { toolCallId, toolName } = toolCall;

    if (this.isValidToolName(toolName)) {
      const { description = 'No description available' } = this.toolsWithoutExecute[toolName];
      const serverName = this._toolNamesToServerNames.get(toolName);

      if (serverName) {
        dataStream.writeMessageAnnotation({
          type: 'toolCall',
          toolCallId,
          serverName,
          toolName,
          toolDescription: description,
        } satisfies ToolCallAnnotation);
      }
    }
  }

  private async _getOrCreateLazyClient(serverName: string): Promise<MCPClient | null> {
    // Check if we already have a lazy client for this server
    if (this._lazyClients.has(serverName)) {
      return this._lazyClients.get(serverName)!;
    }

    const serverConfig = this._config.mcpServers[serverName];

    if (!serverConfig) {
      return null;
    }

    try {
      logger.debug(`Creating lazy client for server "${serverName}"`);

      const client = await this._createMCPClient(serverName, serverConfig);
      this._lazyClients.set(serverName, client);
      this._clients.push(client);

      // Get tools from the newly created client
      const tools = await client.tools();

      // Update _tools with executable versions for this server
      for (const [toolName, tool] of Object.entries(tools)) {
        if (this._toolNamesToServerNames.get(toolName) === serverName) {
          this._tools[toolName] = tool;
        }
      }

      return client;
    } catch (error) {
      logger.error(`Failed to create lazy client for server ${serverName}:`, error);
      return null;
    }
  }

  async processToolInvocations(messages: Message[], dataStream: DataStreamWriter): Promise<Message[]> {
    const lastMessage = messages[messages.length - 1];
    const parts = lastMessage.parts;

    if (!parts) {
      return messages;
    }

    const processedParts = await Promise.all(
      parts.map(async (part) => {
        // Only process tool invocations parts
        if (part.type !== 'tool-invocation') {
          return part;
        }

        const { toolInvocation } = part;
        const { toolName, toolCallId } = toolInvocation;

        // Skip if tool doesn't exist
        if (!this.isValidToolName(toolName)) {
          return part;
        }

        /*
         * Check if this is a tool call with an approval/rejection result
         * The toolInvocation might have a result property when approved/rejected
         */
        const invocationResult = (toolInvocation as any).result;

        logger.debug(
          `Processing tool invocation for ${toolName}: state=${toolInvocation.state}, result=${invocationResult}`,
        );

        // Only process if we have an approval/rejection result
        if (!invocationResult) {
          logger.debug(`Skipping tool ${toolName} - no result present`);
          return part;
        }

        let result;

        if (invocationResult === TOOL_EXECUTION_APPROVAL.APPROVE) {
          // For Cloudflare Workers: Create client lazily when tool needs to be executed
          const serverName = this._toolNamesToServerNames.get(toolName);
          logger.debug(`Tool ${toolName} approved, serverName: ${serverName}, has tool: ${!!this._tools[toolName]}`);

          if (serverName && !this._tools[toolName]) {
            logger.debug(`Creating lazy client for server ${serverName}`);
            await this._getOrCreateLazyClient(serverName);
          }

          const toolInstance = this._tools[toolName];
          logger.debug(
            `Tool instance for ${toolName}: ${!!toolInstance}, has execute: ${toolInstance && typeof toolInstance.execute === 'function'}`,
          );

          if (toolInstance && typeof toolInstance.execute === 'function') {
            logger.debug(`Calling tool "${toolName}" with args: ${JSON.stringify(toolInvocation.args)}`);

            try {
              result = await toolInstance.execute(toolInvocation.args, {
                messages: convertToCoreMessages(messages),
                toolCallId,
              });
              logger.debug(`Tool ${toolName} execution result:`, result);
            } catch (error) {
              logger.error(`Error while calling tool "${toolName}":`, error);
              result = TOOL_EXECUTION_ERROR;
            }
          } else {
            logger.warn(`Tool ${toolName} has no execute function`);
            result = TOOL_NO_EXECUTE_FUNCTION;
          }
        } else if (invocationResult === TOOL_EXECUTION_APPROVAL.REJECT) {
          result = TOOL_EXECUTION_DENIED;
        } else {
          // For any unhandled responses, return the original part.
          return part;
        }

        // Forward updated tool result to the client.
        dataStream.write(
          formatDataStreamPart('tool_result', {
            toolCallId,
            result,
          }),
        );

        // Return updated toolInvocation with the actual result.
        return {
          ...part,
          toolInvocation: {
            ...toolInvocation,
            result,
          },
        };
      }),
    );

    // Finally return the processed messages
    return [...messages.slice(0, -1), { ...lastMessage, parts: processedParts }];
  }

  get tools() {
    return this._tools;
  }

  get toolsWithoutExecute() {
    return this._toolsWithoutExecute;
  }
}
