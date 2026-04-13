using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer;

public class SkinItems
{
    [JsonProperty("items")]
    public List<string> Items { get; } = [];
}