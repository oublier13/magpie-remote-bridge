'use strict';

function cancelled() {
  const error = new Error('Connection cancelled');
  error.name = 'AbortError';
  return error;
}

function isCancelled(error) {
  return error?.name === 'AbortError';
}

/** Ends the caller's wait on abort while still observing the underlying result. */
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    // Always attach both handlers, including when already aborted, so a late
    // setup failure cannot become an unhandled rejection.
    Promise.resolve(work).then(value => finish(undefined, value), error => finish(error));
    if (signal.aborted) abort();
  });
}

module.exports = { cancelled, isCancelled, abortable };
