import routeFixtures from './appRoute.fixtures.json';
import { describe, expect, it } from 'vitest';

import {
  createSpaceIssueAppRoute,
  createSpaceHomeAppRoute,
  createSpaceIssuesAppRoute,
  createSpaceToolsAppRoute,
  createTaskCommentAppRoute,
  parseAppRouteUrl,
  serializeAppRoute,
} from './appRoute';

describe('AppRoute', () => {
  it('matches the shared native route corpus', () => {
    for (const { url, route } of routeFixtures.accepted) {
      expect(parseAppRouteUrl(url), url).toEqual(route);
      expect(parseAppRouteUrl(serializeAppRoute(route as Parameters<typeof serializeAppRoute>[0]))).toEqual(route);
    }
    for (const url of routeFixtures.rejected) expect(parseAppRouteUrl(url), url).toBeNull();
    const market = createSpaceToolsAppRoute('official');
    expect(serializeAppRoute(market)).toBe('nexttools://open/v1/spaces/official/tools');
    expect(() => createSpaceToolsAppRoute('')).toThrow();
    expect(() => createSpaceToolsAppRoute('x'.repeat(201))).toThrow();
  });

  it('round-trips supported v1 routes', () => {
    expect(serializeAppRoute(createSpaceHomeAppRoute())).toBe('nexttools://open/v1/spaces');
    expect(serializeAppRoute(createSpaceIssuesAppRoute('nexttools'))).toBe('nexttools://open/v1/spaces/nexttools/issues');
    const route = createSpaceIssueAppRoute('space_1', 'issue-2');
    expect(serializeAppRoute(route)).toBe(
      'nexttools://open/v1/spaces/space_1/issues/issue-2',
    );
    expect(parseAppRouteUrl(serializeAppRoute(route))).toEqual(route);

    const commentRoute = createTaskCommentAppRoute('task_1', 'comment-2');
    expect(serializeAppRoute(commentRoute)).toBe(
      'nexttools://open/v1/tasks/task_1/comments/comment-2',
    );
    expect(parseAppRouteUrl(serializeAppRoute(commentRoute))).toEqual(commentRoute);
  });

  it.each([
    'nexttools://attachment/session/file.png',
    'nexttools://tool-attachment/session/turn/file.png',
    'nexttools-resource://attachment/session/file.png',
    'nexttools://evil/v1/spaces/a/issues/b',
    'nexttools://open/v2/spaces/a/issues/b',
    'nexttools://open/v1/spaces/a/issues/b/extra',
    'nexttools://open/v1/tasks/a/comments/b/extra',
    'nexttools://open/v1/tasks/a/issues/b',
    'nexttools://open/v1/spaces/a/issues/b?prompt=run',
    'nexttools://open/v1/spaces/a/issues/b#fragment',
    'nexttools://open/v1/spaces/a%2Fb/issues/c',
    'nexttools://open/v1/spaces/a/issues/%ZZ',
    'nexttools://user@open/v1/spaces/a/issues/b',
    'nexttools://open:42/v1/spaces/a/issues/b',
  ])('rejects unsupported or ambiguous input: %s', (value) => {
    expect(parseAppRouteUrl(value)).toBeNull();
  });

  it('bounds identifiers before serialization', () => {
    expect(() => createSpaceIssuesAppRoute('')).toThrow();
    expect(() => createSpaceIssuesAppRoute('x'.repeat(201))).toThrow();
    expect(() => createSpaceIssueAppRoute('', 'issue')).toThrow();
    expect(() => createSpaceIssueAppRoute('space', 'x'.repeat(201))).toThrow();
    expect(() => createTaskCommentAppRoute('task', '')).toThrow();
  });
});
