export type SettingsSection =
  | 'general'
  | 'proxy'
  | 'external-cli'
  | 'shortcuts'
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'sub-agents'
  | 'plugins'
  | 'agent'
  | 'usage-stats'
  | 'desktop-pet'
  | 'about'
  | 'developer';

export const VALID_SECTIONS: SettingsSection[] = [
  'general',
  'proxy',
  'external-cli',
  'shortcuts',
  'providers',
  'mcp',
  'skills',
  'sub-agents',
  'plugins',
  'agent',
  'usage-stats',
  'desktop-pet',
  'about',
  'developer',
];

export const NEXTTOOLS_GITHUB_URL = 'https://github.com/YU0000/NextTools';
export const NEXTTOOLS_SOURCE_CODE_URL = `${NEXTTOOLS_GITHUB_URL}/tree/feature`;
export const NEXTTOOLS_RELEASES_URL = `${NEXTTOOLS_GITHUB_URL}/releases`;

export const PLAYWRIGHT_DEVICE_PRESETS = [
  'iPhone 15 Pro',
  'iPhone 15',
  'iPhone SE',
  'iPad Pro 11',
  'Pixel 7',
  'Galaxy S23',
];
