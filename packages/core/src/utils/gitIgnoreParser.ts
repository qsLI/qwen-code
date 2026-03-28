/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { profilerService } from '../services/profilerService.js';

export interface GitIgnoreFilter {
  isIgnored(filePath: string): boolean;
}

export class GitIgnoreParser implements GitIgnoreFilter {
  private projectRoot: string;
  private cache: Map<string, string[]> = new Map();
  private accumulatedPatternsCache: Map<string, string[]> = new Map();
  private ignoreInstanceCache: Map<string, ReturnType<typeof ignore>> = new Map();
  private globalPatterns: string[] | undefined;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  private loadPatternsForFile(patternsFilePath: string): string[] {
    let content: string;
    try {
      content = fs.readFileSync(patternsFilePath, 'utf-8');
    } catch (_error) {
      return [];
    }

    const isExcludeFile = patternsFilePath.endsWith(
      path.join('.git', 'info', 'exclude'),
    );

    const relativeBaseDir = isExcludeFile
      ? '.'
      : path.dirname(path.relative(this.projectRoot, patternsFilePath));

    return content
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p !== '' && !p.startsWith('#'))
      .map((p) => {
        const isNegative = p.startsWith('!');
        if (isNegative) {
          p = p.substring(1);
        }

        const isAnchoredInFile = p.startsWith('/');
        if (isAnchoredInFile) {
          p = p.substring(1);
        }

        // An empty pattern can result from a negated pattern like `!`,
        // which we can ignore.
        if (p === '') {
          return '';
        }

        let newPattern = p;
        if (relativeBaseDir && relativeBaseDir !== '.') {
          // Only in nested .gitignore files, the patterns need to be modified according to:
          // - If `a/b/.gitignore` defines `/c` then it needs to be changed to `/a/b/c`
          // - If `a/b/.gitignore` defines `c` then it needs to be changed to `/a/b/**/c`
          // - If `a/b/.gitignore` defines `c/d` then it needs to be changed to `/a/b/c/d`

          if (!isAnchoredInFile && !p.includes('/')) {
            // If no slash and not anchored in file, it matches files in any
            // subdirectory.
            newPattern = path.join('**', p);
          }

          // Prepend the .gitignore file's directory.
          newPattern = path.join(relativeBaseDir, newPattern);

          // Anchor the pattern to a nested gitignore directory.
          if (!newPattern.startsWith('/')) {
            newPattern = '/' + newPattern;
          }
        }

        // Anchor the pattern if originally anchored
        if (isAnchoredInFile && !newPattern.startsWith('/')) {
          newPattern = '/' + newPattern;
        }

        if (isNegative) {
          newPattern = '!' + newPattern;
        }

        // Even in windows, Ignore expects forward slashes.
        newPattern = newPattern.replace(/\\/g, '/');

        return newPattern;
      })
      .filter((p) => p !== '');
  }

  isIgnored(filePath: string): boolean {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    const absoluteFilePath = path.resolve(this.projectRoot, filePath);
    if (!absoluteFilePath.startsWith(this.projectRoot)) {
      return false;
    }

    profilerService.mark('git_ignore_check', 'start', { filePath });

    try {
      const dir = path.dirname(absoluteFilePath);
      const ig = this.getIgnoreInstance(dir);

      const resolved = path.resolve(this.projectRoot, filePath);
      const relativePath = path.relative(this.projectRoot, resolved);

      if (relativePath === '' || relativePath.startsWith('..')) {
        profilerService.mark('git_ignore_check', 'end');
        return false;
      }

      // Even in windows, Ignore expects forward slashes.
      const normalizedPath = relativePath.replace(/\\/g, '/');

      if (normalizedPath.startsWith('/') || normalizedPath === '') {
        profilerService.mark('git_ignore_check', 'end');
        return false;
      }

      const result = ig.ignores(normalizedPath);
      profilerService.mark('git_ignore_check', 'end');
      return result;
    } catch (_error) {
      profilerService.mark('git_ignore_check', 'end');
      return false;
    }
  }

  private getIgnoreInstance(dir: string): ReturnType<typeof ignore> {
    if (this.ignoreInstanceCache.has(dir)) {
      return this.ignoreInstanceCache.get(dir)!;
    }

    // Base case: projectRoot
    if (dir === this.projectRoot) {
      // Load global patterns from .git/info/exclude on first call
      if (this.globalPatterns === undefined) {
        const excludeFile = path.join(
          this.projectRoot,
          '.git',
          'info',
          'exclude',
        );
        this.globalPatterns = fs.existsSync(excludeFile)
          ? this.loadPatternsForFile(excludeFile)
          : [];
      }

      let patterns = this.cache.get(dir);
      if (!patterns) {
        const gitignorePath = path.join(dir, '.gitignore');
        patterns = fs.existsSync(gitignorePath)
          ? this.loadPatternsForFile(gitignorePath)
          : [];
        this.cache.set(dir, patterns);
      }

      const allPatterns = ['.git', ...this.globalPatterns, ...patterns];
      this.accumulatedPatternsCache.set(dir, allPatterns);

      const ig = ignore().add(allPatterns);
      this.ignoreInstanceCache.set(dir, ig);
      return ig;
    }

    // Recursive case
    // Ensure we don't go above root (safety check, though logic should prevent it)
    if (!dir.startsWith(this.projectRoot)) {
      return ignore();
    }

    const parent = path.dirname(dir);
    const parentIg = this.getIgnoreInstance(parent);

    // Check if this directory is already ignored by parent
    const relativeDir = path
      .relative(this.projectRoot, dir)
      .replace(/\\/g, '/');
    if (relativeDir && parentIg.ignores(relativeDir)) {
      // If ignored by parent, we can reuse parent's instance as new rules won't matter
      this.ignoreInstanceCache.set(dir, parentIg);
      // We can also alias the accumulated patterns for safety, though they shouldn't be needed
      const parentPatterns = this.accumulatedPatternsCache.get(parent);
      if (parentPatterns) {
        this.accumulatedPatternsCache.set(dir, parentPatterns);
      }
      return parentIg;
    }

    // Load patterns for this directory
    let patterns = this.cache.get(dir);
    if (!patterns) {
      const gitignorePath = path.join(dir, '.gitignore');
      patterns = fs.existsSync(gitignorePath)
        ? this.loadPatternsForFile(gitignorePath)
        : [];
      this.cache.set(dir, patterns);
    }

    // Optimization: If no new patterns, reuse parent instance
    if (patterns.length === 0) {
      this.ignoreInstanceCache.set(dir, parentIg);
      const parentPatterns = this.accumulatedPatternsCache.get(parent);
      if (parentPatterns) {
        this.accumulatedPatternsCache.set(dir, parentPatterns);
      }
      return parentIg;
    }

    // Combine with parent's accumulated patterns
    const parentPatterns = this.accumulatedPatternsCache.get(parent) || [];
    const allPatterns = [...parentPatterns, ...patterns];
    this.accumulatedPatternsCache.set(dir, allPatterns);

    const ig = ignore().add(allPatterns);
    this.ignoreInstanceCache.set(dir, ig);
    return ig;
  }
}
