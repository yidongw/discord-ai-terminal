import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateConfig } from '../../src/utils/config.js';

describe('validateConfig', () => {
  const originalEnv = process.env;
  
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return valid config when all environment variables are set', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.ALLOWED_USER_ID = 'test-user-id';
    process.env.BASE_FOLDER = '/test/folder';

    const config = validateConfig();

    expect(config).toEqual({
      discordToken: 'test-token',
      allowedUserId: 'test-user-id',
      baseFolder: '/test/folder',
    });
  });

  it('should exit with error when DISCORD_TOKEN is missing', () => {
    delete process.env.DISCORD_TOKEN;
    process.env.ALLOWED_USER_ID = 'test-user-id';
    process.env.BASE_FOLDER = '/test/folder';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => validateConfig()).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledWith('DISCORD_TOKEN environment variable is required');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should exit with error when ALLOWED_USER_ID is missing', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    delete process.env.ALLOWED_USER_ID;
    process.env.BASE_FOLDER = '/test/folder';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => validateConfig()).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledWith('ALLOWED_USER_ID environment variable is required');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('should exit with error when BASE_FOLDER is missing', () => {
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.ALLOWED_USER_ID = 'test-user-id';
    delete process.env.BASE_FOLDER;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => validateConfig()).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledWith('BASE_FOLDER environment variable is required');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});