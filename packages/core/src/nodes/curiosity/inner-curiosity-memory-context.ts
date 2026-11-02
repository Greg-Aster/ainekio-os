/** Preserve selected record evidence without index implementation details. */
export function innerCuriosityMemoryContext(value: unknown, label: string): string {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return JSON.stringify(value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label} item ${index + 1} must be an object`);
    }
    const record = item as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : record.text;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`${label} item ${index + 1} must not be empty`);
    }
    const type = typeof record.memoryType === 'string' ? record.memoryType : record.type;
    return {
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      ...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
      ...(typeof type === 'string' ? { type } : {}),
      ...(typeof record.role === 'string' ? { role: record.role } : {}),
      ...(typeof record.source === 'string' ? { source: record.source } : {}),
      ...(typeof record.cognitiveMode === 'string' ? { cognitiveMode: record.cognitiveMode } : {}),
      content,
    };
  }));
}
