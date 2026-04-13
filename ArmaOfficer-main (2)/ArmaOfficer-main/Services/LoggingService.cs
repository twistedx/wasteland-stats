using Discord;
using Discord.WebSocket;

namespace ImpulseGaming.ArmaOfficer.Services;

public class LoggingService(DiscordSocketClient client)
{
    public ulong? LogChannelId { get; private set; }

    public void InitializeAsync(ulong? discordLogChannelId)
    {
        if (!discordLogChannelId.HasValue) return;
        LogChannelId = discordLogChannelId;
        Console.WriteLine($"Log channel ID set to: {LogChannelId}");
    }

    public async Task SendToLogChannel(string? message = null, Embed? embed = null)
    {
        if (!LogChannelId.HasValue)
            return;

        if (await client.GetChannelAsync(LogChannelId.Value) is not SocketTextChannel channel)
            return;


        var perms = channel.GetUser(client.CurrentUser.Id).GetPermissions(channel);

        if (perms.Has(ChannelPermission.ViewChannel)
            && perms.Has(ChannelPermission.SendMessages)
            && perms.Has(ChannelPermission.EmbedLinks))
            await channel.SendMessageAsync(message, embed: embed);
        else
            Console.WriteLine("Failed to send message to the log channel. Missing permissions.");
    }
}