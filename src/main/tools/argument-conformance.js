'use strict';

/**
 * Measures how closely a tool call's arguments follow the definition's JSON
 * schema (#187), without ever blocking it.
 *
 * `validateArguments` in the planner blocks a call on the first violation,
 * which is right for the basics it checks — and makes it useless as a
 * measuring instrument: every new check there turns into a new refusal. This
 * branch sits next to it and only counts what it lets through:
 *
 * - properties the schema does not know (a `path` sent to `search_in_files`),
 * - numbers where the schema asks for an `integer`,
 * - array elements that do not match `items`.
 *
 * The result names the offending argument paths, never their values: it ends
 * up in the stored history, and a value may be file content.
 */

const MAX_PATHS_PER_KIND = 32;

function typeOf(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/** Whether `value` has the base type `expected`; unknown or missing types match anything. */
function matchesBaseType(expected, value) {
  if (typeof expected !== 'string') return true;
  const actual = typeOf(value);
  if (expected === 'integer' || expected === 'number') return actual === 'number';
  return actual === expected;
}

function allowsUnknownProperties(schema) {
  if (!schema.properties || typeof schema.properties !== 'object') return true;
  return schema.additionalProperties === true
    || (schema.additionalProperties !== null && typeof schema.additionalProperties === 'object');
}

function createCollector() {
  const found = { unknownProperties: [], nonInteger: [], invalidItems: [] };
  return {
    add(kind, path) {
      if (found[kind].length < MAX_PATHS_PER_KIND) found[kind].push(path);
    },
    result() {
      const out = {};
      for (const [kind, paths] of Object.entries(found)) {
        if (paths.length > 0) out[kind] = paths;
      }
      return Object.keys(out).length > 0 ? out : null;
    },
  };
}

function measureObject(schema, value, prefix, collector) {
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const checkUnknown = !allowsUnknownProperties(schema);
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const spec = Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null;
    if (!spec) {
      if (checkUnknown) collector.add('unknownProperties', path);
      continue;
    }
    measureValue(spec, entry, path, collector);
  }
}

function measureValue(spec, value, path, collector) {
  if (!spec || typeof spec !== 'object' || value === undefined || value === null) return;
  // A wrong base type is `validateArguments`' business — it blocks the call
  // and the refusal is counted from the audit entry instead.
  if (!matchesBaseType(spec.type, value)) return;
  if (spec.type === 'integer' && !Number.isInteger(value)) {
    collector.add('nonInteger', path);
  } else if (spec.type === 'array' && spec.items && typeof spec.items === 'object') {
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (item === undefined || item === null || !matchesBaseType(spec.items.type, item)) {
        collector.add('invalidItems', itemPath);
        return;
      }
      measureValue(spec.items, item, itemPath, collector);
    });
  } else if (spec.type === 'object' && typeOf(value) === 'object') {
    measureObject(spec, value, path, collector);
  }
}

/**
 * @param {{ parameters?: object }} definition  tool definition from the registry
 * @param {object} args  parsed arguments as the model sent them
 * @returns {{ unknownProperties?: string[], nonInteger?: string[], invalidItems?: string[] } | null}
 *   the argument paths per kind of violation, or null when nothing was found
 *   (or the arguments are not an object, which `validateArguments` refuses)
 */
function measureArgumentConformance(definition, args) {
  const schema = definition?.parameters;
  if (!schema || typeof schema !== 'object' || typeOf(args) !== 'object') return null;
  const collector = createCollector();
  measureObject(schema, args, '', collector);
  return collector.result();
}

module.exports = {
  measureArgumentConformance,
  MAX_PATHS_PER_KIND,
};
