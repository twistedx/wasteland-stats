using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer;

/// <summary>
/// Deserialized class for the API endpoint getPlayerStatsByID
/// </summary>
public class PlayerStats
{
    public PlayerStats(string username, string killCount, string mostKilled, string mostKilledCount,
        string mostKilledBy, string mostKilledByCount)
    {
        Username = username;
        KillCount = killCount;
        MostKilled = mostKilled;
        MostKilledCount = mostKilledCount;
        MostKilledBy = mostKilledBy;
        MostKilledByCount = mostKilledByCount;
    }

    [JsonProperty("arma_username")] public string Username { get; }
    [JsonProperty("kill_count")] public string KillCount { get; }
    [JsonProperty("mostKilled")] public string MostKilled { get; }
    [JsonProperty("mostKilledCount")] public string MostKilledCount { get; }
    [JsonProperty("mostKilledBy")] public string MostKilledBy { get; }
    [JsonProperty("mostKilledByCount")] public string MostKilledByCount { get; }

    public static PlayerStats? Parse(string jsonData)
    {
        return JsonConvert.DeserializeObject<PlayerStats>(jsonData);
    }
}

public class PlayerExtendedStats
{
    public PlayerExtendedStats(string armaId, string distanceWalked, string aiKills, string shotsFired,
        string grenadesThrown, string distanceDriven, string playerDiedInVehicle, string roadKills, string aiRoadKills,
        string distanceAsOccupant, string bandageSelf, string bandageFriendlies, string tourniquetSelf,
        string tourniquetFriendlies, string salineSelf, string salineFriendlies, string morphineSelf,
        string morphineFriendlies)
    {
        ArmaId = armaId;
        DistanceWalked = distanceWalked;
        AiKills = aiKills;
        ShotsFired = shotsFired;
        GrenadesThrown = grenadesThrown;
        DistanceDriven = distanceDriven;
        PlayerDiedInVehicle = playerDiedInVehicle;
        RoadKills = roadKills;
        AiRoadKills = aiRoadKills;
        DistanceAsOccupant = distanceAsOccupant;
        BandageSelf = bandageSelf;
        BandageFriendlies = bandageFriendlies;
        TourniquetSelf = tourniquetSelf;
        TourniquetFriendlies = tourniquetFriendlies;
        SalineSelf = salineSelf;
        SalineFriendlies = salineFriendlies;
        MorphineSelf = morphineSelf;
        MorphineFriendlies = morphineFriendlies;
    }

    [JsonProperty("arma_id")] public string ArmaId { get; }
    [JsonProperty("distance_walked")] public string DistanceWalked { get; }
    [JsonProperty("ai_kills")] public string AiKills { get; }
    [JsonProperty("shots_fired")] public string ShotsFired { get; }
    [JsonProperty("grenades_thrown")] public string GrenadesThrown { get; }
    [JsonProperty("distance_driven")] public string DistanceDriven { get; }

    [JsonProperty("players_died_in_vehicle")]
    public string PlayerDiedInVehicle { get; }

    [JsonProperty("roadkills")] public string RoadKills { get; }
    [JsonProperty("ai_roadkills")] public string AiRoadKills { get; }
    [JsonProperty("distance_as_occupant")] public string DistanceAsOccupant { get; }
    [JsonProperty("bandage_self")] public string BandageSelf { get; }
    [JsonProperty("bandage_friendlies")] public string BandageFriendlies { get; }
    [JsonProperty("tourniquet_self")] public string TourniquetSelf { get; }

    [JsonProperty("tourniquet_friendlies")]
    public string TourniquetFriendlies { get; }

    [JsonProperty("saline_self")] public string SalineSelf { get; }
    [JsonProperty("saline_friendlies")] public string SalineFriendlies { get; }
    [JsonProperty("morphine_self")] public string MorphineSelf { get; }
    [JsonProperty("morphine_friendlies")] public string MorphineFriendlies { get; }

