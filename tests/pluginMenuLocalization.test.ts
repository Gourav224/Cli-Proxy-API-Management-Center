import { describe, expect, test } from 'bun:test';
import {
  collectPluginResourceEntries,
  localizePluginResourceEntry,
} from '../src/features/plugins/pluginResources';
import type { PluginListEntry } from '../src/types';

const plugin = (id: string, menu: string): PluginListEntry =>
  ({
    id,
    effectiveEnabled: true,
    logo: '',
    menus: [{ path: `/v0/resource/plugins/${id}/dashboard`, menu, description: '原文' }],
    metadata: { name: id },
  }) as unknown as PluginListEntry;

const [tracker] = collectPluginResourceEntries([plugin('cap-token-usage-tracker', 'Token 用量')]);
const [other] = collectPluginResourceEntries([plugin('some-other-plugin', 'Foo')]);

describe('localizePluginResourceEntry', () => {
  test('translates the known plugin into the active language', () => {
    expect(localizePluginResourceEntry(tracker, 'en').label).toBe('Token usage');
    expect(localizePluginResourceEntry(tracker, 'ko').label).toBe('토큰 사용량');
  });

  test("keeps the plugin's own text for Chinese and for unlisted languages", () => {
    expect(localizePluginResourceEntry(tracker, 'zh-CN').label).toBe('Token 用量');
    expect(localizePluginResourceEntry(tracker, 'zh-TW').label).toBe('Token 用量');
    expect(localizePluginResourceEntry(tracker, undefined).label).toBe('Token 用量');
  });

  test('never touches other plugins', () => {
    expect(localizePluginResourceEntry(other, 'en')).toBe(other);
  });
});
