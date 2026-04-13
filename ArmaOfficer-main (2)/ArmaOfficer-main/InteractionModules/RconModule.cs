using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Discord;
using Discord.Interactions;
using ImpulseGaming.ArmaOfficer.Extensions;
using ImpulseGaming.ArmaOfficer.Helpers;
using ImpulseGaming.ArmaOfficer.Services;
using Microsoft.Extensions.DependencyInjection;

namespace ImpulseGaming.ArmaOfficer.InteractionModules;

[Group("rcon", "RCON commands via Discord")]
public partial class RconModule : InteractionModuleBase<ImpulseInteractionContext>
{
    [SlashCommand("list-players", "Queries all configured RCON servers for online players.")]
    private async Task ListPlayersAsync()
    {
        // Get all available RCON hosts
        var rconHosts = Context.Services.GetRequiredService<ApplicationSettings>().RconEndpoints
            .Where(e => e.IsConnected()).ToArray();

        // Make sure there is at least one connected RCON server
        if (rconHosts.Length == 0)
        {
            await RespondAsync($"> :x: No RCON servers are connected at this time. You can try to reconnect them with `/rcon reconnect`");
            return;
        }
        
        await DeferAsync(true);

        using (Context.Channel.EnterTypingState(RequestOptions.Default))
        {
            foreach (var r in rconHosts)
            {
                var playerlist = await r.GetPlayersAsync();
                if (playerlist.Length == 0)
                {
                    await FollowupAsync($"> No player list received from {r.Name}", ephemeral: true);
                    continue;
                }

                var messages = PlayerListToMessagesConverter(playerlist, r.Name);
                foreach (var m in messages)
                {
                    await FollowupAsync(m, ephemeral: true);
                }
            }
        }
    }

    [SlashCommand("kick-player", "Sends a kick command to all RCON servers.")]
    private async Task KickPlayerAsync([Autocomplete<AutocompleteModules.Player>] string playerUid)
    {
        // Parse the playerUid as it may come from the Autocomplete or a manual input
        if (playerUid.Length > 7 && playerUid.StartsWith("player:"))
            playerUid = playerUid[7..];

        // Get the RCON hosts
        var rconHosts = Context.Services.GetRequiredService<ApplicationSettings>().RconEndpoints
            .Where(e => e.IsConnected()).ToArray();

        // Make sure there is at least one connected RCON server
        if (rconHosts.Length == 0)
        {
            await RespondAsync($"> :x: No RCON servers are connected at this time. You can try to reconnect them with `/rcon reconnect`");
            return;
        }
        
        await DeferAsync(true);

        foreach (var r in rconHosts)
        {
            var response = await r.KickPlayer(playerUid);
            if (string.IsNullOrWhiteSpace(response))
                await FollowupAsync($"> :x: No response from **{r.Name}**", ephemeral: true);
            else
                await FollowupAsync($"**{r.Name}** responded:\n>>> {response}", ephemeral: true);
        }
    }

    [SlashCommand("reconnect", "Reconnect the bot the RCON hosts")]
    private async Task ReconnectRconAsync()
    {
        await DeferAsync();
        // Get the RCON hosts
        var rconHosts = Context.Services.GetRequiredService<ApplicationSettings>().RconEndpoints;

        var embeds = new List<Embed>();

        foreach (var r in rconHosts)
        {
            var emb = new EmbedBuilder();
            if (r.IsConnected())
            {
                emb = emb
                    .WithDescription($"**{r.Name}** is still connected. Skipping...")
                    .WithColor(Color.Gold);
                embeds.Add(emb.Build());
                continue;
            }

            r.Recreate();
            if(await r.AuthenticateAsync())
            {
                emb = emb
                    .WithDescription($"**{r.Name}** got successfully reconnected!")
                    .WithColor(Color.Green);
            }
            else
            {
                emb = emb
                    .WithDescription($"**{r.Name}** could not be reconnected. RCON down?")
                    .WithColor(Color.Red);
            }

            embeds.Add(emb.Build());
        }

        if (embeds.Count == 0)
        {
            await FollowupAsync(
                "> :x: There are either no disconnected RCON hosts or no RCON hosts at all configured.");
            return;
        }

        await FollowupAsync(embeds: embeds.ToArray());
    }


