using System.Reflection;
using Discord;
using Discord.Interactions;
using Discord.WebSocket;
using ImpulseGaming.ArmaOfficer.Extensions;

namespace ImpulseGaming.ArmaOfficer.Services;

public class InteractionHandler(
    DiscordSocketClient client,
    InteractionService interactions,
    IServiceProvider services,
    ApplicationSettings appSettings)
{
    private readonly ApplicationSettings _appSettings = appSettings;

    public async Task InitializeAsync()
    {
        await interactions.AddModulesAsync(Assembly.GetEntryAssembly(), services);
        client.InteractionCreated += OnInteractionCreated;
        interactions.SlashCommandExecuted += OnSlashCommandExecuted;
    }

    private async Task OnSlashCommandExecuted(SlashCommandInfo commandInfo, IInteractionContext context, IResult result)
    {
        if (result.IsSuccess)
            return;

        switch (result.Error)
        {
            //TODO: Add error logging
        }
    }

    private async Task OnInteractionCreated(SocketInteraction interaction)
    {
        // Here we are logging the interactions to the console window.
        // SlashCommands can have sub commands and even those can have sub commands. Therefore we need to check if a
        // SlashCommand has a subcommand, then add the subcommands name to the final string and check it's subcommand,
        // too. This results in a SlashCommand string like '/command sub1 sub2'.
        var isDmInteraction = !interaction.GuildId.HasValue;
        switch (interaction.Type)
        {
            case InteractionType.ApplicationCommand:
            {
                // If the application command is from type SocketUserCommand (User Command context)
                if (interaction is SocketUserCommand usrCommand)
                {
                    Console.WriteLine($"{usrCommand.User.Username} executed UserCommand: '{usrCommand.CommandName}' on {usrCommand.Data.Member.Username}");
                    break;
                }
                // Else it's probably a SlashCommand   
                
                var appCommand = (ISlashCommandInteraction)interaction;
                var commandName = appCommand.Data.Name;
                if (appCommand.Data.Options.Count > 0)
                {
                    commandName += " " + appCommand.Data.Options.First().Name;
                    if (appCommand.Data.Options.First().Options.Count > 0)
                        commandName += " " + appCommand.Data.Options.First().Options.First().Name;
                }

                Console.WriteLine(
                    $"{appCommand.User.Username} executed SlashCommand: '/{commandName}' in channel: \"{(isDmInteraction ? "Direct Message" : client.GetGuild(interaction.GuildId!.Value).Name)}/#{interaction.Channel.Name}\"");
                break;
            }
            case InteractionType.MessageComponent:
            {
                var appCommand = (IComponentInteraction)interaction;
                Console.WriteLine(
                    $"{appCommand.User.Username} executed ComponentInteraction: '{appCommand.Data.CustomId}' in channel: \"{(isDmInteraction ? "Direct Message" : client.GetGuild(interaction.GuildId!.Value).Name)}/#{interaction.Channel.Name}\"");
                break;
            }
            case InteractionType.Ping:
                break;
            case InteractionType.ApplicationCommandAutocomplete:
                break;
            case InteractionType.ModalSubmit:
                break;
            default:
                break;
                //throw new ArgumentOutOfRangeException();
        }

        // Build the interaction context
        var ctx = new ImpulseInteractionContext(client, interaction, services);

        // Execute the command
        await interactions.ExecuteCommandAsync(ctx, services);
    }
}