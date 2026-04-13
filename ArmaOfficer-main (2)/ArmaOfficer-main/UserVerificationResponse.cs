using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer;

public class UserVerificationResponse(string status, string armaUsername, string armaGuid, string discordId)
{
    [JsonProperty("status")] public string Status { get; set; } = status;
    [JsonProperty("arma_username")] public string ArmaUsername { get; set; } = armaUsername;
    [JsonProperty("arma_guid")] public string ArmaGuid { get; set; } = armaGuid;
    [JsonProperty("discord_id")] public string DiscordId { get; set; } = discordId;
}