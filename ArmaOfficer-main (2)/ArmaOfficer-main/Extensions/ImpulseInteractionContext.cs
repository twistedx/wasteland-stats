using Discord.Interactions;
using Discord.WebSocket;

namespace ImpulseGaming.ArmaOfficer.Extensions;

/// <summary>
///     Custom implementation of an InteractionContext which embeds the ServiceProvider.
/// </summary>
/// <param name="client">The Discord Socket Client used for the Discord connection</param>
/// <param name="interaction">The interaction the user performed</param>
/// <param name="services">The ServiceProvider</param>
public class ImpulseInteractionContext(
    DiscordSocketClient client,
    SocketInteraction interaction,
    IServiceProvider services) : SocketInteractionContext(client, interaction)
{
    public IServiceProvider Services => services;
}