    public static PlayerExtendedStats? Parse(string jsonData)
    {
        return JsonConvert.DeserializeObject<PlayerExtendedStats>(jsonData);
    }
}

/// <summary>
/// Deserialized class for the API endpoint getPlayerStatsByDiscordID
/// </summary>
/// <param name="armaName"></param>
/// <param name="killCount"></param>
/// <param name="mostKilled"></param>
/// <param name="mostKilledCount"></param>
/// <param name="mostKilledby"></param>
/// <param name="mostKilledByCount"></param>
/// <param name="deaths"></param>
/// <param name="killDeathRatio"></param>
public class PlayerStats2(
    string armaName,
    string killCount,
    string mostKilled,
    string mostKilledCount,
    string mostKilledby,
    string mostKilledByCount,
    string deaths,
    string killDeathRatio,
    string distanceWalked,
    string aiKills,
    string shotsFired,
    string grenadesThrown,
    string distanceDriven,
    string playersDiedInVehicle,
    string roadkills,
    string aiRoadkills,
    string distanceAsOccupant,
    string bandageSelf,
    string bandageFriendlies,
    string tourniquetSelf,
    string tourniquetFriendlies,
    string salineSelf,
    string salineFriendlies,
    string morphineSelf,
    string morphineFriendlies)
{
    [JsonProperty("arma_username")] public string ArmaName { get; set; } = armaName;
    
    [JsonProperty("distance_walked")] public string DistanceWalked { get; set; } = distanceWalked;
    
    [JsonProperty("ai_kills")] public string AiKills { get; set; } = aiKills;
    [JsonProperty("shots_fired")] public string ShotsFired { get; set; } = shotsFired;
    [JsonProperty("grenades_thrown")] public string GrenadesThrown { get; set; } = grenadesThrown;
    [JsonProperty("distance_driven")] public string DistanceDriven { get; set; } = distanceDriven;
    [JsonProperty("players_died_in_vehicle")] public string PlayersDiedInVehicle { get; set; } = playersDiedInVehicle;
    [JsonProperty("roadkills")] public string Roadkills { get; set; } = roadkills;
    [JsonProperty("ai_roadkills")] public string AiRoadkills { get; set; } = aiRoadkills;
    [JsonProperty("distance_as_occupant")] public string DistanceAsOccupant { get; set; } = distanceAsOccupant;
    [JsonProperty("bandage_self")] public string BandageSelf { get; set; } = bandageSelf;
    [JsonProperty("bandage_friendlies")] public string BandageFriendlies { get; set; } = bandageFriendlies;
    [JsonProperty("tourniquet_self")] public string TourniquetSelf { get; set; } = tourniquetSelf;
    [JsonProperty("tourniquet_friendlies")] public string TourniquetFriendlies { get; set; } = tourniquetFriendlies;
    [JsonProperty("saline_self")] public string SalineSelf { get; set; } = salineSelf;
    [JsonProperty("saline_friendlies")] public string SalineFriendlies { get; set; } = salineFriendlies;
    [JsonProperty("morphine_self")] public string MorphineSelf { get; set; } = morphineSelf;
    [JsonProperty("morphine_friendlies")] public string MorphineFriendlies { get; set; } = morphineFriendlies;
    [JsonProperty("kill_count")] public string KillCount { get; set; } = killCount;
    [JsonProperty("mostKilled")] public string MostKilled { get; set; } = mostKilled;
    [JsonProperty("mostKilledCount")] public string MostKilledCount { get; set; } = mostKilledCount;
    [JsonProperty("mostKilledBy")]  public string MostKilledby { get; set; } = mostKilledby;
    [JsonProperty("mostKilledByCount")] public string MostKilledByCount { get; set; } = mostKilledByCount;
    [JsonProperty("deaths")] public string Deaths { get; set; } = deaths;
    [JsonProperty("kdRatio")] public string KillDeathRatio { get; set; } = killDeathRatio;
}