export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function serializeJson(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
  return serialized;
}

export function parseJson<T extends JsonValue = JsonValue>(value: string): T {
  return JSON.parse(value) as T;
}
