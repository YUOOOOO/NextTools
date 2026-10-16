import { describe, expect, it } from 'vitest';

import { isAutoAllowedRecordCliCommand } from '../agent-session';

describe('Record CLI automatic permission', () => {
  it.each([
    'nexttools record list',
    'nexttools record list --kind text --tag meeting-1 --limit 25 --json',
    'nexttools record list --json --kind audio',
    'nexttools thought list --tag legacy --limit 10 --json',
    "nexttools record create 'remember $(literal) and `literal`'",
    "nexttools record create --content 'multi word literal'",
    'nexttools record create --content-file /tmp/record.txt',
    "nexttools thought create 'legacy literal'",
    'nexttools thought create --content-file C:\\Temp\\record.txt',
  ])('allows the bounded literal form: %s', command => {
    expect(isAutoAllowedRecordCliCommand(command)).toBe(true);
  });

  it.each([
    "nexttools record list --query '$(touch /tmp/pwn)'",
    'nexttools record list --kind video',
    'nexttools thought list --kind audio',
    'nexttools record create "$(touch /tmp/pwn)"',
    'nexttools record create --content "$(touch /tmp/pwn)"',
    "nexttools record create 'safe' extra",
    "nexttools record create 'safe'; touch /tmp/pwn",
    "nexttools record create 'safe' && touch /tmp/pwn",
    'nexttools record create --content-file /tmp/record.txt;touch',
    "nexttools record create --content-file '/tmp/record.txt'",
    "nexttools record list\nrm -rf /tmp/pwn",
  ])('requires normal permission handling for: %s', command => {
    expect(isAutoAllowedRecordCliCommand(command)).toBe(false);
  });
});
