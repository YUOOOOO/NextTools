import stylesheetText from './default-black.css?inline';
import type { PresetThemeManifest } from './preset-theme';

export const defaultBlackThemeManifest = {
  id: 'default-black',
  displayName: 'NextTools Classic2',
  description: 'NextTools Classic with neutral-black primary buttons',
  stylesheetText,
} satisfies PresetThemeManifest;
