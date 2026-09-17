const test = require('node:test');
const assert = require('node:assert/strict');

const server = require('../server.js');

function assertCloseTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, message || `expected ${actual} to be close to ${expected}`);
}

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
  assert.deepEqual(
    server.computeVideoSegments(3, { begin: 5, middle: 5, end: 5 }),
    [{ position: 'begin', start: 0, end: 3 }]
  );
});

test('computeVideoSegments splits longer videos into begin, middle, end thirds with random placement', () => {
  const segments = server.computeVideoSegments(30, { begin: 5, middle: 5, end: 5 });
  assert.equal(segments.length, 3);

  const [begin, middle, end] = segments;
  assert.equal(begin.position, 'begin');
  assertCloseTo(begin.end - begin.start, 5);
  assert.ok(begin.start >= 0 && begin.end <= 10);

  assert.equal(middle.position, 'middle');
  assertCloseTo(middle.end - middle.start, 5);
  assert.ok(middle.start >= 10 && middle.end <= 20);

  assert.equal(end.position, 'end');
  assertCloseTo(end.end - end.start, 5);
  assert.ok(end.start >= 20 && end.end <= 30);
});

test('computeVideoSegments supports independent per-position clip lengths within their third', () => {
  const segments = server.computeVideoSegments(90, { begin: 10, middle: 20, end: 5 });
  assert.equal(segments.length, 3);

  const [begin, middle, end] = segments;
  assertCloseTo(begin.end - begin.start, 10);
  assert.ok(begin.start >= 0 && begin.end <= 30);

  assertCloseTo(middle.end - middle.start, 20);
  assert.ok(middle.start >= 30 && middle.end <= 60);

  assertCloseTo(end.end - end.start, 5);
  assert.ok(end.start >= 60 && end.end <= 90);
});

test('computeVideoSegments clamps to the full third when the requested length exceeds it', () => {
  const segments = server.computeVideoSegments(30, { begin: 20, middle: 5, end: 5 });
  const begin = segments.find((seg) => seg.position === 'begin');
  assert.deepEqual(begin, { position: 'begin', start: 0, end: 10 });
});

test('computeVideoSegments only includes enabled positions', () => {
  const segments = server.computeVideoSegments(30, { begin: 5, middle: 5, end: 5 }, ['begin', 'end']);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].position, 'begin');
  assert.equal(segments[1].position, 'end');
  assertCloseTo(segments[0].end - segments[0].start, 5);
  assertCloseTo(segments[1].end - segments[1].start, 5);
});

test('buildMixPlan in linear mode keeps each video\'s clips together in order', () => {
  const videos = [
    { name: 'a.mp4', duration: 30 },
    { name: 'b.mp4', duration: 30 }
  ];
  const plan = server.buildMixPlan(videos, {
    beginSeconds: 5,
    middleSeconds: 5,
    endSeconds: 5,
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
    beginSeconds: 5,
    middleSeconds: 5,
    endSeconds: 5,
    totalSeconds: 1000,
    arrangement: 'mixed',
    mixedOrder: false
  });
  assert.deepEqual(plan.map((clip) => clip.videoName), ['a.mp4', 'b.mp4', 'a.mp4', 'b.mp4', 'a.mp4', 'b.mp4']);
});

test('buildMixPlan trims the final clip to fit the requested total length', () => {
  const videos = [{ name: 'a.mp4', duration: 30 }];
  const plan = server.buildMixPlan(videos, {
    beginSeconds: 5,
    middleSeconds: 5,
    endSeconds: 5,
    totalSeconds: 7,
    arrangement: 'linear',
    mixedOrder: false
  });
  assert.equal(plan.length, 2);
  assertCloseTo(plan[0].end - plan[0].start, 5);
  assertCloseTo(plan[1].end - plan[1].start, 2);
});

test('buildMixPlan includes whole short videos without worrying about linear/mixed split', () => {
  const videos = [{ name: 'short.mp4', duration: 2 }];
  const plan = server.buildMixPlan(videos, {
    beginSeconds: 5,
    middleSeconds: 5,
    endSeconds: 5,
    totalSeconds: 10,
    arrangement: 'mixed',
    mixedOrder: false
  });
  assert.deepEqual(plan, [{ videoName: 'short.mp4', start: 0, end: 2 }]);
});

test('buildMixPlan only includes selected clip positions', () => {
  const videos = [{ name: 'a.mp4', duration: 30 }];
  const plan = server.buildMixPlan(videos, {
    beginSeconds: 5,
    middleSeconds: 5,
    endSeconds: 5,
    positions: ['middle'],
    totalSeconds: 1000,
    arrangement: 'linear',
    mixedOrder: false
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].videoName, 'a.mp4');
  assert.ok(Math.abs((plan[0].end - plan[0].start) - 5) < 1e-6);
  assert.ok(plan[0].start >= 10 && plan[0].end <= 20);
});

test('buildMixVideoName produces a mix-${date} style name', () => {
  const date = new Date(2026, 0, 5, 9, 3, 7);
  assert.equal(server.buildMixVideoName(date), 'mix-2026-01-05_09-03-07.mp4');
});
