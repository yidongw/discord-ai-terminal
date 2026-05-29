import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ClaudeManager } from '../../src/claude/manager.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');
vi.mock('child_process');

// Mock bun:sqlite first
vi.mock('bun:sqlite', () => ({
  Database: vi.fn()
}));

vi.mock('../../src/db/database.js', () => ({
  DatabaseManager: vi.fn()
}));

describe('ClaudeManager', () => {
  let manager: ClaudeManager;
  let mockDb: any;
  const mockBaseFolder = '/test/base';

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Mock the DatabaseManager
    const { DatabaseManager } = await import('../../src/db/database.js');
    mockDb = {
      getSession: vi.fn(),
      setSession: vi.fn(),
      clearSession: vi.fn(),
      getAllSessions: vi.fn(),
      cleanupOldSessions: vi.fn(),
      close: vi.fn(),
      getMode: vi.fn().mockReturnValue('auto'),
      setMode: vi.fn(),
      getModel: vi.fn().mockReturnValue('sonnet'),
      setModel: vi.fn(),
      getProvider: vi.fn().mockReturnValue('claude'),
      setProvider: vi.fn(),
      getPath: vi.fn().mockReturnValue(undefined),
      setPath: vi.fn(),
      clearPath: vi.fn(),
    };
    vi.mocked(DatabaseManager).mockImplementation(() => mockDb);
    
    manager = new ClaudeManager(mockBaseFolder);
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  describe('hasActiveProcess', () => {
    it('should return false when no active process exists', () => {
      expect(manager.hasActiveProcess('channel-1')).toBe(false);
    });

    it('should return true when active process exists', () => {
      manager.reserveChannel('channel-1', undefined, {});
      expect(manager.hasActiveProcess('channel-1')).toBe(true);
    });
  });

  describe('killActiveProcess', () => {
    it('should kill process when it exists', () => {
      const mockProcess = { kill: vi.fn() };
      manager.reserveChannel('channel-1', undefined, {});
      
      // Simulate setting the process
      const channelProcesses = (manager as any).channelProcesses;
      channelProcesses.get('channel-1').process = mockProcess;

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      manager.killActiveProcess('channel-1');
      
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(consoleSpy).toHaveBeenCalledWith('Killing active process for channel channel-1');
      
      consoleSpy.mockRestore();
    });

    it('should not throw when no process exists', () => {
      expect(() => manager.killActiveProcess('nonexistent')).not.toThrow();
    });
  });

  describe('clearSession', () => {
    it('should clear all session data', () => {
      manager.reserveChannel('channel-1', 'session-1', {});
      manager.setDiscordMessage('channel-1', { edit: vi.fn() });
      
      manager.clearSession('channel-1');
      
      expect(manager.hasActiveProcess('channel-1')).toBe(false);
      expect(mockDb.clearSession).toHaveBeenCalledWith('channel-1');
    });
  });

  describe('setDiscordMessage', () => {
    it('should set discord message and initialize tool calls map', () => {
      const mockMessage = { edit: vi.fn() };
      manager.setDiscordMessage('channel-1', mockMessage);

      const channelMessages = (manager as any).channelMessages;
      const channelToolCalls = (manager as any).channelToolCalls;

      expect(channelMessages.get('channel-1')).toBe(mockMessage);
      expect(channelToolCalls.get('channel-1')).toBeInstanceOf(Map);
    });
  });

  describe('reserveChannel', () => {
    it('should reserve channel without existing process', () => {
      const mockMessage = { edit: vi.fn() };
      manager.reserveChannel('channel-1', 'session-1', mockMessage);
      
      expect(manager.hasActiveProcess('channel-1')).toBe(true);
      // Note: reserveChannel sets the sessionId in the process object, not channelSessions
      // The sessionId is only set in channelSessions when Claude actually responds
    });

    it('should kill existing process when reserving channel', () => {
      const mockExistingProcess = { kill: vi.fn() };
      const mockMessage = { edit: vi.fn() };
      
      manager.reserveChannel('channel-1', undefined, mockMessage);
      const channelProcesses = (manager as any).channelProcesses;
      channelProcesses.get('channel-1').process = mockExistingProcess;
      
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      manager.reserveChannel('channel-1', 'new-session', mockMessage);
      
      expect(mockExistingProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(consoleSpy).toHaveBeenCalledWith('Killing existing process for channel channel-1 before starting new one');
      
      consoleSpy.mockRestore();
    });
  });

  describe('getSessionId', () => {
    it('should return undefined when no session exists', () => {
      mockDb.getSession.mockReturnValue(undefined);
      expect(manager.getSessionId('channel-1')).toBeUndefined();
      expect(mockDb.getSession).toHaveBeenCalledWith('channel-1');
    });

    it('should return session ID when it exists', () => {
      mockDb.getSession.mockReturnValue('session-123');
      
      expect(manager.getSessionId('channel-1')).toBe('session-123');
      expect(mockDb.getSession).toHaveBeenCalledWith('channel-1');
    });
  });

  describe('runClaudeCode', () => {
    it('should throw error when working directory does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      await expect(
        manager.runClaudeCode('channel-1', 'test-channel', 'test prompt')
      ).rejects.toThrow('Working directory does not exist: /test/base/test-channel');
    });

    // Note: Testing the full spawn setup is complex due to event-driven nature.
    // The key behaviors (directory check, command building) are tested elsewhere.
  });

  describe('database integration', () => {
    it('should initialize database and cleanup old sessions on construction', () => {
      // The cleanupOldSessions call happens during construction, so we need to check
      // if it was called when the manager was created in beforeEach
      expect(mockDb.cleanupOldSessions).toHaveBeenCalled();
    });

    it('should close database on destroy', () => {
      manager.destroy();
      expect(mockDb.close).toHaveBeenCalled();
    });
  });
});
