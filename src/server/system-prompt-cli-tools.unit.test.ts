import { describe, expect, it, vi } from 'vitest';
import type { InteractionScenario } from './system-prompt';

vi.mock('./utils/cli-tools-registry', () => ({
  getUserToolsPromptSection: () => '<nexttools-user-tools>registered</nexttools-user-tools>',
}));

const { buildCliToolsAppend, buildSessionInboxSection } = await import('./system-prompt-cli-tools');
const { IMAGE_UNDERSTANDING_TOOL_ID, SPEECH_RECOGNITION_TOOL_ID } = await import('../shared/official-tools');

describe('buildCliToolsAppend', () => {
  it('discovers local capabilities and local/network collaboration without conflating Task or permission scope', () => {
    const text = buildSessionInboxSection({ type: 'desktop' });
    for (const command of [
      'nexttools --help', 'nexttools agent list', 'nexttools agent show <agentId>',
      'nexttools session list --agent <agentId>', 'nexttools session start --agent <agentId>',
      'nexttools session send <sessionId>', 'nexttools session get <sessionId>',
      'nexttools session state <sessionId>', 'nexttools session watch <sessionId>',
      'nexttools session watches', 'nexttools agent network-diagnose --json',
      'nexttools <group> <action> --help',
    ]) expect(text).toContain(command);
    expect(text).toContain('MCP, providers, skills and configuration');
    expect(text).toContain('durable work, scheduling and run tracking');
    expect(text).toContain('other devices');
    expect(text).toContain('description, deviceName and isLocal');
    expect(text).toContain('ma-agent:1');
    expect(text).toContain('ma-session:1');
    expect(text).toContain('visible requests and answers');
    expect(text).toContain('idle/running/waiting_user_action');
    expect(text).toContain('not an existing Session');
    expect(text).toContain('Never approve remotely');
    expect(text).toContain('tell your user');
    expect(text).not.toContain('complete current contract');
    expect(text).toContain('Treat them as system-delivered');
  });

  it('keeps stable CLI capabilities while user-registered tools are gated off', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).toContain('<nexttools-cli-task-automation>');
    expect(text).toContain('nexttools-task-automation');
    expect(text).toContain('nexttools task readme');
    expect(text).not.toContain('<nexttools-cli-cron>');
    expect(text).toContain('<nexttools-cli-goal>');
    expect(text).toContain('<nexttools-cli-record>');
    expect(text).toContain('nexttools record create');
    expect(text).not.toContain('nexttools thought create');
    expect(text).toContain('nexttools goal --help');
    expect(text).toContain('goal-objective.txt');
    expect(text).toContain('system\ntemp files are both accepted');
    expect(text).not.toContain('<nexttools-user-tools>');
    expect(text.toLowerCase()).not.toContain('anydoc');
  });

  it('injects Goal Mode into private user-facing channel prompts', () => {
    const imText = buildCliToolsAppend(
      { type: 'im', platform: 'feishu', sourceType: 'private' },
      { includeUserTools: false },
    );
    const channelText = buildCliToolsAppend(
      { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      { includeUserTools: false },
    );

    expect(imText).toContain('<nexttools-cli-goal>');
    expect(channelText).toContain('<nexttools-cli-goal>');
    expect(imText).toContain('目标模式');
    expect(channelText).toContain('设立目标');
  });

  it('does not inject Goal Mode into headless or semi-open prompts', () => {
    const cronText = buildCliToolsAppend(
      { type: 'cron', taskId: 'task-1', intervalMinutes: 5, aiCanExit: true },
      { includeUserTools: false },
    );
    const registeredAgentText = buildCliToolsAppend(
      { type: 'registeredAgent', platform: 'space', spaceId: 'space-1', registeredAgentId: 'ra-1' },
      { includeUserTools: false },
    );
    const imGroupText = buildCliToolsAppend(
      { type: 'im', platform: 'feishu', sourceType: 'group' },
      { includeUserTools: false },
    );
    const agentChannelGroupText = buildCliToolsAppend(
      { type: 'agent-channel', platform: 'feishu', sourceType: 'group' },
      { includeUserTools: false },
    );

    expect(cronText).not.toContain('<nexttools-cli-goal>');
    expect(cronText).not.toContain('nexttools goal create');
    expect(cronText).toContain('<nexttools-cli-task-exit>');
    expect(cronText).toContain('nexttools task exit');
    expect(registeredAgentText).not.toContain('<nexttools-cli-goal>');
    expect(registeredAgentText).not.toContain('nexttools goal create');
    expect(imGroupText).not.toContain('<nexttools-cli-goal>');
    expect(imGroupText).not.toContain('nexttools goal create');
    expect(agentChannelGroupText).not.toContain('<nexttools-cli-goal>');
    expect(agentChannelGroupText).not.toContain('nexttools goal create');
  });

  it('exposes Record capture in desktop conversations and private channels', () => {
    const scenarios: InteractionScenario[] = [
      { type: 'desktop' },
      { type: 'desktop', surface: 'floating-ball' },
      { type: 'im', platform: 'telegram', sourceType: 'private' },
      { type: 'im', platform: 'feishu', sourceType: 'private' },
      { type: 'agent-channel', platform: 'dingtalk', sourceType: 'private' },
    ];
    for (const scenario of scenarios) {
      expect(buildCliToolsAppend(scenario)).toContain('<nexttools-cli-record>');
    }
  });

  it('omits Record capture from group channels and background scenarios', () => {
    const scenarios: InteractionScenario[] = [
      { type: 'im', platform: 'telegram', sourceType: 'group' },
      { type: 'im', platform: 'feishu', sourceType: 'group' },
      { type: 'agent-channel', platform: 'dingtalk', sourceType: 'group' },
      { type: 'cron', taskId: 'task-1', intervalMinutes: 5, aiCanExit: true },
      { type: 'registeredAgent', platform: 'space', spaceId: 'space-1', registeredAgentId: 'agent-1' },
    ];
    for (const scenario of scenarios) {
      const text = buildCliToolsAppend(scenario);
      expect(text).not.toContain('<nexttools-cli-record>');
      expect(text).not.toContain('nexttools record create');
      if (scenario.type === 'im' || scenario.type === 'agent-channel') {
        expect(text).toContain('<nexttools-cli-im-media>');
      }
    }
  });

  it('includes user-registered CLI tools only when explicitly enabled', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: true });

    expect(text).toContain('<nexttools-user-tools>registered</nexttools-user-tools>');
  });

  it('does not inject official image understanding by default', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).not.toContain('<nexttools-cli-vision>');
  });

  it('injects official image understanding when the session enables it', () => {
    const text = buildCliToolsAppend(
      { type: 'desktop' },
      { includeUserTools: false, enabledOfficialToolIds: [IMAGE_UNDERSTANDING_TOOL_ID] },
    );

    expect(text).toContain('<nexttools-cli-vision>');
    expect(text).toContain('nexttools vision analyze');
    expect(text).toContain('--prompt-file');
    expect(text).toContain('[Unsupported Image]');
    expect(text).toContain('nexttools vision --help');
    expect(text).toContain('shell-sensitive');
    expect(text).toContain('user-provided');
  });

  it('injects only the thin speech discovery hint when the session authorizes it', () => {
    const text = buildCliToolsAppend(
      { type: 'desktop' },
      { includeUserTools: false, enabledOfficialToolIds: [SPEECH_RECOGNITION_TOOL_ID] },
    );

    expect(text).toContain('<nexttools-cli-speech>');
    expect(text).toContain('nexttools-speech-recognition');
    expect(text).toContain('nexttools speech --help');
    expect(text).toContain('automatically binds');
    expect(text).not.toContain('nexttools speech transcribe --file');
  });
});
