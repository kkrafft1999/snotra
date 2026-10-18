// Type-checking aid only (#1004); nothing here reaches the app.
//
// The enums are frozen literal objects, so `Object.values(TOOL_PERMISSION_MODES)`
// is an array of literal types, and the standard library only lets
// `.includes()` take an element of that type. The code uses `.includes()` the
// other way round, to ask whether an unchecked value *is* one of them — the
// question a sanitizer exists to answer. Widening the argument keeps that
// idiom without casts at every call site; the element type stays as it is.

interface Array<T> {
  includes(searchElement: unknown, fromIndex?: number): boolean;
}

interface ReadonlyArray<T> {
  includes(searchElement: unknown, fromIndex?: number): boolean;
}
