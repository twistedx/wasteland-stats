namespace ImpulseGaming.ArmaOfficer;

public class Player(int playerNumber, string puid, string name)
{
    public int PlayerNumber { get; } = playerNumber;
    public string Name { get; } = name;
    public string Puid { get; } = puid;

    public static bool TryParse(string input, out Player? result)
    {
        //  PlayerNumber ; GUID ; Name
        // 41 ; 0f1d82eb-4d4b-4c67-8d9d-b39b9efc001f ; Tech

        var metadata = input.Split(';', StringSplitOptions.TrimEntries);

        // metadata array has the wrong length
        if (metadata.Length != 3)
        {
            result = null;
            return false;
        }

        // The first object isn't an integer
        if (!int.TryParse(metadata[0], out var playerNumber))
        {
            result = null;
            return false;
        }

        result = new Player(playerNumber, metadata[1], metadata[2]);
        return true;
    }

    public static bool TryParse(string inputBlock, out Player[] result)
    {
        // Split the inputBlock in lines and skip the first header line
        var metadata = inputBlock.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        List<Player> parsedPlayers = [];

        foreach (var line in metadata)
            if (TryParse(line, out Player? player) && player is not null)
                parsedPlayers.Add(player);

        if (parsedPlayers.Count == 0)
        {
            result = [];
            return false;
        }

        result = parsedPlayers.ToArray();
        return true;
    }
}