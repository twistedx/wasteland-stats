using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer;

public class ValidationResponse(string status, string armaUsername, string armaGuid, string discordId)
{
    [JsonProperty("status")] public string Status { get; } = status;
    [JsonProperty("arma_username")] public string ArmaUsername { get; } = armaUsername;
    [JsonProperty("arma_guid")] public string ArmaGuid { get; } = armaGuid;
    [JsonProperty("discord_id")] public string DiscordId { get; } = discordId;
}