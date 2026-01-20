
import { describe, it, expect, vi } from 'vitest';
import { GeminiClient } from './client.js';
import { retryWithBackoff } from '../utils/retry.js';
import { type Config } from '../config/config.js';

// Mock retryWithBackoff
vi.mock('../utils/retry.js', () => ({
  retryWithBackoff: vi.fn().mockImplementation(async (fn) => fn()),
}));

// Mock other dependencies
vi.mock('../services/chatCompressionService.js');
vi.mock('../services/loopDetectionService.js');
vi.mock('../utils/errorReporting.js', () => ({
  reportError: vi.fn(),
  getErrorMessage: vi.fn((e) => e.message),
}));
vi.mock('./prompts.js', () => ({
  getCoreSystemPrompt: vi.fn().mockReturnValue({ role: 'system', parts: [] }),
  getCustomSystemPrompt: vi.fn(),
}));

describe('GeminiClient Retry Config', () => {
  it('should pass maxRetries from config to retryWithBackoff', async () => {
    const mockContentGenerator = {
      generateContent: vi.fn().mockResolvedValue({}),
    };

    const mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'gemini',
        maxRetries: 7, // Test value
        model: 'test-model',
      }),
      getUserMemory: vi.fn().mockReturnValue(''),
      getModel: vi.fn().mockReturnValue('test-model'),
      getContentGenerator: vi.fn().mockReturnValue(mockContentGenerator),
      getChatRecordingService: vi.fn(),
      getProxy: vi.fn(),
    };

    const client = new GeminiClient(mockConfig as unknown as Config);

    // We need to trigger generateContent
    await client.generateContent(
        [], // contents
        {}, // generationConfig
        new AbortController().signal,
        'test-model'
    );

    expect(retryWithBackoff).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
            maxAttempts: 8 // 7 + 1
        })
    );
  });

  it('should use default behavior if maxRetries is undefined', async () => {
    const mockContentGenerator = {
      generateContent: vi.fn().mockResolvedValue({}),
    };

    const mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'gemini',
        maxRetries: undefined, 
        model: 'test-model',
      }),
      getUserMemory: vi.fn().mockReturnValue(''),
      getModel: vi.fn().mockReturnValue('test-model'),
      getContentGenerator: vi.fn().mockReturnValue(mockContentGenerator),
      getChatRecordingService: vi.fn(),
      getProxy: vi.fn(),
    };

    const client = new GeminiClient(mockConfig as unknown as Config);

    await client.generateContent(
        [], 
        {}, 
        new AbortController().signal,
        'test-model'
    );

    // When maxAttempts is undefined, retryWithBackoff uses default (5).
    // Our call should pass undefined for maxAttempts property
    expect(retryWithBackoff).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
            maxAttempts: undefined
        })
    );
  });
});
