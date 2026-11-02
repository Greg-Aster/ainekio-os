/**
 * Serialize model context without repeating identical text, JSON objects or arrays.
 * The first occurrence remains complete; later copies use a JSON Pointer $ref.
 * This changes only the wire representation, never the underlying evidence.
 */
export function serializeContext(value: unknown, deduplicateText = false): string {
  const json = JSON.stringify(value);
  const firstOccurrence = new Map<string, string>();
  function project(item: any, pointer: string): any {
    if (item === null || (typeof item !== 'object' && (!deduplicateText || typeof item !== 'string'))) return item;
    const contents = JSON.stringify(item);
    const previous = firstOccurrence.get(contents);
    if (previous !== undefined) {
      const reference = { $ref: previous };
      const referenceLength = JSON.stringify(reference).length;
      // Keep short identifiers and times literal; a text reference should save
      // at least its own representation overhead.
      if (referenceLength < contents.length
        && (typeof item !== 'string' || contents.length - referenceLength >= referenceLength)) return reference;
    } else {
      firstOccurrence.set(contents, pointer);
    }
    if (typeof item === 'string') return item;
    if (Array.isArray(item)) return item.map((child, index) => project(child, `${pointer}/${index}`));
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [
      key, project(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`),
    ]));
  }
  return JSON.stringify(project(JSON.parse(json), '#'));
}

/** Read the lossless context representation, including shared JSON Pointer values. */
export function parseContext(text: string): any {
  const root = JSON.parse(text);
  const expand = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (Object.keys(value).length === 1 && typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
      const target = value.$ref.slice(2).split('/').reduce((object: any, key: string) =>
        object[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
      return expand(target);
    }
    return Array.isArray(value) ? value.map(expand)
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
  };
  return expand(root);
}
