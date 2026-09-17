const test = require('node:test');
const assert = require('node:assert/strict');

const server = require('../server.js');

test('temporary trim files are detected', () => {
  assert.equal(server.isTemporaryTrimFile('clip.tmp-123-456.mp4'), true);
  assert.equal(server.isTemporaryTrimFile('clip [trim 00-00-10_00-00-15].tmp-123-456.mp4'), true);
  assert.equal(server.isTemporaryTrimFile('clip [trim 00-00-10_00-00-15].mp4'), false);
});

test('trim outputs are named consistently', () => {
  assert.equal(
    server.buildTrimmedVideoName('example.mp4', 10, 15),
    'example [trim 00-00-10_00-00-15].mp4'
  );
});

test('multi-scene outputs identify the edit mode and ranges', () => {
  assert.equal(
    server.buildMultiSceneVideoName('example.mp4', 'keep-scenes', [
      { start: 10, end: 20 },
      { start: 30, end: 40 }
    ]),
    'example [scenes 00-00-10_00-00-20__00-00-30_00-00-40].mp4'
  );
  assert.equal(
    server.buildMultiSceneVideoName('example.mp4', 'remove-scene', [
      { start: 10, end: 20 }
    ]),
    'example [remove 00-00-10_00-00-20].mp4'
  );
});

test('time parsing accepts standard HH:MM:SS values', () => {
  assert.equal(server.parseTimeToSeconds('00:01:30'), 90);
  assert.equal(server.parseTimeToSeconds('00:00:45'), 45);
});

test('computeVideoSegments returns a single full segment for short videos', () => {
  assert.deepEqual(server.computeVideoSegments(3, 5), [{ position: 'begin', start: 0, end: 3 }]);
});

test('computeVideoSegments splits longer videos into begin, middle, end', () => {
  const segments = server.computeVideoSegments(30, 5);
  assert.deepEqual(segments, [
    { position: 'begin', start: 0, end: 5 },
    { position: 'middle', start: 12.5, end: 17.5 },
    { position: 'end', start: 25, end: 30 }
  ]);
});

test('buildMixPlan in linear mode keeps each video\'s clips together in order', () => {
  const videos = [
    { name: 'a.mp4', duration: 30 },
    { name: 'b.mp4', duration: 30 }
  ];
  const plan = server.buildMixPlan(videos, {
    clipSeconds: 5,
    totalSeconds: 1000,
    arrangement: 'linear',
    mixedOrder: false
  });
  assert.deepEqual(plan.map((clip) => clip.videoName), ['a.mp4', 'a.mp4', 'a.mp4', 'b.mp4', 'b.mp4', 'b.mp4']);
});

test('buildMixPlan in mixed mode groups clips by position across videos', () => {
  const videos = [
    { name: 'a.mp4', duration: 30 },
    { name: 'b.mp4', duration: 30 }
  ];
  const plan = server.buildMixPlan(videos, {
    clipSeconds: 5,
    totalSeconds: 1000,
    arrangement: 'mixed',
    mixedOrder: false
  });
  assert.deepEqual(plan.map((clip) => clip.videoName), ['a.mp4', 'b.mp4', 'a.mp4', 'b.mp4', 'a.mp4', 'b.mp4']);
});

test('buildMixPlan trims the final clip to fit the requested total length', () => {
  const videos = [{ name: 'a.mp4', duration: 30 }];
  const plan = server.buildMixPlan(videos, {
    clipSeconds: 5,
    totalSeconds: 7,
    arrangement: 'linear',
    mixedOrder: false
  });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].end - plan[0].start, 5);
  assert.equal(plan[1].end - plan[1].start, 2);
});

test('buildMixPlan includes whole short videos without worrying about linear/mixed split', () => {
  const videos = [{ name: 'short.mp4', duration: 2 }];
  const plan = server.buildMixPlan(videos, {
    clipSeconds: 5,
    totalSeconds: 10,
    arrangement: 'mixed',
    mixedOrder: false
  });
  assert.deepEqual(plan, [{ videoName: 'short.mp4', start: 0, end: 2 }]);
});

test('buildMixVideoName produces a mix-${date} style name', () => {
  const date = new Date(2026, 0, 5, 9, 3, 7);
  assert.equal(server.buildMixVideoName(date), 'mix-2026-01-05_09-03-07.mp4');
});
