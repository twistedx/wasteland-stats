using System.Diagnostics;
using BERConLib.BeRconClient;
using BERConLib.BeRconPacket;

namespace ImpulseGaming.ArmaOfficer;

public class RconEndpoint
{
    private string Address { get; }
    private int Port { get; }
    private string Password { get; }
    public string Name => _name ?? $"{Address}:{Port}";

    private BeRconClient _client;
    private readonly string? _name;
    private const int InterPacketDelayMs = 1000;

    private Player[] _cachedPlayers = [];

    public RconEndpoint(string address, int port, string password, string? name = null)
    {
        _name = name;
        Address = address;
        Port = port;
        Password = password;
        _client = new BeRconClient(address, port);

        _client.OnServerMessageReceived += ServerMessageReceived;
        _client.OnReauthenticationRequired += ReauthenticationRequired;
    }

    private async void ReauthenticationRequired()
    {
        Console.WriteLine($"[{_name}] BERConLib notified us that we hit the max. sequence number for RCON commands. Disposing and reauthenticating the RCON client...");
        Recreate();
        var authenticated = await _client.AuthenticateAsync(Password);
        Console.WriteLine($"[{_name}] Reauthentication {(authenticated ? "successful!" : "failed!")}");
    }

    public bool IsConnected()
    {
        return _client.IsConnected;
    }

    /// <summary>
    /// Authenticates to the RCON server or returns simply true, if the client is already authenticated.
    /// </summary>
    /// <returns></returns>
    public async Task<bool> AuthenticateAsync()
    {
        if (IsConnected())
            return true;

        return await _client.AuthenticateAsync(Password);
    }

    public async Task<Player[]> GetPlayersAsync()
    {
        if (!IsConnected())
            throw new Exception("Not authenticated to the RCON host.");

        // We have to watch the Server Messages to get the player list
        var tcs = new TaskCompletionSource();
        using var cts = new CancellationTokenSource(10000); // Auto-cancel after 30 seconds
        var players = new List<Player>();
        var firstMessageReceived = false;

        void ServerMessageHandler(ServerMessagePacket packet)
        {
            // Filter for the player list
            
            // If the packet contains only the header with no additional text, there are no players.
            if (packet.Message == "Players on server: [Player#] ; [Player UID] ; [Player Name]")
            {
                firstMessageReceived = true;
                tcs.TrySetResult();
                return;
            }
            
            if (!Player.TryParse(packet.Message, out Player[] onlinePlayers)) return;
            firstMessageReceived = true;
            players.AddRange(onlinePlayers);
            
        }

        // Subscribe for the ServerMessage event
        _client.OnServerMessageReceived += ServerMessageHandler;

        try
        {
            var response = await _client.SendAsync("players");

            // The RCON host did not confirm our command. It's probably offline
            if (response is null) await cts.CancelAsync();

            await using (cts.Token.Register(() => tcs.TrySetCanceled(), false))
            {
                while (!cts.Token.IsCancellationRequested)
                {
                    // A delay task is used to wait some time for the server to send messages. This is used because
                    // the RCON server might send multiple messages, and we have to wait until no more messages are 
                    // arriving.
                    var delayTask = Task.Delay(InterPacketDelayMs, cts.Token);
                    var completedTask = await Task.WhenAny(delayTask, tcs.Task);
                    
                    // If the delay task completes first, break the loop (timeout)
                    if (completedTask == delayTask && firstMessageReceived)
                    {
                        Debug.WriteLine("InterPacketDelay timed out.");
                        break;
                    }

                    // At this point, we know tcs.Task completed
                    tcs = new TaskCompletionSource(); // Reset for the next packet
                    
                    // The delayTask now finished and we haven't received anymore player lists. This means the server
                    // isn't sending data anymore.
                }
            }

            _cachedPlayers = players.ToArray();
            return players.ToArray();
        }
        catch (TaskCanceledException)
        {
            Console.WriteLine("RCON command 'players' timed out: " + Name);
            return [];
        }
    }
    
    public async Task<string?> KickPlayer(string playerUid, bool refreshCache=true)
    {
        if (!IsConnected()) throw new Exception("Not authenticated to the RCON host.");
        if (refreshCache) await GetPlayersAsync();

        // Cancel if no player with the GUID has been found.
        if (_cachedPlayers.FirstOrDefault(p => string.Equals(p.Puid,playerUid, StringComparison.InvariantCultureIgnoreCase)) is not {} player)
            return "No player found with the given GUID";
        
        return await KickPlayer(player.PlayerNumber);
    }

    public async Task<string?> KickPlayer(int playerNumber)
    {
        if (!IsConnected())
            throw new Exception("Not authenticated to the RCON host.");

        
        // We have to watch the Server Messages to get the player list
        var tcs = new TaskCompletionSource();
        using var cts = new CancellationTokenSource(30000); // Auto-cancel after 30 seconds
        string? serverMessage = null;

        void ServerMessageHandler(ServerMessagePacket packet)
        {
            serverMessage = packet.Message;
            tcs.TrySetResult();
        }

        // Subscribe for the ServerMessage event
        _client.OnServerMessageReceived += ServerMessageHandler;

        try
        {
            var response = await _client.SendAsync($"kick {playerNumber}");

            // The RCON host did not confirm our command. It's probably offline
            if (response is null) await cts.CancelAsync();

            await using (cts.Token.Register(() => tcs.TrySetCanceled(), false))
            {
                while (!cts.Token.IsCancellationRequested)
                {
                    // A delay task is used to wait some time for the server to send messages. This is used because
                    // the RCON server might send multiple messages, and we have to wait until no more messages are 
                    // arriving.
                    var delayTask = Task.Delay(InterPacketDelayMs, cts.Token);
                    var completedTask = await Task.WhenAny(delayTask, tcs.Task);

                    // If the delay task completes first, break the loop (timeout)
                    if (completedTask == delayTask) break;

                    // At this point, we know tcs.Task completed
                    tcs = new TaskCompletionSource(); // Reset for the next packet
                }
            }

            return serverMessage;
        }
        catch (TaskCanceledException)
        {
            Console.WriteLine("RCON command 'players' timed out: " + Name);
            return null;
        }
        finally
        {
            _client.OnServerMessageReceived -= ServerMessageHandler;
        }
    }

    private void ServerMessageReceived(ServerMessagePacket packet)
    {
        Debug.WriteLine($"[RCON {Name}]: {packet.Message}");
    }

    /// <summary>
    /// Recreates the BeRconClient class of the BERconLib library.
    /// </summary>
    public void Recreate()
    {
        _client.OnServerMessageReceived -= ServerMessageReceived;
        _client.OnReauthenticationRequired -= ReauthenticationRequired;
        _client = new BeRconClient(Address, Port);
        _client.OnServerMessageReceived += ServerMessageReceived;
        _client.OnReauthenticationRequired += ReauthenticationRequired;
    }
}