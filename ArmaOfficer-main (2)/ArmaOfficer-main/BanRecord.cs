using System.Text.RegularExpressions;

namespace ImpulseGaming.ArmaOfficer;

public class BanRecord(string identityId, string name, string serverName)
{
    public string IdentityId { get; } = identityId;
    public string Name { get; } = name;
    public string Server { get; } = serverName;

    public static bool TryParse(string line, string serverName, out BanRecord result)
    {
        var regexResult = new Regex(@"^-\s+(\S+)\s+\|\s+(.+)$").Match(line);
        if (!regexResult.Success)
        {
            result = null!;
            return false;
        }

        var identityId = regexResult.Groups[1].ToString();
        var playerName = regexResult.Groups[2].ToString();
        result = new BanRecord(identityId, playerName, serverName);
        return true;
    }

    public static bool TryParse(string inputBlock, string serverName, out BanRecord[] result)
    {
        var split = inputBlock.Split("\n", StringSplitOptions.RemoveEmptyEntries);
        List<BanRecord> records = [];

        foreach (var line in split)
            if (TryParse(line, serverName, out BanRecord outVal))
                records.Add(outVal);

        if (records.Count == 0)
        {
            result = [];
            return false;
        }

        result = records.ToArray();
        return true;
    }
}