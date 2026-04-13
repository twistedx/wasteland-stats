using Discord;
using Discord.WebSocket;
using ImpulseGaming.ArmaOfficer.Services;
using Microsoft.Extensions.DependencyInjection;

namespace ImpulseGaming.ArmaOfficer.Features;

/* The purpose of this class is to auto-ban accounts from the Discord server which are younger than 30 days. */

public class AutoBanNewUsers(IServiceProvider services)
{
    private readonly LoggingService _loggingService = services.GetRequiredService<LoggingService>();
    private readonly DiscordSocketClient _client = services.GetRequiredService<DiscordSocketClient>();

    public void Initialize()
    {
        _client.UserJoined += AutoBanNewUsersAsync;
        Console.WriteLine("Module 'AutoBanNewUsers' initialised.");
    }
    
    private async Task AutoBanNewUsersAsync(SocketGuildUser arg)
    {
        if ((DateTimeOffset.Now - arg.CreatedAt).TotalDays < 30)
        {
            try
            {
                await arg.BanAsync(0, "Auto-Ban");
                await _loggingService.SendToLogChannel(
                    $"Newly joined user {arg.Mention} was auto-banned because the account was younger than 30 days.");
            }
            catch (Exception ex)
            {
                await _loggingService.SendToLogChannel(
                    $":x: An error occured when trying to auto-ban {arg.Mention}. Please check the logs.");
                Console.WriteLine($"Error auto-banning {arg.Username}: {ex.Message}");
            }
        }
    }
}