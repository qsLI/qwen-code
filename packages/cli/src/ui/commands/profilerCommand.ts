/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { profilerService } from '@qwen-code/qwen-code-core';
import { MessageType } from '../types.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';

export const profilerCommand: SlashCommand = {
  name: 'profiler',
  description: 'Manage performance profiling. Usage: /profiler [start|stop]',
  kind: CommandKind.BUILT_IN,
  action: (context: CommandContext, args: string) => {
    const trimmedArgs = args.trim().toLowerCase();

    if (trimmedArgs === 'start') {
      if (profilerService.isActive()) {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: 'Profiler is already running.',
          },
          Date.now(),
        );
        return;
      }
      profilerService.start();
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: 'Performance profiling started. Use `/profiler stop` to save results.',
        },
        Date.now(),
      );
    } else if (trimmedArgs === 'stop') {
      if (!profilerService.isActive()) {
        context.ui.addItem(
          {
            type: MessageType.ERROR,
            text: 'Profiler is not running.',
          },
          Date.now(),
        );
        return;
      }
      const filePath = profilerService.stop();
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: filePath
            ? `Performance profiling stopped. Data saved to: ${filePath}`
            : 'Performance profiling stopped, but failed to save data.',
        },
        Date.now(),
      );
    } else {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `Profiler status: ${
            profilerService.isActive() ? 'Running' : 'Stopped'
          }. Usage: /profiler [start|stop]`,
        },
        Date.now(),
      );
    }
  },
  subCommands: [
    {
      name: 'start',
      description: 'Start performance profiling.',
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        if (profilerService.isActive()) {
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: 'Profiler is already running.',
            },
            Date.now(),
          );
          return;
        }
        profilerService.start();
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: 'Performance profiling started. Use `/profiler stop` to save results.',
          },
          Date.now(),
        );
      },
    },
    {
      name: 'stop',
      description: 'Stop performance profiling and save results.',
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        if (!profilerService.isActive()) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: 'Profiler is not running.',
            },
            Date.now(),
          );
          return;
        }
        const filePath = profilerService.stop();
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: filePath
              ? `Performance profiling stopped. Data saved to: ${filePath}`
              : 'Performance profiling stopped, but failed to save data.',
          },
          Date.now(),
        );
      },
    },
  ],
};
