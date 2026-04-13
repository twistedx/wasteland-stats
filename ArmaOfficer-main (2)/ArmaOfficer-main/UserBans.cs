using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer;

public class UserBanCollection(string message, UserBan[] bans)
{
    [JsonProperty("bans")] public UserBan[] Bans { get; set; } = bans;
    [JsonProperty("message")] public string ApiResponseMessage { get; set; } = message;
}

public class UserBan(string armaName,int id,string armaId,string adminName,string reason,int hours,DateTimeOffset timeStamp,string banOwner)
{
    /// <summary>
    /// Ingame name of the player
    /// </summary>
    [JsonProperty("user_arma_name")] public string ArmaName { get; set; } = armaName;
    
    /// <summary>
    /// Ban ID
    /// </summary>
    [JsonProperty("id")] public int Id { get; set; } = id;
    
    /// <summary>
    /// Ingame ID of the banned player
    /// </summary>
    [JsonProperty("user_id_banned")] public string ArmaId { get; set; } = armaId;
    
    /// <summary>
    /// Name of the admin who banned the user
    /// </summary>
    [JsonProperty("admin_name")] public string BannedBy { get; set; } = adminName;
    
    /// <summary>
    /// Reason why the user was banned
    /// </summary>
    [JsonProperty("reason")] public string Reason { get; set; } = reason;
    
    /// <summary>
    /// Timestamp when the user was banned
    /// </summary>
    [JsonProperty("time_stamp")] public DateTimeOffset Timestamp { get; set; } = timeStamp;
    
    /// <summary>
    /// No clue what that is...
    /// </summary>
    [JsonProperty("ban_owner")] public string BanOwner { get; set; } = banOwner;
    
    /// <summary>
    /// Ban duration in hours
    /// </summary>
    [JsonProperty("duration_hours")] public int Duration { get; set; } = hours;
}