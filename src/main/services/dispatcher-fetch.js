'use strict';

/**
 * fetch for requests that bring their own undici dispatcher (#699).
 *
 * The runtime's `fetch` is the undici that ships inside Node and Electron
 * (7.x), while every `Agent` here comes from the `undici` package (8.x). Since
 * undici 8 the two speak different handler APIs: the bundled `fetch` refuses a
 * package `Agent` with "invalid onRequestStart method" before it connects. A
 * request with a dispatcher therefore goes out through the `fetch` of the
 * dispatcher's own package; every other request stays on the runtime's.
 *
 * Both are looked up at call time, so a test that replaces either one sees the
 * call.
 */
const undici = require('undici');

function fetchVia(url, options = {}) {
  return options?.dispatcher ? undici.fetch(url, options) : globalThis.fetch(url, options);
}

module.exports = { fetchVia };
