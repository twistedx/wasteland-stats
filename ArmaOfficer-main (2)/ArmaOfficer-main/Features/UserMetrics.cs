using System.Timers;
using Discord.WebSocket;
using Task = System.Threading.Tasks.Task;

namespace ImpulseGaming.ArmaOfficer.Features;

public class UserMetrics
{
    private readonly DiscordSocketClient _client;
    private readonly ApplicationSettings _appSettings;
    private readonly List<VoiceTracker> _voiceTrackers = [];
    private bool _isInitialized;

    public UserMetrics(DiscordSocketClient client, ApplicationSettings appSettings)
    {
        _appSettings = appSettings;
        _client = client;
        client.MessageReceived += MessageReceived;
        client.UserVoiceStateUpdated += VoiceStateUpdated;
    }

    public void Initialize()
    {
        // If the tracker was initialized already, don't do it again.
        if (_isInitialized) return;

        List<SocketGuild> guilds = _client.Guilds.ToList();

        foreach (var g in guilds)
        foreach (var vCh in g.VoiceChannels)
        {
            if (g.AFKChannel != null && g.AFKChannel.Id == vCh.Id)
                continue;

            foreach (var u in vCh.ConnectedUsers)
            {
                // Lookup if there is already a tracker matching this user and guild.
                var index = _voiceTrackers.FindIndex(tracker =>
                    tracker.GuildId == g.Id && tracker.UserId == u.Id);

                // Not added yet, so let's add it.
                if (index != -1) continue;
                _voiceTrackers.Add(new VoiceTracker { GuildId = g.Id, Joined = DateTime.UtcNow, UserId = u.Id });
            }
        }

        _isInitialized = true;
        Console.WriteLine("Module 'UserMetrics' initialized.");
    }

    [Obsolete("This might be removed in future, since data is saved now on SIGINT.")]
    private async void TimerOnElapsed(object? sender, ElapsedEventArgs e)
    {
        // Return if we don't track anyone.
        if (_voiceTrackers.Count == 0) return;

        Console.WriteLine($"Saving voice activity for {_voiceTrackers.Count} trackers...");
        await SaveVoiceMinutes();
    }

    private async Task VoiceStateUpdated(SocketUser socketUser, SocketVoiceState oldSocketVoiceState,
        SocketVoiceState newSocketVoiceState)
    {
        var newStateIsAfkChannel = newSocketVoiceState.VoiceChannel?.Guild.AFKChannel != null &&
                                   newSocketVoiceState.VoiceChannel.Guild.AFKChannel.Id ==
                                   newSocketVoiceState.VoiceChannel.Id;

        var oldStateIsAfkChannel = oldSocketVoiceState.VoiceChannel?.Guild.AFKChannel is not null &&
                                   oldSocketVoiceState.VoiceChannel.Guild.AFKChannel.Id ==
                                   oldSocketVoiceState.VoiceChannel.Id;

        // Joined voice channel or came back from AFK channel
        if ((oldSocketVoiceState.VoiceChannel is null && newSocketVoiceState.VoiceChannel is not null)
            || (oldStateIsAfkChannel && newSocketVoiceState.VoiceChannel is not null))
        {
            // Lookup if there is already a tracker matching this user and guild.
            var index = _voiceTrackers.FindIndex(tracker =>
                tracker.GuildId == newSocketVoiceState.VoiceChannel.Guild.Id && tracker.UserId == socketUser.Id);

            if (index > -1)
            {
                _voiceTrackers[index].Joined = DateTime.UtcNow;
                return;
            }


            var tracker = new VoiceTracker
            {
                Joined = DateTime.UtcNow,
                GuildId = newSocketVoiceState.VoiceChannel.Guild.Id,
                UserId = socketUser.Id
            };
            _voiceTrackers.Add(tracker);
        }

        // Left voice channels or moved to AFK channel
        if ((oldSocketVoiceState.VoiceChannel is not null && newSocketVoiceState.VoiceChannel is null) ||
            newStateIsAfkChannel)
        {
            var guildId = oldSocketVoiceState.VoiceChannel is null
                ? newSocketVoiceState.VoiceChannel!.Guild
                    .Id // possible null exception ignored, because newStateIsAfkChannel
                // indicates that the new state is set.
                : oldSocketVoiceState.VoiceChannel.Guild.Id;


            // Lookup if there is already a tracker matching this user and guild.
            var index = _voiceTrackers.FindIndex(tracker =>
                tracker.GuildId == guildId && tracker.UserId == socketUser.Id);

            // If there wasn't a tracker, just return here
            if (index == -1)
                return;

            // Set the DateTime when the user left the voice channels
            _voiceTrackers[index].Left = DateTime.UtcNow;

            // calculate the time span between joining and leaving
            var span = _voiceTrackers[index].Left - _voiceTrackers[index].Joined;

            // Remove the tracker
            _voiceTrackers.RemoveAt(index);

            // Write to DB
            try
            {
                // TODO: Web API function to store data.
            }
            catch (Exception e)
            {
                Console.WriteLine("UserMetrics: Couldn't write user metrics to the DB.\n" + e);
            }
        }
    }

    public async Task SaveVoiceMinutes()
    {
        // Return if we don't track anyone.
        if (!_isInitialized || _voiceTrackers.Count == 0) return;

        foreach (var t in _voiceTrackers)
        {
            // Calculate the span
            var span = DateTime.UtcNow - t.Joined;

            // Skip if there is nothing to save.
            if (span.TotalMinutes < 1) continue;

            try
            {
                // TODO: Web API function to store data.
            }
            catch (Exception e)
            {
                Console.WriteLine("UserMetrics: Couldn't write user metrics to the DB.\n" + e);
            }

            // Reset the "Joined" date
            t.Joined = DateTime.UtcNow;
        }
    }

    private async Task MessageReceived(SocketMessage arg)
    {
        if (arg.Channel is not SocketGuildChannel) return;
        
        var user = arg.Author;

        try
        {
            // TODO: Web API function to store data.
        }
        catch (Exception e)
        {
            Console.WriteLine("UserMetrics: Couldn't write user metrics to the DB.\n" + e);
        }
    }

    private class VoiceTracker
    {
        public ulong GuildId;
        public DateTime Joined;
        public DateTime Left;
        public ulong UserId;
    }
}