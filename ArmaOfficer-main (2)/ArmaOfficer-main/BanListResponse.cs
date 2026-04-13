using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer;

public class BanListResponse(string status, BanList[] bans)
{
    [JsonProperty("status")] public string Status { get; } = status;
    [JsonProperty("data")] public BanList[] Bans { get; } = bans;
}

public class BanList(
    int id,
    string userIdBanned,
    string adminName,
    string reason,
    int durationHours,
    DateTimeOffset timeStamp,
    string bannedArmaUsername,
    string? bannedDiscordUsername)
{
    [JsonProperty("id")] public int Id { get; } = id;
    [JsonProperty("user_id_banned")] public string UserIdBanned { get; } = userIdBanned;
    [JsonProperty("admin_name")] public string AdminName { get; } = adminName;
    [JsonProperty("reason")] public string Reason { get; } = reason;
    [JsonProperty("duration_hours")] public int DurationHours { get; } = durationHours;
    [JsonProperty("time_stamp")] public DateTimeOffset TimeStamp { get; } = timeStamp;
    [JsonProperty("banned_arma_username")] public string BannedArmaUsername { get; } = bannedArmaUsername;
    [JsonProperty("banned_discord_name")] public string? BannedDiscordUsername { get; } = bannedDiscordUsername;
}