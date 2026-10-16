import { describe, expect, it } from 'vitest';

import {
  getNextToolsNpmGlobalBinDir,
  getNextToolsNpmGlobalPrefix,
  scrubNextToolsNpmPrefixEnv,
} from './npm-prefix-env';

describe('npm prefix env utilities', () => {
  it('builds the NextTools npm global prefix and bin dir per platform', () => {
    expect(getNextToolsNpmGlobalPrefix('/Users/tester', 'darwin')).toBe('/Users/tester/.nexttools/npm-global');
    expect(getNextToolsNpmGlobalBinDir('/Users/tester', 'darwin')).toBe('/Users/tester/.nexttools/npm-global/bin');

    expect(getNextToolsNpmGlobalPrefix('C:\\Users\\tester', 'win32')).toMatch(/C:[/\\]Users[/\\]tester[/\\]\.nexttools[/\\]npm-global/);
    expect(getNextToolsNpmGlobalBinDir('C:\\Users\\tester', 'win32')).toMatch(/C:[/\\]Users[/\\]tester[/\\]\.nexttools[/\\]npm-global/);
  });

  it('scrubs only npm prefix variables that point at the NextTools prefix', () => {
    const prefix = '/Users/tester/.nexttools/npm-global';
    const env: NodeJS.ProcessEnv = {
      npm_config_prefix: `${prefix}/`,
      NPM_CONFIG_PREFIX: '/Users/tester/.npm-global',
      PREFIX: prefix,
    };

    scrubNextToolsNpmPrefixEnv(env, prefix, 'darwin');

    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.NPM_CONFIG_PREFIX).toBe('/Users/tester/.npm-global');
    expect(env.PREFIX).toBeUndefined();
  });
});
