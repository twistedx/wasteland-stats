using System.Text;

namespace ImpulseGaming.ArmaOfficer;

public static class Program
{
    public static Task Main(string[] args)
    {
        // Check if the user forgot to pass arguments
        if (args.Length == 0)
            PrintUsage();

        // Variables and definitions
        string? configFilename = null;
        string? discordToken = null;


        // Loop through the arguments
        for (var i = 0; i < args.Length; i++)
            switch (args[i])
            {
                case "-h":
                case "--help":
                    PrintUsage();
                    return Task.CompletedTask;
                case "-c":
                    configFilename = ValidateConfigurationFile(args, i);
                    if (string.IsNullOrWhiteSpace(configFilename))
                    {
                        Console.WriteLine("Invalid or no path to configuration file.");
                        return Task.CompletedTask;
                    }

                    i++; // Skip the next iteration
                    break;
                case "-t":
                    discordToken = ValidateDiscordToken(args, i);
                    if (string.IsNullOrWhiteSpace(discordToken))
                    {
                        Console.WriteLine("Parameter -t without value");
                        return Task.CompletedTask;
                    }

                    i++; // Skip the next iteration
                    break;
            }

        // Now since all program parameters have been processed, we have to check if the required ones have been done
        if (string.IsNullOrWhiteSpace(configFilename))
        {
            Console.WriteLine("Please specify a configuration file with '-c <file>'.");
            return Task.CompletedTask;
        }

        var applicationSettings = ApplicationSettings.LoadFromFile(configFilename);

        // If a discord token with -t has been set, override the ApplicationSettings with the new Discord token
        if (!string.IsNullOrWhiteSpace(discordToken))
            applicationSettings = new ApplicationSettings(discordToken, applicationSettings.RconEndpoints,
                applicationSettings.LogChannelId, applicationSettings.WebApiConfiguration, applicationSettings.Modules, applicationSettings.ServerTagLimiter);

        return DiscordConnection.RunAsync(applicationSettings);
    }

    private static string? ValidateConfigurationFile(IReadOnlyList<string> args, int index)
    {
        return args.Count >= index + 2 && File.Exists(args[index + 1])
            ? args[index + 1]
            : null;
    }

    private static string? ValidateDiscordToken(IReadOnlyList<string> args, int index)
    {
        return args.Count >= index + 2 ? args[index + 1] : null;
    }

    private static void PrintUsage()
    {
        var sb = new StringBuilder();
        sb.AppendLine("Usage:");
        sb.AppendLine("\t-c <file>\t\tSpecifies the path to the configuration file");
        sb.AppendLine(
            "\t-t DISCORD-TOKEN\tOptional. This overrides/replaces the Discord token in the configuration file.");
        sb.AppendLine("\t-h, --help\t\tPrints this help.");

        Console.WriteLine(sb.ToString());
    }
}