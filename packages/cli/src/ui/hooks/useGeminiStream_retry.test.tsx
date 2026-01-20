
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Mock } from 'vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGeminiStream } from './useGeminiStream.js';
import { useReactToolScheduler } from './useReactToolScheduler.js';
import type {
  Config,
  EditorType,
} from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  AuthType,
  GeminiEventType as ServerGeminiEventType,
} from '@qwen-code/qwen-code-core';
import { MessageType } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';

// --- MOCKS ---
const mockSendMessageStream = vi
  .fn()
  .mockReturnValue((async function* () {})());
const mockStartChat = vi.fn();

const MockedGeminiClientClass = vi.hoisted(() =>
  vi.fn().mockImplementation(function (this: any, _config: any) {
    this.startChat = mockStartChat;
    this.sendMessageStream = mockSendMessageStream;
    this.addHistory = vi.fn();
    this.getChatRecordingService = vi.fn().mockReturnValue({
      recordThought: vi.fn(),
      initialize: vi.fn(),
      recordMessage: vi.fn(),
      recordMessageTokens: vi.fn(),
      recordToolCalls: vi.fn(),
      getConversationFile: vi.fn(),
    });
    this.getLoopDetectionService = vi.fn().mockReturnValue({
        disableForSession: vi.fn(),
        getLastDetectedLoopType: vi.fn(),
    });
  }),
);

const MockedUserPromptEvent = vi.hoisted(() =>
  vi.fn().mockImplementation(() => {}),
);
const MockedApiCancelEvent = vi.hoisted(() =>
  vi.fn().mockImplementation(() => {}),
);
const mockParseAndFormatApiError = vi.hoisted(() => vi.fn());
const mockLogApiCancel = vi.hoisted(() => vi.fn());

// Vision auto-switch mocks (hoisted)
const mockHandleVisionSwitch = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ shouldProceed: true }),
);
const mockRestoreOriginalModel = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actualCoreModule = (await importOriginal()) as any;
  return {
    ...actualCoreModule,
    GitService: vi.fn(),
    GeminiClient: MockedGeminiClientClass,
    UserPromptEvent: MockedUserPromptEvent,
    ApiCancelEvent: MockedApiCancelEvent,
    parseAndFormatApiError: mockParseAndFormatApiError,
    logApiCancel: mockLogApiCancel,
    promptIdContext: {
        run: (_: string, fn: () => any) => fn(),
    }
  };
});

const mockUseReactToolScheduler = useReactToolScheduler as Mock;
vi.mock('./useReactToolScheduler.js', async (importOriginal) => {
  const actualSchedulerModule = (await importOriginal()) as any;
  return {
    ...(actualSchedulerModule || {}),
    useReactToolScheduler: vi.fn(),
  };
});

vi.mock('./useVisionAutoSwitch.js', () => ({
  useVisionAutoSwitch: vi.fn(() => ({
    handleVisionSwitch: mockHandleVisionSwitch,
    restoreOriginalModel: mockRestoreOriginalModel,
  })),
}));

