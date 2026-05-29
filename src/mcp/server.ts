import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { PermissionManager } from './permission-manager.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';

export class MCPPermissionServer {
  private app: express.Application;
  private port: number;
  private server?: any;
  private permissionManager: PermissionManager;
  private discordBot: any = null;

  constructor(port: number = 3001) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.permissionManager = new PermissionManager();

    this.setupRoutes();
  }

  /**
   * Set the Discord bot instance for the permission manager
   */
  setDiscordBot(discordBot: any): void {
    this.discordBot = discordBot;
    this.permissionManager.setDiscordBot(discordBot);
  }

  /**
   * Get the permission manager instance
   */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  /**
   * Ask user a question via Discord buttons and wait for response
   */
  private async askUserQuestion(
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    discordContext: { channelId: string; channelName: string; userId: string; messageId?: string }
  ): Promise<Record<string, string>> {
    if (!this.discordBot) {
      throw new Error('Discord bot not available');
    }

    const channel = await this.discordBot.client.channels.fetch(discordContext.channelId);
    if (!channel) {
      throw new Error(`Could not find channel: ${discordContext.channelId}`);
    }

    const answers: Record<string, string> = {};

    // Process each question (typically just one)
    for (const q of questions) {
      const embed = new EmbedBuilder()
        .setTitle(`❓ ${q.header || 'Question'}`)
        .setDescription(q.question)
        .setColor(0x5865F2);

      // Add option descriptions if available
      const optionDescriptions = q.options
        .filter(o => o.description)
        .map(o => `**${o.label}**: ${o.description}`)
        .join('\n');

      if (optionDescriptions) {
        embed.addFields({ name: 'Options', value: optionDescriptions });
      }

      // Build buttons (max 5 per row)
      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      let currentRow = new ActionRowBuilder<ButtonBuilder>();

      q.options.forEach((option, index) => {
        const button = new ButtonBuilder()
          .setCustomId(`mcp_ask_${index}`)
          .setLabel(option.label.substring(0, 80))
          .setStyle(ButtonStyle.Primary);

        currentRow.addComponents(button);

        if (currentRow.components.length === 5) {
          rows.push(currentRow);
          currentRow = new ActionRowBuilder<ButtonBuilder>();
        }
      });

      // Add "Other" button
      const otherButton = new ButtonBuilder()
        .setCustomId('mcp_ask_other')
        .setLabel('Other...')
        .setStyle(ButtonStyle.Secondary);
      currentRow.addComponents(otherButton);

      if (currentRow.components.length > 0) {
        rows.push(currentRow);
      }

      // Send the question
      const message = await channel.send({ embeds: [embed], components: rows });

      // Wait for button interaction (60 second timeout)
      try {
        const interaction = await message.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i: any) => i.user.id === discordContext.userId,
          time: 60000,
        });

        if (interaction.customId === 'mcp_ask_other') {
          // User wants to provide custom input
          await interaction.reply({ content: 'Please type your response:', ephemeral: true });

          const collected = await channel.awaitMessages({
            filter: (m: any) => m.author.id === discordContext.userId,
            max: 1,
            time: 60000,
          });

          const userResponse = collected.first()?.content || 'No response';
          answers[q.question] = userResponse;

          // Update the message
          const responseEmbed = new EmbedBuilder()
            .setTitle(`✅ ${q.header || 'Question'}`)
            .setDescription(`${q.question}\n\n**Your answer:** ${userResponse}`)
            .setColor(0x00FF00);

          await message.edit({ embeds: [responseEmbed], components: [] });
        } else {
          // User selected an option
          const optionIndex = parseInt(interaction.customId.replace('mcp_ask_', ''));
          const selectedOption = q.options[optionIndex];

          answers[q.question] = selectedOption.label;
          await interaction.deferUpdate();

          // Update the message
          const responseEmbed = new EmbedBuilder()
            .setTitle(`✅ ${q.header || 'Question'}`)
            .setDescription(`${q.question}\n\n**Your answer:** ${selectedOption.label}`)
            .setColor(0x00FF00);

          await message.edit({ embeds: [responseEmbed], components: [] });
        }
      } catch (error) {
        // Timeout
        answers[q.question] = 'No response (timed out)';

        const timeoutEmbed = new EmbedBuilder()
          .setTitle(`⏰ ${q.header || 'Question'}`)
          .setDescription(`${q.question}\n\n*Timed out - no response*`)
          .setColor(0xFFD700);

        await message.edit({ embeds: [timeoutEmbed], components: [] });
      }
    }

    return answers;
  }

  /**
   * Extract Discord context from HTTP headers
   */
  private extractDiscordContext(req: any): any {
    const channelId = req.headers['x-discord-channel-id'];
    const channelName = req.headers['x-discord-channel-name'];
    const userId = req.headers['x-discord-user-id'];
    const messageId = req.headers['x-discord-message-id'];
    
    if (channelId) {
      return {
        channelId: channelId,
        channelName: channelName || 'unknown',
        userId: userId || 'unknown',
        messageId: messageId,
      };
    }
    
    return undefined;
  }

  private setupRoutes(): void {
    // Handle MCP requests (stateless mode)
    this.app.post('/mcp', async (req, res) => {
      try {
        console.log('MCP request received:', req.body);
        console.log('MCP request headers:', {
          'x-discord-channel-id': req.headers['x-discord-channel-id'],
          'x-discord-channel-name': req.headers['x-discord-channel-name'],
          'x-discord-user-id': req.headers['x-discord-user-id'],
          'x-discord-message-id': req.headers['x-discord-message-id'],
        });
        
        // Extract Discord context from headers
        const discordContextFromHeaders = this.extractDiscordContext(req);
        
        // Create new MCP server instance for each request (stateless)
        const mcpServer = new McpServer({
          name: 'Claude Code Permission Server',
          version: '1.0.0',
        });

        // Add the approval tool
        mcpServer.tool(
          'approve_tool',
          {
            tool_name: z.string().describe('The tool requesting permission'),
            input: z.object({}).passthrough().describe('The input for the tool'),
            discord_context: z.object({
              channelId: z.string(),
              channelName: z.string(),
              userId: z.string(),
              messageId: z.string().optional(),
            }).optional().describe('Discord context for permission decision'),
          },
          async ({ tool_name, input, discord_context }) => {
            console.log('MCP Server: Permission request received:', { tool_name, input, discord_context });
            
            // Use discord_context from parameters, or fall back to headers
            let effectiveDiscordContext = discord_context || discordContextFromHeaders;
            
            console.log('MCP Server: Effective Discord context:', effectiveDiscordContext);
            
            try {
              const decision = await this.permissionManager.requestApproval(tool_name, input, effectiveDiscordContext);
              
              console.log('MCP Server: Permission decision:', decision);
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(decision),
                  },
                ],
              };
            } catch (error) {
              console.error('MCP Server: Error processing permission request:', error);
              
              // Return deny on error for security
              const errorDecision = {
                behavior: 'deny',
                message: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
              };
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(errorDecision),
                  },
                ],
              };
            }
          }
        );

        // Add the ask_user_question tool
        mcpServer.tool(
          'ask_user_question',
          {
            questions: z.array(z.object({
              question: z.string().describe('The question to ask the user'),
              header: z.string().optional().describe('Short header for the question'),
              options: z.array(z.object({
                label: z.string().describe('Option label'),
                description: z.string().optional().describe('Option description'),
              })).describe('Available options for the user to choose from'),
              multiSelect: z.boolean().optional().describe('Whether multiple options can be selected'),
            })).describe('Array of questions to ask'),
            discord_context: z.object({
              channelId: z.string(),
              channelName: z.string(),
              userId: z.string(),
              messageId: z.string().optional(),
            }).optional().describe('Discord context'),
          },
          async ({ questions, discord_context }) => {
            console.log('MCP Server: Ask user question received:', { questions, discord_context });

            const effectiveDiscordContext = discord_context || discordContextFromHeaders;

            if (!effectiveDiscordContext || !this.discordBot) {
              console.log('MCP Server: No Discord context or bot available');
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({ answers: {}, error: 'No Discord context available' }),
                }],
              };
            }

            try {
              const answers = await this.askUserQuestion(questions, effectiveDiscordContext);
              console.log('MCP Server: User answers:', answers);

              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({ answers }),
                }],
              };
            } catch (error) {
              console.error('MCP Server: Error asking user question:', error);
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    answers: {},
                    error: error instanceof Error ? error.message : String(error)
                  }),
                }],
              };
            }
          }
        );

        // Create transport for this request
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless
        });

        // Clean up when request closes
        res.on('close', () => {
          console.log('MCP request closed');
          transport.close();
          mcpServer.close();
        });

        // Connect server to transport
        await mcpServer.connect(transport);
        
        // Handle the request
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    });

    // Handle GET requests (method not allowed for stateless mode)
    this.app.get('/mcp', (req, res) => {
      console.log('Received GET MCP request');
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed - this server operates in stateless mode',
        },
        id: null,
      });
    });

    // Handle DELETE requests (method not allowed for stateless mode)
    this.app.delete('/mcp', (req, res) => {
      console.log('Received DELETE MCP request');
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed - this server operates in stateless mode',
        },
        id: null,
      });
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        server: 'Claude Code Permission Server',
        version: '1.0.0',
        port: this.port
      });
    });

    // Simple HTTP endpoint for approve_tool (called by mcp-bridge.mjs)
    this.app.post('/tool/approve_tool', async (req, res) => {
      console.log('HTTP approve_tool request:', req.body);

      const discordContext = this.extractDiscordContext(req) || req.body.discord_context;
      const { tool_name, input } = req.body;

      try {
        const decision = await this.permissionManager.requestApproval(tool_name, input, discordContext);
        console.log('HTTP approve_tool decision:', decision);
        res.json(decision);
      } catch (error) {
        console.error('HTTP approve_tool error:', error);
        res.json({
          behavior: 'deny',
          message: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });

    // Simple HTTP endpoint for ask_user_question (called by mcp-bridge.mjs)
    this.app.post('/tool/ask_user_question', async (req, res) => {
      console.log('HTTP ask_user_question request:', req.body);

      const discordContext = this.extractDiscordContext(req) || req.body.discord_context;
      const { questions } = req.body;

      if (!discordContext || !this.discordBot) {
        console.log('HTTP ask_user_question: No Discord context or bot available');
        res.json({ answers: {}, error: 'No Discord context available' });
        return;
      }

      try {
        const answers = await this.askUserQuestion(questions, discordContext);
        console.log('HTTP ask_user_question answers:', answers);
        res.json({ answers });
      } catch (error) {
        console.error('HTTP ask_user_question error:', error);
        res.json({
          answers: {},
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, (err?: Error) => {
        if (err) {
          reject(err);
        } else {
          console.log(`MCP Permission Server listening on port ${this.port}`);
          console.log(`Health check: http://localhost:${this.port}/health`);
          console.log(`MCP endpoint: http://localhost:${this.port}/mcp`);
          resolve();
        }
      });
    });
  }

  async stop(): Promise<void> {
    // Clean up permission manager first
    this.permissionManager.cleanup();
    
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log('MCP Permission Server stopped');
          resolve();
        });
      });
    }
  }
}