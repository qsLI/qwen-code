/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ProfileSample {
  timestamp: number;
  cpuLoad: number[];
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

export interface ProfileMarker {
  label: string;
  timestamp: number;
  type: 'start' | 'end' | 'point';
  data?: any;
}

export class ProfilerService {
  private samples: ProfileSample[] = [];
  private markers: ProfileMarker[] = [];
  private isProfiling = false;
  private intervalId: NodeJS.Timeout | null = null;
  private startTime: number = 0;
  private logDir: string;

  constructor(logDir?: string) {
    this.logDir = logDir || path.join(process.cwd(), 'logs');
  }

  start() {
    if (this.isProfiling) return;
    this.isProfiling = true;
    this.startTime = Date.now();
    this.samples = [];
    this.markers = [];
    
    // Ensure log directory exists
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (err) {
      console.error(`Failed to create log directory: ${this.logDir}`, err);
    }

    this.mark('profiling_session', 'start');

    this.intervalId = setInterval(() => {
      this.takeSample();
    }, 1000);
    
    // Take an initial sample
    this.takeSample();
  }

  stop(): string | null {
    if (!this.isProfiling) return null;
    this.isProfiling = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.mark('profiling_session', 'end');

    const profileData = {
      startTime: new Date(this.startTime).toISOString(),
      endTime: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpuModel: os.cpus()[0]?.model,
      totalMemory: os.totalmem(),
      samples: this.samples,
      markers: this.markers,
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `qwen-profile-${timestamp}.json`;
    const filePath = path.join(this.logDir, fileName);
    
    try {
      fs.writeFileSync(filePath, JSON.stringify(profileData, null, 2));
      return filePath;
    } catch (err) {
      console.error(`Failed to write profile data to ${filePath}`, err);
      return null;
    }
  }

  mark(label: string, type: 'start' | 'end' | 'point' = 'point', data?: any) {
    if (!this.isProfiling) {
        // Even if not profiling, we might want to keep track of some markers for internal use?
        // But for now, only record if profiling is active to save memory.
        return;
    }
    this.markers.push({
      label,
      timestamp: Date.now(),
      type,
      data,
    });
  }

  private takeSample() {
    const memory = process.memoryUsage();
    this.samples.push({
      timestamp: Date.now(),
      cpuLoad: os.loadavg(),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
    });
  }

  isActive() {
    return this.isProfiling;
  }
}

// Global singleton
export const profilerService = new ProfilerService();
