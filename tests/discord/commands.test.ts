import { describe, expect, it } from "vitest";

import { buildDiscordApplicationCommands } from "../../src/discord/commands.js";

describe("buildDiscordApplicationCommands", () => {
  it("registers only the required compact command surface", () => {
    const commands = buildDiscordApplicationCommands();

    expect(commands.map((command) => command.name)).toEqual([
      "model",
      "reasoning",
      "restart",
      "interrupt",
    ]);
  });

  it("uses autocomplete rather than hard-coded model and reasoning choices", () => {
    const commands = buildDiscordApplicationCommands();
    const model = commands.find((command) => command.name === "model");
    const reasoning = commands.find((command) => command.name === "reasoning");

    expect(model?.options?.[0]).toMatchObject({
      name: "model",
      autocomplete: true,
      required: false,
    });
    expect(reasoning?.options?.[0]).toMatchObject({
      name: "level",
      autocomplete: true,
      required: false,
    });
    expect(model?.options?.[0]?.choices).toBeUndefined();
    expect(reasoning?.options?.[0]?.choices).toBeUndefined();
  });
});
