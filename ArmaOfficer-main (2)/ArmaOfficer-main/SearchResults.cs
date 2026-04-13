using System.Text.Json.Serialization;
using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer;

public class SearchResult(IEnumerable<SearchResultMember> users, bool hasNextPage, string message)
{
    [JsonProperty("users")] public SearchResultMember[] Members { get; } = users.ToArray();
    [JsonProperty("hasNextPage")] public bool HasNextPage { get; } = hasNextPage;
    [JsonProperty("message")] public string Message { get; } = message;
}

public class SearchResultMember(string armaId, string armaUsername)
{
    [JsonProperty("arma_id")] public string ArmaId { get; } = armaId;
    [JsonProperty("arma_username")] public string ArmaUsername { get; } = armaUsername;
}