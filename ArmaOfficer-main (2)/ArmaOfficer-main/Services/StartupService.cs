using Discord;
using Discord.Interactions;
using Discord.WebSocket;

namespace ImpulseGaming.ArmaOfficer.Services;

public class StartupService(
    DiscordSocketClient discordClient,
    InteractionService interactions,
    ApplicationSettings appSettings,
    IServiceProvider services)
{
    public async Task StartAsync()
    {
        discordClient.Ready += OnClientReady;

        await discordClient.LoginAsync(TokenType.Bot, appSettings.ConsumeDiscordToken()); // Login to Discord
        await discordClient.StartAsync(); // Connect to websocket
    }

    private async Task OnClientReady()
    {
        // Loop through all available Discord guilds
        foreach (var guild in discordClient.Guilds)
        {
            // Download members from the guild
            //if (!guild.HasAllMembers)
            //    await guild.DownloadUsersAsync();

            // Register the application commands
            await interactions.RegisterCommandsToGuildAsync(guild.Id);

            // Logging
            Console.WriteLine($"Connected to guild: {guild.Name} ({guild.MemberCount} members)");
        }
    }
}