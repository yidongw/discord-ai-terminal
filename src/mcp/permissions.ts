import type { DiscordContext } from './discord-context.js';

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
}

/**
 * Basic permission decision function (fallback)
 * This is used when PermissionManager can't handle the request
 * (e.g., no Discord context, Discord bot unavailable)
 */
export async function approveToolRequest(
  toolName: string,
  input: any,
  discordContext?: DiscordContext
): Promise<PermissionDecision> {
  console.log('Basic permission request processing:', {
    toolName,
    input,
    discordContext,
  });

  try {
    // Enhanced logic for Step 2 - use channel-based rules if Discord context available
    const decision = await makePermissionDecision(toolName, input, discordContext);
    
    console.log('Basic permission decision made:', decision);
    return decision;
  } catch (error) {
    console.error('Error making basic permission decision:', error);
    
    // Fail safe - deny by default for security (changed from Step 1)
    return {
      behavior: 'deny',
      message: `Permission check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Core permission decision logic (fallback mode)
 */
async function makePermissionDecision(
  toolName: string,
  input: any,
  discordContext?: DiscordContext
): Promise<PermissionDecision> {
  
  // Step 2: Enhanced logic with Discord context awareness
  console.log(`Processing fallback permission for tool: ${toolName}`);
  
  // If we have Discord context, apply channel-specific rules
  if (discordContext) {
    const channelRules = getChannelPermissions(discordContext.channelName);
    
    if (channelRules.allowAll) {
      console.log(`Channel ${discordContext.channelName} allows all tools`);
      return {
        behavior: 'allow',
        updatedInput: input,
      };
    }
    
    if (channelRules.denyDangerous && isDangerousTool(toolName)) {
      console.log(`Channel ${discordContext.channelName} denies dangerous tool: ${toolName}`);
      return {
        behavior: 'deny',
        message: `Dangerous tool ${toolName} not allowed in channel ${discordContext.channelName}`,
      };
    }
  }
  
  // Default: Allow safe tools, deny dangerous ones
  if (isSafeTool(toolName)) {
    console.log(`Tool ${toolName} is safe, allowing`);
    return {
      behavior: 'allow',
      updatedInput: input,
    };
  }
  
  if (isDangerousTool(toolName)) {
    console.log(`Tool ${toolName} is dangerous, denying (no interactive approval available)`);
    return {
      behavior: 'deny',
      message: `Dangerous tool ${toolName} requires interactive approval which is not available`,
    };
  }
  
  // Unknown tools: deny for safety
  console.log(`Unknown tool ${toolName}, denying for safety`);
  return {
    behavior: 'deny',
    message: `Unknown tool ${toolName} denied for safety`,
  };
}

/**
 * Check if a tool is considered "safe" (doesn't need special approval)
 */
function isSafeTool(toolName: string): boolean {
  const safeTools = [
    'Read',
    'Glob', 
    'Grep',
    'LS',
    'TodoRead',
    'WebFetch',
    'WebSearch',
  ];
  
  return safeTools.includes(toolName);
}

/**
 * Check if a tool is considered "dangerous" (needs special approval)
 */
function isDangerousTool(toolName: string): boolean {
  const dangerousTools = [
    'Bash',
    'Write',
    'Edit',
    'MultiEdit',
  ];
  
  return dangerousTools.includes(toolName);
}

/**
 * Analyze tool input to determine risk level
 */
function analyzeToolInput(toolName: string, input: any): 'safe' | 'caution' | 'dangerous' {
  // For Step 1, return safe for all - this will be enhanced later
  return 'safe';
}

/**
 * Get channel-specific permission rules
 * Enhanced for Step 2 with basic channel-based logic
 */
function getChannelPermissions(channelName?: string): {
  allowAll: boolean;
  denyDangerous: boolean;
  requireConfirmation: boolean;
} {
  if (!channelName) {
    // No channel name: conservative defaults
    return {
      allowAll: false,
      denyDangerous: true,
      requireConfirmation: true,
    };
  }
  
  // Development/testing channels: more permissive (only for channels specifically named for testing)
  if (channelName === 'dev' || channelName === 'test' || channelName === 'sandbox' || 
      channelName.endsWith('-dev') || channelName.endsWith('-test') || channelName.endsWith('-sandbox')) {
    return {
      allowAll: true,
      denyDangerous: false,
      requireConfirmation: false,
    };
  }
  
  // Production channels: more restrictive
  if (channelName.includes('prod') || channelName.includes('main') || channelName.includes('live')) {
    return {
      allowAll: false,
      denyDangerous: true,
      requireConfirmation: true,
    };
  }
  
  // Default: moderate settings
  return {
    allowAll: false,
    denyDangerous: false,
    requireConfirmation: true,
  };
}