vi.mock('./useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

vi.mock('./shellCommandProcessor.js', () => ({
  useShellCommandProcessor: vi.fn().mockReturnValue({
    handleShellCommand: vi.fn(),
  }),
}));

vi.mock('./atCommandProcessor.js');

vi.mock('../utils/markdownUtilities.js', () => ({
  findLastSafeSplitPoint: vi.fn((s: string) => s.length),
}));

vi.mock('./useStateAndRef.js', () => ({
  useStateAndRef: vi.fn((initial) => {
    let val = initial;
    const ref = { current: val };
    const setVal = vi.fn((updater) => {
      if (typeof updater === 'function') {
        val = updater(val);
      } else {
        val = updater;
      }
      ref.current = val;
    });
    return [val, ref, setVal];
  }),
}));

vi.mock('./useLogger.js', () => ({
  useLogger: vi.fn().mockReturnValue({
    logMessage: vi.fn().mockResolvedValue(undefined),
  }),
}));

const mockStartNewPrompt = vi.fn();
const mockAddUsage = vi.fn();
vi.mock('../contexts/SessionContext.js', () => ({
  useSessionStats: vi.fn(() => ({
    startNewPrompt: mockStartNewPrompt,
    addUsage: mockAddUsage,
    getPromptCount: vi.fn(() => 5),
    stats: {
      sessionId: 'test-session-id',
    },
  })),
}));

vi.mock('./slashCommandProcessor.js', () => ({
  handleSlashCommand: vi.fn().mockReturnValue(false),
}));

describe('useGeminiStream Retry', () => {
  let mockAddItem: Mock;
  let mockConfig: Config;
  let mockOnDebugMessage: Mock;
  let mockHandleSlashCommand: Mock;
  let mockScheduleToolCalls: Mock;
  let mockCancelAllToolCalls: Mock;
  let mockMarkToolsAsSubmitted: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAddItem = vi.fn();
    const mockGetGeminiClient = vi.fn().mockImplementation(() => {
      const clientInstance = new MockedGeminiClientClass(mockConfig);
      return clientInstance;
    });

    const contentGeneratorConfig = {
      model: 'test-model',
      apiKey: 'test-key',
      vertexai: false,
      authType: AuthType.USE_GEMINI,
    };

    mockConfig = {
      apiKey: 'test-api-key',
      model: 'gemini-pro',
      sandbox: false,
      targetDir: '/test/dir',
      debugMode: false,
      getToolRegistry: vi.fn(
        () => ({ getToolSchemaList: vi.fn(() => []) }) as any,
      ),
      getProjectRoot: vi.fn(() => '/test/dir'),
      getCheckpointingEnabled: vi.fn(() => false),
      getGeminiClient: mockGetGeminiClient,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      addHistory: vi.fn(),
      getSessionId() {
        return 'test-session-id';
      },
      setQuotaErrorOccurred: vi.fn(),
      getQuotaErrorOccurred: vi.fn(() => false),
      getModel: vi.fn(() => 'gemini-2.5-pro'),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue(contentGeneratorConfig),
      getMaxSessionTurns: vi.fn(() => 50),
      getUseSmartEdit: () => false,
    } as unknown as Config;
    mockOnDebugMessage = vi.fn();
    mockHandleSlashCommand = vi.fn().mockResolvedValue(false);

    mockScheduleToolCalls = vi.fn();
    mockCancelAllToolCalls = vi.fn();
    mockMarkToolsAsSubmitted = vi.fn();

    mockUseReactToolScheduler.mockReturnValue([
      [], 
      mockScheduleToolCalls,
      mockCancelAllToolCalls,
      mockMarkToolsAsSubmitted,
    ]);

    mockStartChat.mockClear().mockResolvedValue({
      sendMessageStream: mockSendMessageStream,
    } as unknown as any);
    mockSendMessageStream
      .mockClear()
      .mockReturnValue((async function* () {})());
  });

  const mockLoadedSettings: LoadedSettings = {
    merged: { preferredEditor: 'vscode' },
    user: { path: '/user/settings.json', settings: {} },
    workspace: { path: '/workspace/.qwen/settings.json', settings: {} },
    errors: [],
    forScope: vi.fn(),
    setValue: vi.fn(),
  } as unknown as LoadedSettings;

  it('should display retry message when ServerGeminiEventType.Retry is received', async () => {
    mockSendMessageStream.mockReturnValue(
      (async function* () {
        yield { type: ServerGeminiEventType.Retry };
      })(),
    );

    const { result } = renderHook(() =>
      useGeminiStream(
        new MockedGeminiClientClass(mockConfig),
        [],
        mockAddItem,
        mockConfig,
        mockLoadedSettings,
        mockOnDebugMessage,
        mockHandleSlashCommand,
        false,
        () => 'vscode' as EditorType,
        () => {},
        () => Promise.resolve(),
        false,
        () => {},
        () => {},
        () => {},
        false,
        () => {},
        80,
        24,
      ),
    );

    await act(async () => {
      await result.current.submitQuery('test query');
    });

    await waitFor(() => {
        expect(mockAddItem).toHaveBeenCalledWith(
            expect.objectContaining({
                type: MessageType.INFO,
                text: 'Wait a moment, retrying due to 429...',
            }),
            expect.any(Number)
        );
    });
  });
});
