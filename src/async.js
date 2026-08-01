'use strict';

/**
 * Express 4 does not catch rejections from async handlers, so every route that
 * awaits goes through this — otherwise a failed query hangs the request instead
 * of reaching the error middleware.
 */
function wrap(handler) {
  return (req, res, next) => {
    // The handler is invoked inside the promise so that a throw before the
    // first await is forwarded the same way a rejection is.
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
}

module.exports = { wrap };
