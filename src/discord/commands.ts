import {
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

export function buildDiscordApplicationCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Show or change Exy's default model")
      .addStringOption((option) =>
        option
          .setName("model")
          .setDescription("Model exposed by Pi for the configured main provider")
          .setRequired(false)
          .setAutocomplete(true)
          .setMaxLength(100),
      ),
    new SlashCommandBuilder()
      .setName("reasoning")
      .setDescription("Show or change Exy's default reasoning level")
      .addStringOption((option) =>
        option
          .setName("level")
          .setDescription("A level supported by the selected model")
          .setRequired(false)
          .setAutocomplete(true)
          .setMaxLength(100),
      ),
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("Restart the Exy gateway"),
    new SlashCommandBuilder()
      .setName("interrupt")
      .setDescription("Interrupt the active agent run in this Exy thread"),
  ].map((command) => command.toJSON());
}
