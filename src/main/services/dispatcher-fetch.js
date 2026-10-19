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

/**
 * What the callers send. Spelled out instead of `RequestInit`: the runtime's
 * `fetch` and the package's come with their own, incompatible `RequestInit`
 * and `BodyInit` types, and a request body here is always text.
 *
 * @typedef {Object} FetchViaOptions
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string} [body]
 * @property {AbortSignal} [signal]
 * @property {'follow'|'manual'|'error'} [redirect]
 * @property {import('undici').Dispatcher} [dispatcher]
 *
 * @param {string|URL} url
 * @param {FetchViaOptions} [options]
 * @returns {Promise<Response>}
 */
function fetchVia(url, options = {}) {
  const { dispatcher, ...init } = options;
  return dispatcher ? undici.fetch(url, { ...init, dispatcher }) : globalThis.fetch(url, init);
}

module.exports = { fetchVia };
