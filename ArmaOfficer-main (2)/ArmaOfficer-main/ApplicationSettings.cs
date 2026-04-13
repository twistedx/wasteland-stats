using Microsoft.Extensions.Configuration;

namespace ImpulseGaming.ArmaOfficer;

public class ApplicationSettings(
    string discordToken,
    RconEndpoint[] rconEndpoints,
    ulong? logChannelId,
    WebApiConfiguration apiConfig,
    string[] modules,
    ServerTagLimiter? serverTagLimiter)
{
    private string? _discordToken = discordToken;
    public ulong? LogChannelId { get; } = logChannelId;
    public RconEndpoint[] RconEndpoints { get; } = rconEndpoints;
    public WebApiConfiguration WebApiConfiguration { get; } = apiConfig;
    public string[] Modules { get; } = modules;
    public ServerTagLimiter? ServerTagLimiter { get; } = serverTagLimiter;

    /// <summary>
    ///     Returns the Discord token and nullifies the variable so the token won't remain in the memory.
    /// </summary>
    /// <returns>Discord token used to log in the bot or null if it was consumed already.</returns>
    public string? ConsumeDiscordToken()
    {
        var retVal = _discordToken;
        _discordToken = null;
        return retVal;
    }

    public static ApplicationSettings LoadFromFile(string filename)
    {
        var configurationBuilder = new ConfigurationBuilder();
        configurationBuilder.AddJsonFile(filename);
        var conf = configurationBuilder.Build();

        // Read the Discord token (if any)
        var discordToken = conf["DiscordToken"];
        if (string.IsNullOrWhiteSpace(discordToken))
            throw new Exception("ERROR: Configuration 'DiscordToken' not provided but it's mandatory.");

        // Read the log channel ID and convert to ulong if possible.
        var _logchannelId = conf["LogChannelID"];
        ulong? _logChannelId = null;
        if (ulong.TryParse(_logchannelId, out var chId))
            _logChannelId = chId;

        // Get the subsection of "RCON"
        var rconConfigs = conf.GetSection("RCON").GetChildren();
        List<RconEndpoint> rconEndpoints = [];
        rconEndpoints.AddRange(from r in rconConfigs
            let rconAddress = r["Address"]
            let rconPort = int.Parse(r["Port"]!)
            let rconUser = r["User"]
            let rconPass = r["Pass"]
            let rconName = r["Name"]
            select new RconEndpoint(rconAddress, rconPort, rconPass, rconName));

        // Read the subsection of "WebAPI"
        var webApiConfig = conf.GetSection("WebAPI");
        if (string.IsNullOrWhiteSpace(webApiConfig["BaseURL"]))
            throw new Exception("ERROR: Web API 'BaseURL' not provided but it's mandatory.");
        if (string.IsNullOrWhiteSpace(webApiConfig["ApiToken"]))
            throw new Exception("ERROR: Web API 'ApiToken' not provided but it's mandatory.");

        var api = new WebApiConfiguration(webApiConfig["BaseURL"]!, webApiConfig["ApiToken"]!);
        var modules = conf.GetSection("Modules").Get<string[]>() ?? [];
        
        var serverTagLimiter = conf.GetSection("ServerTagLimiter").Get<ServerTagLimiter>() ?? null;
        
        return new ApplicationSettings(discordToken, rconEndpoints.ToArray(), _logChannelId, api, modules, serverTagLimiter);
    }
}

public class WebApiConfiguration(string baseUrl, string apiToken)
{
    public string BaseUrl { get; } = baseUrl;
    public string ApiToken { get; } = apiToken;
}

/// <summary>
///  The ServerTagLimiter class is used to limit certain features of the bot to users who publicity wear the IWPG
/// server tag or are a donator.
/// </summary>
public class ServerTagLimiter(bool enabled, string? badgeHash, ulong donatorRoleId)
{
    public bool Enabled { get; } = enabled;
    public string? BadgeHash { get; } = badgeHash;
    public ulong? DonatorRoleID { get; } = donatorRoleId;
}