    [SlashCommand("ban-player",
        "Bans a player from all servers via web API and tries to kick them from game servers.")]
    private async Task BanPlayerAsync([Autocomplete<AutocompleteModules.Player>] string playerUid,
        string reason, string? duration = null)
    {
        // Get the application settings
        var appSettings = Context.Services.GetRequiredService<ApplicationSettings>();

        // Parse the playerUid as it may come from the Autocomplete or a manual input
        if (playerUid.Length > 7 && playerUid.StartsWith("player:"))
            playerUid = playerUid[7..];

        // ban duration is -1 (equals to Forever)
        long duraHours = -1;

        // Parse the user input for duration and change duraHours accordingly.
        if (!string.IsNullOrWhiteSpace(duration) && duration != "0")
        {
            var regexMatch = BanDurationRegex().Match(duration);
            if (!regexMatch.Success)
            {
                await RespondAsync(
                    "Invalid duration. Please use *<number>* + optional `d` suffix to define a duration or leave empty to ban the player forever..\n" +
                    "**Examples:** `4`, `365d`", ephemeral: true);
                return;
            }

            var timeValue = double.Parse(regexMatch.Groups[1].ToString());

            duraHours = regexMatch.Groups[2].ToString() switch
            {
                "d" => (long)TimeSpan.FromDays(timeValue).TotalHours,
                null => (long)timeValue,
                _ => duraHours
            };
        }

        // Try to send the BAN request via the web API.
        // If that fails, print error message and return here.
        try
        {
            await WebApi.BanAsync(playerUid, reason, Context.User.Username, appSettings.WebApiConfiguration,
                duraHours);
        }
        catch (HttpRequestException httpEx)
        {
            if (httpEx.StatusCode == HttpStatusCode.NotFound)
                await RespondAsync(
                    "> :x: **Received HTTP Error 404 (Not found) after performing `banByArmaID` request**: This can happen if the UID is invalid.",
                    ephemeral: true);
            else
                await RespondAsync($"> :x: {httpEx.Message}", ephemeral: true);

            return;
        }

        // Try to receive the player stats for the user, to get their username
        // If it fails, we don't care and just print the UID to the log channel.
        PlayerStats? playerInfo = null;
        try
        {
            var playerInfoResponse = await WebApi.GetPlayerStatsByIdAsync(playerUid, appSettings.WebApiConfiguration);
            playerInfo = PlayerStats.Parse(playerInfoResponse);
        }
        catch (HttpRequestException httpEx)
        {
            // Do nothing
        }

        await Context.Services.GetRequiredService<LoggingService>().SendToLogChannel(
            $"Player {(playerInfo is null ? $" UID `{playerUid}`" : $"**{playerInfo.Username}** (`{playerUid}`)")} was banned by {Context.User.Mention} for reason: {(string.IsNullOrWhiteSpace(reason) ? "*No reason given*" : reason)}");

        await KickPlayerAsync(playerUid);
    }

    [GeneratedRegex(@"^(\d+)([d]?)$")]
    private static partial Regex BanDurationRegex();

    private string[] PlayerListToMessagesConverter(Player[] players, string serverName)
    {
        List<string> messages = [];

        // Columns for the ASCII table
        var clmPlayerNumber = new TableColumn("#");
        var clmPlayerUid = new TableColumn("Player UID");
        var clmPlayerName = new TableColumn("Name");

        // Fill the ASCII table columns with data
        foreach (var player in players)
        {
            clmPlayerNumber.Rows.Add(player.PlayerNumber.ToString());
            clmPlayerUid.Rows.Add(player.Puid);
            clmPlayerName.Rows.Add(player.Name);
        }

        var asciiTable = new AsciiTable();
        asciiTable.Columns.AddRange([clmPlayerNumber, clmPlayerUid, clmPlayerName]);
        var asciiTableLines = asciiTable.ToString().Split("\n");

        var sb = new StringBuilder();

        sb.AppendLine($"## {serverName}"); // Server name as table title
        sb.AppendLine($"**Players online:** {players.Length}");
        sb.AppendLine("```"); // Start the code block
        foreach (var tableLine in asciiTableLines)
        {
            sb.AppendLine(tableLine);
            if (sb.ToString().Length <= 1900) continue;

            // We've almost reached the maximum message length.
            // Add the three backticks to close the code block and send the message
            sb.AppendLine("```");
            messages.Add(sb.ToString());

            // Clear the StringBuilder and add the backticks to start the next code block.
            sb.Clear();
            sb.AppendLine("```");
        }

        // If there is remaining data in the StringBuilder, add the closing backticks and add the message to the list.
        if (sb.ToString().Length > 0)
        {
            sb.AppendLine("```"); // Close the code block.
            messages.Add(sb.ToString());
        }

        return messages.ToArray();
    }
}