/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Storage } from '../config/storage.js';
import type { Config } from '../config/config.js';

export const USAGE_FILENAME = 'usage.json';
export const DEFAULT_TOKEN_THRESHOLD = 1_000_000;

export interface ModelUsageStats {
  total: number;
  input: number;
  output: number;
  cache: number;
  thought: number;
  tool: number;
}

export interface DailyUsageStats {
  total: number;
  modelUsage: Record<string, ModelUsageStats>;
  morningReportSent: boolean;
  eveningReportSent: boolean;
  lastError?: string;
}

export interface UsageData {
  totalTokens: number;
  lastNotificationTokenCount?: number;
  lastUpdated: string;
  modelUsage: Record<string, ModelUsageStats>;
  dailyUsage: Record<string, DailyUsageStats>;
}

export class UsageService {
  private usageFilePath: string;
  private currentUsage: UsageData;
  private eveningReportTimer: NodeJS.Timeout | undefined;

  constructor(private readonly config: Config) {
    this.usageFilePath = path.join(Storage.getGlobalQwenDir(), USAGE_FILENAME);
    this.currentUsage = this.loadUsage();

    // Check reports on startup
    this.checkMorningReport().catch(console.error);
    this.checkEveningReport().catch(console.error);
    this.scheduleEveningReport();
  }

  private loadUsage(): UsageData {
    try {
      if (fs.existsSync(this.usageFilePath)) {
        const content = fs.readFileSync(this.usageFilePath, 'utf-8');
        const data = JSON.parse(content);
        // Migration/Safety check for old format
        if (!data.modelUsage) {
          data.modelUsage = {};
        }
        if (!data.dailyUsage) {
          data.dailyUsage = {};
        }
        return data;
      }
    } catch (error) {
      console.error('Failed to load usage data:', error);
    }
    return {
      totalTokens: 0,
      lastUpdated: this.toLocalISOString(new Date()),
      modelUsage: {},
      dailyUsage: {},
    };
  }

  private saveUsage(): void {
    try {
      const dir = path.dirname(this.usageFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.usageFilePath,
        JSON.stringify(this.currentUsage, null, 2),
      );
    } catch (error) {
      console.error('Failed to save usage data:', error);
    }
  }

  private updateStats(
    stats: ModelUsageStats,
    usage: GenerateContentResponseUsageMetadata | number,
  ) {
    if (typeof usage === 'number') {
      stats.total += usage;
    } else {
      stats.total += usage.totalTokenCount ?? 0;
      stats.input += usage.promptTokenCount ?? 0;
      stats.output += usage.candidatesTokenCount ?? 0;
      stats.cache += usage.cachedContentTokenCount ?? 0;
      stats.thought += usage.thoughtsTokenCount ?? 0;
      stats.tool += usage.toolUsePromptTokenCount ?? 0;
    }
  }

  async recordTokenUsage(
    usage: GenerateContentResponseUsageMetadata | number,
    modelName: string = 'unknown',
  ): Promise<void> {
    const count =
      typeof usage === 'number' ? usage : (usage.totalTokenCount ?? 0);
    const today = this.getDateString();

    // 1. Update Lifetime Stats
    this.currentUsage.totalTokens += count;
    this.currentUsage.lastUpdated = this.toLocalISOString(new Date());

    if (!this.currentUsage.modelUsage[modelName]) {
      this.currentUsage.modelUsage[modelName] = this.createEmptyStats();
    }
    this.updateStats(this.currentUsage.modelUsage[modelName], usage);

    // 2. Update Daily Stats
    if (!this.currentUsage.dailyUsage[today]) {
      this.currentUsage.dailyUsage[today] = {
        total: 0,
        modelUsage: {},
        morningReportSent: false,
        eveningReportSent: false,
      };
    }
    const daily = this.currentUsage.dailyUsage[today];
    daily.total += count;

    if (!daily.modelUsage[modelName]) {
      daily.modelUsage[modelName] = this.createEmptyStats();
    }
    this.updateStats(daily.modelUsage[modelName], usage);

    this.saveUsage();

    await this.checkThreshold(modelName);
    await this.checkEveningReport();
  }

  private createEmptyStats(): ModelUsageStats {
    return {
      total: 0,
      input: 0,
      output: 0,
      cache: 0,
      thought: 0,
      tool: 0,
    };
  }

