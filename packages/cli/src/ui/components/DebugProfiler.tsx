/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text, Box } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { profilerService } from '@qwen-code/qwen-code-core';
import { formatMemoryUsage } from '../utils/formatters.js';

export const DebugProfiler = () => {
  const numRenders = useRef(0);
  const [showDebug, setShowDebug] = useState(false);
  const [memory, setMemory] = useState(process.memoryUsage().rss);

  useEffect(() => {
    numRenders.current++;
  });

  useEffect(() => {
    if (!showDebug) return;
    const interval = setInterval(() => {
      setMemory(process.memoryUsage().rss);
    }, 1000);
    return () => clearInterval(interval);
  }, [showDebug]);

  useKeypress(
    (key) => {
      if (key.ctrl && key.name === 'b') {
        setShowDebug((prev) => !prev);
      }
    },
    { isActive: true },
  );

  if (!showDebug) {
    return null;
  }

  const isProfiling = profilerService.isActive();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.status.warning} paddingX={1}>
      <Text color={theme.status.warning} bold>Debug Info (Ctrl+B to hide)</Text>
      <Text color={theme.text.primary}>Renders: {numRenders.current}</Text>
      <Text color={theme.text.primary}>Memory: {formatMemoryUsage(memory)}</Text>
      <Text color={isProfiling ? theme.status.success : theme.text.secondary}>
        Profiler: {isProfiling ? 'ACTIVE' : 'Inactive'}
      </Text>
    </Box>
  );
};
