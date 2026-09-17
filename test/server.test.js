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
