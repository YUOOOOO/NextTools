import stylesheetText from './nexttools-light.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const nextToolsLightThemeManifest = {
  id: 'nexttools-light',
  displayName: 'NextTools Light',
  description: 'Claude-inspired surfaces with neutral-black primary buttons',
  stylesheetText,
} satisfies PresetThemeManifest;