  private toLocalISOString(date: Date): string {
    const tzo = -date.getTimezoneOffset();
    const dif = tzo >= 0 ? '+' : '-';
    const pad = (num: number) => {
      const norm = Math.floor(Math.abs(num));
      return (norm < 10 ? '0' : '') + norm;
    };

    return (
      date.getFullYear() +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      'T' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes()) +
      ':' +
      pad(date.getSeconds()) +
      '.' +
      String(date.getMilliseconds()).padStart(3, '0') +
      dif +
      pad(tzo / 60) +
      ':' +
      pad(tzo % 60)
    );
  }

  private getDateString(date: Date = new Date()): string {
    return this.toLocalISOString(date).split('T')[0];
  }

  private async checkMorningReport(): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = this.getDateString(yesterday);

    const yesterdayUsage = this.currentUsage.dailyUsage[yesterdayStr];
    if (
      yesterdayUsage &&
      !yesterdayUsage.morningReportSent &&
      yesterdayUsage.total > 0
    ) {
      const success = await this.sendDailyReport(
        yesterdayStr,
        yesterdayUsage,
        "Yesterday's Token Usage Report",
      );
      if (success) {
        yesterdayUsage.morningReportSent = true;
      }
      this.saveUsage();
    }
  }

  private async checkEveningReport(): Promise<void> {
    const now = new Date();
    const todayStr = this.getDateString(now);

    // Check if it is after 21:00 (9 PM)
    if (now.getHours() >= 21) {
      const todayUsage = this.currentUsage.dailyUsage[todayStr];
      if (todayUsage && !todayUsage.eveningReportSent && todayUsage.total > 0) {
        const success = await this.sendDailyReport(
          todayStr,
          todayUsage,
          "Today's Evening Token Usage Report",
        );
        if (success) {
          todayUsage.eveningReportSent = true;
        }
        this.saveUsage();
      }
    }
  }

  private scheduleEveningReport() {
    const now = new Date();
    const target = new Date(now);
    target.setHours(21, 0, 0, 0);

    if (now < target) {
      const delay = target.getTime() - now.getTime();
      // Ensure delay is reasonable (e.g. < 24h)
      if (delay > 0) {
        this.eveningReportTimer = setTimeout(() => {
          this.checkEveningReport().catch(console.error);
        }, delay);
        // Unref so it doesn't hold the process open if everything else is done
        this.eveningReportTimer.unref();
      }
    }
  }

  private async sendDailyReport(
    date: string,
    stats: DailyUsageStats,
    title: string,
  ): Promise<boolean> {
    const webhookUrl = this.config.getWebhookUrl();
    if (!webhookUrl) return false;

    let content = `${title} (${date})\nUser: ${os.userInfo().username}\nTotal Tokens: ${stats.total}\n`;

    // Add top models breakdown
    content += '\nBreakdown by Model:\n';
    for (const [model, modelStats] of Object.entries(stats.modelUsage)) {
      content += `- ${model}: ${modelStats.total} (In: ${modelStats.input}, Out: ${modelStats.output})\n`;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content },
        }),
      });

      if (!response.ok) {
        const errorMsg = `Failed to send daily report: ${response.status} ${response.statusText}`;
        console.error(errorMsg);
        stats.lastError = errorMsg;
        return false;
      }

      delete stats.lastError;
      return true;
    } catch (error) {
      const errorMsg = `Failed to send daily report: ${error}`;
      console.error(errorMsg);
      stats.lastError = errorMsg;
      return false;
    }
  }

  private async checkThreshold(triggeringModel: string): Promise<void> {
    const threshold =
      this.config.getUsageSettings()?.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;

    // Initialize if missing (migration)
    const lastNotified = this.currentUsage.lastNotificationTokenCount ?? 0;

    // Check if we crossed a new multiple of threshold since last notification.
    // Logic: notify if current total is >= next multiple of threshold
    const nextMilestone =
      (Math.floor(lastNotified / threshold) + 1) * threshold;

    if (this.currentUsage.totalTokens >= nextMilestone) {
      await this.sendWebhook(triggeringModel);
      this.currentUsage.lastNotificationTokenCount =
        this.currentUsage.totalTokens;
      this.saveUsage();
    }
  }

  private async sendWebhook(triggeringModel: string): Promise<void> {
    const webhookUrl = this.config.getWebhookUrl();
    if (!webhookUrl) {
      return;
    }

    const stats = this.currentUsage.modelUsage[triggeringModel];
    const breakdown = stats
      ? `\nDetails for ${triggeringModel}:\n` +
        `- Input: ${stats.input}\n` +
        `- Output: ${stats.output}\n` +
        `- Tool: ${stats.tool}\n` +
        `- Thought: ${stats.thought}\n` +
        `- Cache: ${stats.cache}`
      : '';

    try {
      const payload = {
        msgtype: 'text',
        text: {
          content:
            `Token consumption exceeded threshold!\n` +
            `User: ${os.userInfo().username}\n` +
            `Total accumulated tokens: ${this.currentUsage.totalTokens}\n` +
            `Triggered by model: ${triggeringModel}` +
            breakdown,
        },
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(
          `Failed to send usage webhook: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      console.error('Error sending usage webhook:', error);
    }
  }

  async sendLoopDetectionNotification(loopType: string): Promise<void> {
    const webhookUrl = this.config.getWebhookUrl();
    if (!webhookUrl) return;

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: {
            content: `⚠️ Loop Detected!\nUser: ${os.userInfo().username}\nType: ${loopType}\nSession ID: ${this.config.getSessionId()}\nThe request has been halted.`,
          },
        }),
      });
    } catch (error) {
      console.error('Failed to send loop detection webhook:', error);
    }
  }

  getTotalTokens(): number {
    return this.currentUsage.totalTokens;
  }
}
