import type { ModelPreference, Scope } from "../core/types.js";
import type { ExyDatabase } from "./database.js";
import type { JsonValue } from "./json.js";
import { parseJson, serializeJson } from "./json.js";

export class KeyValueRepository {
  constructor(
    private readonly database: ExyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  set(key: string, value: JsonValue): void {
    assertKey(key);
    this.database.connection
      .prepare(`
        INSERT INTO key_value(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `)
      .run(key, serializeJson(value), this.now());
  }

  get<T extends JsonValue = JsonValue>(key: string): T | undefined {
    assertKey(key);
    const row = this.database.connection
      .prepare("SELECT value_json FROM key_value WHERE key = ?")
      .get(key) as { value_json: string } | undefined;
    return row === undefined ? undefined : parseJson<T>(row.value_json);
  }

  delete(key: string): boolean {
    assertKey(key);
    const result = this.database.connection.prepare("DELETE FROM key_value WHERE key = ?").run(key);
    return Number(result.changes) === 1;
  }
}

export class ModelPreferenceRepository {
  constructor(
    private readonly database: ExyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  set(scope: Scope, preference: ModelPreference): void {
    assertScope(scope);
    for (const [label, value] of [
      ["provider", preference.provider],
      ["model ID", preference.modelId],
      ["reasoning level", preference.reasoning],
    ] as const) {
      if (value.trim() === "") throw new TypeError(`${label} must not be empty`);
    }

    this.database.connection
      .prepare(`
        INSERT INTO model_preferences(
          discord_user_id, x_account_id, provider, model_id, reasoning, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(discord_user_id, x_account_id) DO UPDATE SET
          provider = excluded.provider,
          model_id = excluded.model_id,
          reasoning = excluded.reasoning,
          updated_at = excluded.updated_at
      `)
      .run(
        scope.discordUserId,
        scope.xAccountId,
        preference.provider,
        preference.modelId,
        preference.reasoning,
        this.now(),
      );
  }

  get(scope: Scope): ModelPreference | undefined {
    assertScope(scope);
    const row = this.database.connection
      .prepare(`
        SELECT provider, model_id, reasoning
        FROM model_preferences
        WHERE discord_user_id = ? AND x_account_id = ?
      `)
      .get(scope.discordUserId, scope.xAccountId) as
      | { provider: string; model_id: string; reasoning: ModelPreference["reasoning"] }
      | undefined;

    return row === undefined
      ? undefined
      : { provider: row.provider, modelId: row.model_id, reasoning: row.reasoning };
  }
}

export function assertScope(scope: Scope): void {
  if (scope.discordUserId.trim() === "") throw new TypeError("Discord user ID must not be empty");
  if (scope.xAccountId.trim() === "") throw new TypeError("X account ID must not be empty");
}

function assertKey(key: string): void {
  if (key.trim() === "") throw new TypeError("Key must not be empty");
  if (key.length > 200) throw new TypeError("Key must be at most 200 characters");
}
