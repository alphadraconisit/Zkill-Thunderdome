'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { wrap } = require('../src/async');

test('wrap passes a resolved handler through untouched', async () => {
  let called = false;
  const handler = wrap(async (req, res) => { called = true; res.done = true; });

  const res = {};
  await handler({}, res, () => assert.fail('next should not be called'));
  assert.ok(called);
  assert.equal(res.done, true);
});

test('wrap forwards a rejection to next() instead of leaving the request hanging', async () => {
  const boom = new Error('database is on fire');
  const handler = wrap(async () => { throw boom; });

  const forwarded = await new Promise((resolve) => {
    handler({}, {}, resolve);
  });
  assert.equal(forwarded, boom);
});

test('wrap also catches a synchronous throw', async () => {
  const boom = new Error('thrown before the first await');
  const handler = wrap(() => { throw boom; });

  const forwarded = await new Promise((resolve) => {
    handler({}, {}, resolve);
  });
  assert.equal(forwarded, boom);
});
