import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, findUrl, igMediaId, igQuery, prefersAudio, threadsShortcode } from '../src/links.js';
import { unescapeHtml } from '../src/extract.js';

test('finds the link in shared text', () => {
  assert.equal(findUrl('Check this out https://youtu.be/abc?si=x !'), 'https://youtu.be/abc?si=x');
  assert.equal(findUrl('(https://x.com/a/status/1).'), 'https://x.com/a/status/1');
  assert.equal(findUrl('no link here'), null);
});

test('platforms', () => {
  const cases = {
    'https://www.youtube.com/watch?v=x': 'youtube',
    'https://music.youtube.com/watch?v=x': 'youtube',
    'https://youtu.be/x': 'youtube',
    'https://www.instagram.com/p/x/': 'instagram',
    'https://www.threads.com/@a/post/x': 'threads',
    'https://vm.tiktok.com/x': 'tiktok',
    'https://x.com/a/status/1': 'x',
    'https://fb.watch/x': 'facebook',
    'https://soundcloud.com/a/b': 'soundcloud',
    'https://open.spotify.com/track/x': 'spotify',
    'https://www.deezer.com/track/1': 'deezer',
    'https://music.apple.com/us/album/x/1?i=2': 'applemusic',
    'https://example.com/video': 'generic',
  };
  for (const [url, p] of Object.entries(cases)) assert.equal(detectPlatform(url), p, url);
  assert.ok(prefersAudio('https://music.youtube.com/watch?v=x'));
  assert.ok(prefersAudio('https://open.spotify.com/track/x'));
  assert.ok(!prefersAudio('https://www.youtube.com/watch?v=x'));
});

test('Instagram ids (as go/internal/instagram)', () => {
  assert.equal(igMediaId('DeC7YkZJsF0'), '4000020592146694516');
  assert.equal(igMediaId('Ddcpb5hJAte'), '3989245607035538270');
  assert.equal(igQuery('https://www.instagram.com/reel/Ddcpb5hJAte/').mediaId, '3989245607035538270');
  assert.deepEqual(
    { ...igQuery('https://www.instagram.com/stories/someone/3456789/') },
    { kind: 'story', username: 'someone', storyPk: '3456789', appId: '936619743392459' },
  );
  assert.equal(threadsShortcode('https://www.threads.com/@a/post/DAbc_12-x'), 'DAbc_12-x');
});

test('HTML entities in titles', () => {
  assert.equal(unescapeHtml('Scramble up ur name &amp; I&#39;ll guess &#x1F60D;'), "Scramble up ur name & I'll guess 😍");
  assert.equal(unescapeHtml('a &unknown; b'), 'a &unknown; b');
  assert.equal(unescapeHtml(undefined), undefined);
});
