import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { SettingsSection } from '../settingsSections';
import { SettingsSidebar } from './SettingsSidebar';

function SidebarProbe({ developerUnlocked = false, onOpenAgentNetwork = () => {} }: { developerUnlocked?: boolean; onOpenAgentNetwork?: () => void }) {
  const [section, setSection] = useState<SettingsSection>('general');
  return (
    <SettingsSidebar
      activeSection={section}
      setActiveSection={setSection}
      showDevTools
      developerUnlocked={developerUnlocked}
      onShowLogs={() => {}}
      onOpenAgentNetwork={onOpenAgentNetwork}
    />
  );
}

describe('SettingsSidebar i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders navigation labels from the settings namespace', () => {
    render(<SidebarProbe />);

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Model Providers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desktop Pet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Network Proxy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'External Calls' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skills' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Plugins' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'About' })).not.toBeInTheDocument();
    expect(screen.getByTitle('View Rust logs')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Developer' })).not.toBeInTheDocument();
  });

  it('keeps the product-defined settings order', () => {
    render(<SidebarProbe />);

    const labels = within(screen.getByRole('navigation'))
      .getAllByRole('button')
      .map(button => button.textContent);
    expect(labels).toEqual([
      'Model Providers',
      'General',
      'Channel',
      'Desktop Pet',
      'Usage',
      'Network Proxy',
      'External Calls',
      'Shortcuts',
      'AgentNet Local Network',
    ]);
  });

  it('adds Developer after Shortcuts only when previously unlocked', () => {
    render(<SidebarProbe developerUnlocked />);

    const labels = within(screen.getByRole('navigation'))
      .getAllByRole('button')
      .map(button => button.textContent);
    expect(labels.slice(-3)).toEqual(['Shortcuts', 'Developer', 'AgentNet Local Network']);
  });

  it('opens AgentNet through its shared navigation action', () => {
    const onOpenAgentNetwork = vi.fn();
    render(<SidebarProbe onOpenAgentNetwork={onOpenAgentNetwork} />);
    fireEvent.click(screen.getByRole('button', { name: 'AgentNet Local Network' }));
    expect(onOpenAgentNetwork).toHaveBeenCalledOnce();
  });
});
