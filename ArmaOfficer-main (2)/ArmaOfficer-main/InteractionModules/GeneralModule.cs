using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;
using Discord;
using Discord.Interactions;
using Discord.WebSocket;
using ImpulseGaming.ArmaOfficer.AutocompleteModules;
using ImpulseGaming.ArmaOfficer.Extensions;
using ImpulseGaming.ArmaOfficer.Helpers;
using ImpulseGaming.ArmaOfficer.Services;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer.InteractionModules;

public class GeneralModule : InteractionModuleBase<ImpulseInteractionContext>
{
    [SlashCommand("get-skins", "Get a list of assignable skins.")]
    private async Task GetSkinsAsync()
    {
        var apiConfig = Context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;
        
        try
        {
            var response = await WebApi.GetAllAvailableSkinsAsync(apiConfig);
            if (JsonConvert.DeserializeObject<SkinItems>(response) is { } skins)
            {
                var text = $"```\n{string.Join("\n", skins.Items)}\n```";
                await RespondAsync(text, ephemeral: true);
            }
            else
            {
                Console.WriteLine($"getItemNames JSON error: Couldn't parse the response: {response}");
                await RespondAsync("> :x: Couldn't get the list of assignable skins. Please contact an admin.",
                    ephemeral: true);
            }
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"getItemNames HTTP error: {ex}");
            await RespondAsync(
                "> :x: Couldn't get the list of assignable skins. Please contact an admin.",
                ephemeral: true);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"getItemNames GENERAL error: {ex}");
            await RespondAsync(
                "> :x: Couldn't get the list of assignable skins. Please contact an admin.",
                ephemeral: true);
        }
    }

    [SlashCommand("give-item-to-player", "Give an item to a player.")]
    private async Task GiveItemToPlayerAsync(IUser user, [Autocomplete(typeof(Items))] string selectedItem)
    {
        var apiConfig = Context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;
        

        try
        {
            // By default, we assume the itemName was entered manually
            var itemName = selectedItem;
            
            // In case it was selected by Autocomplete, then we are parsing the index number
            // and get a list of all available skins to select the matching index.
            if (selectedItem.StartsWith("item:") && int.TryParse(selectedItem[5..], out var itemIndex))
            {
                var skinResponse = await WebApi.GetAllAvailableSkinsAsync(apiConfig);
                if (JsonConvert.DeserializeObject<SkinItems>(skinResponse) is not { } skins)
                {
                    Console.WriteLine($"getAllAvailableSkins JSON error: Couldn't parse the response: {skinResponse}");
                    await RespondAsync("> :x: Couldn't get the selected skin. Please contact an admin.",
                        ephemeral: true);
                    return;
                }
                itemName = skins.Items[itemIndex];
            }
            
            var response = await WebApi.AssignSkinToDiscordUserAsync(user.Id, itemName, apiConfig);

            if (response.IsSuccessStatusCode)
            {
                await RespondAsync(
                    $"> :white_check_mark: `{itemName}` was successfully delivered to `{user.Username}`.");
            }
            else if (response.StatusCode == HttpStatusCode.NotFound && response.Content.ReadAsStringAsync().Result.Contains("Item does not exist in the database."))
            {
                Console.WriteLine($"updateDiscordUserItem HTTP error: {response.StatusCode}");
                await RespondAsync(
                    $"> :x: This item does not exist.",
                    ephemeral: true);
            }
            else
            {
                Console.WriteLine($"updateDiscordUserItem HTTP error: {response.StatusCode}");
                Debug.Print(response.StatusCode + ": " + response.Content.ReadAsStringAsync().Result);
                await RespondAsync(
                    $"> :x: An error occured. Please contact an admin.",
                    ephemeral: true);
            }
            
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"updateDiscordUserItem HTTP error: {ex}");
            await RespondAsync(
                "> :x: Wasn't able to deliver the item to the player. Please contact an admin.",
                ephemeral: true);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"updateDiscordUserItem GENERAL error: {ex}");
            await RespondAsync(
                "> :x: Wasn't able to deliver the item to the player. Please contact an admin.",
                ephemeral: true);
        }
        
    }
    
    [SlashCommand("memberstats", "Get player stats for a registered Discord user.")]
    private async Task GetPlayerStatsAsync(IUser user, [Choice("Overall",0)][Choice("Current season",1)] int season)
    {
        var seasonChoice = (PlayerStatsSeason)season;
        await GetAllStatsOfUserAsync(user, seasonChoice, Context);
    }

    [SlashCommand("verify-account", "Verify your new Arma account")]
    private async Task VerifyArmaAccountAsync(
        [Summary("temporary-password", "The temporary password you have been given")] string tempPassword)
    {
        var apiConfig = Context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;

        try
        {
            var response = await WebApi.VerifyUserAccountAsync(tempPassword, Context.User.Id, apiConfig);
            if (JsonConvert.DeserializeObject<UserVerificationResponse>(response) is { } verificationResponse)
            {
                var sb = new StringBuilder();
                sb.AppendLine("Success! You have verified your account!");
                sb.AppendLine($"> Arma username: {verificationResponse.ArmaUsername}");
                sb.AppendLine($"> Arma GUID: {verificationResponse.ArmaGuid}");

                await RespondAsync(sb.ToString(), ephemeral: true);
            }
            else
            {
                Console.WriteLine($"verifyUsersByTempPassword JSON error: Couldn't parse the response: {response}");
                await RespondAsync("> :x: Couldn't verify your account with the provided temporary password.",
                    ephemeral: true);
            }
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"verifyUsersByTempPassword HTTP error: {ex}");
            await RespondAsync(
                "> :x: Couldn't verify your account with the provided temporary password. Please contact an admin",
                ephemeral: true);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"verifyUsersByTempPassword GENERAL error: {ex}");
            await RespondAsync(
                "> :x: Couldn't verify your account with the provided temporary password. Please contact an admin.",
                ephemeral: true);
        }
    }

    [SlashCommand("search-player", "Search for a player")]
    private async Task SearchPlayerByNameAsync(string searchTerm)
    {
        var searchTermBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(searchTerm));
        await SearchPlayerByNamePaginationAsync(searchTermBase64, 1);
    }

    [ComponentInteraction("searchPlayerByName:*:*")]
    private async Task SearchPlayerByNamePaginationAsync(string base64SearchTerm, int page)
    {
        // Decode Base64 string
        var searchTerm = Encoding.UTF8.GetString(Convert.FromBase64String(base64SearchTerm));
        
        SearchResult? searchResults;

        try
        {
            searchResults = await SearchUserAsync(searchTerm, page);
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"searchPlayerByName HTTP error: {ex}");
            await RespondAsync("> :x: An error occured while sending the request. Please contact an administrator.",
                ephemeral: true);
            return;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"searchPlayerByName GENERAL error: {ex}");
            await RespondAsync("> :x: An error occured while sending the request. Please contact an administrator.",
                ephemeral: true);
            return;
        }

        if (searchResults is null || searchResults.Members.Length == 0)
        {
            await RespondAsync("> :x: No players found.");
            return;
        }

        // add the found members to a StringBuilder
        var sb = new StringBuilder();
        sb.AppendLine($"## Search results for: {searchTerm.EscapeMarkdown()} (Page {page})");
        foreach (var o in searchResults.Members) sb.AppendLine($"`{o.ArmaId}` -- {o.ArmaUsername.EscapeMarkdown()}");

        // Build the browsing buttons
        var cmp = new ComponentBuilder()
            .WithButton(customId: $"searchPlayerByName:{base64SearchTerm}:{page - 1}", disabled: page == 1,
                emote: new Emoji("\u2b05\ufe0f"))
            .WithButton(customId: $"searchPlayerByName:{base64SearchTerm}:{page + 1}",
                disabled: !searchResults.HasNextPage,
                emote: new Emoji("\u27a1\ufe0f"));

        // If the context was a Slash Command, post a new message
        // If the context was a Message Component (a button), Update the message.
        switch (Context.Interaction)
        {
            case SocketSlashCommand:
                await RespondAsync(sb.ToString(), components: cmp.Build());
                break;
            case SocketMessageComponent button:
                await button.UpdateAsync(x =>
                {
                    x.Content = sb.ToString();
                    x.Components = cmp.Build();
                });
                break;
        }
    }

    [SlashCommand("unban-player", "Unbans the selected user via the web API")]
    private async Task UnbanUserAsync(
        [Autocomplete(typeof(BannedPlayers))] [Summary("user", "Choose an user from the list or enter the GUID")]
        string user)
    {
        if (user.Length > 7 && user.StartsWith("player:"))
            user = user[7..];

        var apiConfig = Context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;

        try
        {
            await WebApi.UnbanUserAsync(user, apiConfig);
            await RespondAsync($"User ID `{user}` has been unbanned");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"UnbanUserAsync HTTP error: {ex}");
            await RespondAsync("A request error occured. Please contact an administrator.", ephemeral: true);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"UnbanUserAsync GENERAL error: {ex}");
            await RespondAsync("An unknown error occured. Please contact an administrator.", ephemeral: true);
        }
    }

    [SlashCommand("playerstats", "Get player stats for a given GUID")]
    private async Task GetPlayerStatsForGuidAsync([Summary("guid","GUID of the player to get the stats for")] [Autocomplete(typeof(AutocompleteModules.Player))] string guid, [Choice("Overall",0)][Choice("Current season",1)] int season)
    {
        if (guid.StartsWith("player:"))
            guid = guid[7..];

        var apiConfig = Context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;

        var seasonChoice = (PlayerStatsSeason)season;
        
        try
        {
            string? response = null;
            switch (seasonChoice)
            {
                case PlayerStatsSeason.Overall:
                    response = await WebApi.GetPlayerStatsByIdAsync(guid, apiConfig);
                    break;
                case PlayerStatsSeason.CurrentSeason:
                    response = await WebApi.GetPlayerStatsByIdCurrentSeasonAsync(guid, apiConfig);
                    break;
                default:
                    throw new InvalidEnumArgumentException(nameof(seasonChoice), (int)seasonChoice, typeof(PlayerStatsSeason));
            }
            if (JsonConvert.DeserializeObject<PlayerStats2>(response) is not { } playerStats2)
            {
                Console.WriteLine($"getPlayerStatsByID JSON error: Couldn't parse response: {response}");
                await RespondAsync("> :x: An error occured while sending the request. Please contact an administrator.",
                    ephemeral: true);
                return;
            }

            var emb = BuildEmbedForPlayerStats(playerStats2);
            
            // Set the footer text for season info
            if (seasonChoice == PlayerStatsSeason.CurrentSeason)
                emb = emb.WithFooter("Current season only");
            
            await RespondAsync(embed: emb.Build());
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"getPlayerStatsByID HTTP error: {ex}");
            await RespondAsync("> :x: An error occured while sending the request. Please contact an administrator.",
                ephemeral: true);
            return;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"getPlayerStatsByID GENERAL error: {ex}");
            await RespondAsync("> :x: An error occured while sending the request. Please contact an administrator.",
                ephemeral: true);
            return;
        }
    }

    [SlashCommand("list-bans", "Gets a list of bans for a player GUID.")]
    private async Task GetPlayerBansAsync([Autocomplete(typeof(AutocompleteModules.Player))] string guid)
    {
        if (guid.StartsWith("player:"))
            guid = guid[7..];

        var apiConfig = Context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;

        try
        {
            var apiResponse = await WebApi.SearchUserBanAsync(guid, apiConfig);
            if (JsonConvert.DeserializeObject<UserBanCollection>(apiResponse) is not { } userBanCollection)
            {
                Console.WriteLine($"SearchUserBanAsync JSON error: Couldn't parse response: {apiResponse}");
                await RespondAsync("> :x: An error occured while sending the request. Please contact an administrator.",
                    ephemeral: true);
                return;
            }

            if (userBanCollection.Bans.Length == 0)
            {
                await RespondAsync(embed:new EmbedBuilder().WithColor(Color.Green).WithDescription("No bans found!").Build(),
                    ephemeral: true);
                return;
            }
            
            var table = new AsciiTable();
            var columns = new List<TableColumn>()
            {
                new TableColumn("ID"),
                new TableColumn("Name"),
                new TableColumn("Banned by"),
                new TableColumn("Reason"),
                new TableColumn("Duration"),
                new TableColumn("Timestamp")
            };
            
            // Fill the columns with data
            foreach (var ban in userBanCollection.Bans)
            {
                columns[0].Rows.Add(ban.Id.ToString());
                columns[1].Rows.Add(ban.ArmaName);
                columns[2].Rows.Add(ban.BannedBy);
                columns[3].Rows.Add(ban.Reason);
                columns[4].Rows.Add(ban.Duration == -1 ? "\u221e" : $"{ban.Duration} h");
                columns[5].Rows.Add(ban.Timestamp.ToString("yyyy-MM-ddTHH:mm:ss.ffZ"));
            }
            table.Columns.AddRange(columns);

            await RespondAsync($"```\n{table.ToString()}\n```");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"SearchUserBanAsync HTTP error: {ex}");
            await RespondAsync(embed:new EmbedBuilder().WithColor(Color.Green).WithDescription($"No bans found for GUID `{guid}` :white_check_mark:").Build());
            return;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SearchUserBanAsync GENERAL error: {ex}");
            await RespondAsync("> :x: An error occured while sending the request. Please contact an administrator.",
                ephemeral: true);
            return;
        }
    }


    private async Task AssignSkinToUserAsync(IGuildUser user, string itemName)
    {
        var apiConfig = Context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;
        
        // Make sure this Discord user has a connected Arma account
        try
        {
            await WebApi.GetAllPlayerStatsByDiscordId(user.Id, apiConfig);
        }
        catch
        {
            // If it throws a 404, then the user does not exist
            await RespondAsync($"> :x: **{user.DisplayName}** does not have a verified Arma account.",
                ephemeral: true);
            return;
        }

        try
        {
            await WebApi.AssignSkinToDiscordUserAsync(user.Id, itemName, apiConfig);
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"AssignSkinToDiscordUserAsync HTTP error: {ex}");
            await RespondAsync("> :x: An error occured while sending the request. Please contact an administrator.",
                ephemeral: true);
        }
    }
    
    public static async Task GetAllStatsOfUserAsync(IUser user, PlayerStatsSeason season, ImpulseInteractionContext context)
    {
        var apiConfig = context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;
        
        await context.Interaction.DeferAsync();
        try
        {
            var response = season switch
            {
                PlayerStatsSeason.Overall => await WebApi.GetAllPlayerStatsByDiscordId(user.Id, apiConfig),
                PlayerStatsSeason.CurrentSeason => await WebApi.GetAllPlayerStatsByDiscordIdCurrentSeason(user.Id,
                    apiConfig),
                _ => throw new InvalidEnumArgumentException(nameof(season), (int)season, typeof(PlayerStatsSeason))
            };
            
            if (JsonConvert.DeserializeObject<PlayerStats2>(response) is not { } stats)
            {
                Console.WriteLine(
                    $"GetAllStatsOfUserAsync JSON error: Couldn't deserialize the API web response: {response}");
                await context.Interaction.FollowupAsync(
                    "> :x: There was an error parsing the data. Please contact an administrator.", ephemeral: true);
                return;
            }

            var emb = BuildEmbedForPlayerStats(stats, user);
            
            // Set the footer text for season info
            if (season == PlayerStatsSeason.CurrentSeason)
                emb = emb.WithFooter("Current season only");
            
            await context.Interaction.FollowupAsync(embed: emb.Build());
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"GetAllStatsOfUserAsync HTTP error: {ex}");
            await context.Interaction.FollowupAsync($"> :x: Sorry, there were no stats found for {user.Mention}.",
                ephemeral: true);
        }
        catch (JsonException ex)
        {
            Console.WriteLine($"GetAllStatsOfUserAsync JSON error: {ex}");
            await context.Interaction.FollowupAsync(
                "> :x: There was an error parsing the data. Please contact an administrator.", ephemeral: true);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"GetAllStatsOfUserAsync GENERAL error: {ex}");
            await context.Interaction.FollowupAsync("> :x: An unknown error occured. Please contact an administrator.",
                ephemeral: true);
        }
    }

    private async Task<SearchResult?> SearchUserAsync(string searchTerm, int page)
    {
        // Get the API configuration
        var apiConfig = Context.Services.GetRequiredService<ApplicationSettings>().WebApiConfiguration;

        // Send the request and get the response
        var response = await WebApi.SearchUsersByNameAsync(searchTerm, page, apiConfig);
        var searchResults = JsonConvert.DeserializeObject<SearchResult>(response);

        return searchResults;
    }

    private static EmbedBuilder BuildEmbedForPlayerStats(PlayerStats2 stats, IUser? discordUser = null)
    {
        var sb = new StringBuilder();
            var killCount = float.Parse(stats.KillCount);
            var deathCount = float.Parse(stats.Deaths);
            sb.AppendLine($"**Kill count:** {killCount.ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine($"**Death count:** {deathCount.ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Kill/Death ratio:** {(killCount / deathCount).ToString("F2", CultureInfo.InvariantCulture)}");
            //sb.AppendLine($"**Player name:** {stats.ArmaName}");
            sb.AppendLine(
                $"**Distance walked:** {(float.Parse(stats.DistanceWalked) / 1000).ToString("F1", CultureInfo.InvariantCulture)} km");
            sb.AppendLine(
                $"**Distance driven:** {(float.Parse(stats.DistanceDriven) / 1000).ToString("F1", CultureInfo.InvariantCulture)} km");
            /*
            Tonic:         Get rid of the longest klill distance
            Tonic:         its pointless the game doesn't track it properly
            Damian Ryse:   It's a translation mistake from my end. The number is "DistanceAsOccupant". I have corrected that already on the dev stage.
            Tonic:         It's still not accurate, even if you displayed the correct one.

            sb.AppendLine($"**Distance as passenger:** {long.Parse(stats.DistanceAsOccupant).ToString("N0",CultureInfo.InvariantCulture)}m");
            */
            sb.AppendLine($"**AI kills:** {long.Parse(stats.AiKills).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**AI road kills:** {long.Parse(stats.AiRoadkills).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Shots fired:** {long.Parse(stats.ShotsFired).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Grenades thrown:** {long.Parse(stats.GrenadesThrown).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Players died in vehicle:** {long.Parse(stats.PlayersDiedInVehicle).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Used bandages:** {long.Parse(stats.BandageSelf).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Used bandages on friendlies:** {long.Parse(stats.BandageFriendlies).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Used saline:** {long.Parse(stats.SalineSelf).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Used saline on friendlies:** {long.Parse(stats.SalineFriendlies).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Used tourniquet:** {long.Parse(stats.TourniquetSelf).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Used tourniquet on friendlies:** {long.Parse(stats.TourniquetFriendlies).ToString("N0", CultureInfo.InvariantCulture)}");
            sb.AppendLine(
                $"**Most killed by:** {stats.MostKilledby} ({long.Parse(stats.MostKilledByCount).ToString("N0", CultureInfo.InvariantCulture)})");
            sb.AppendLine(
                $"**Most killed:** {stats.MostKilled} ({long.Parse(stats.MostKilledCount).ToString("N0", CultureInfo.InvariantCulture)})");

            EmbedBuilder emb;
            
            // If a discordUser is provided (for example by using '/my stats', then include the Discord info in the embed
            if (discordUser is not null)
            {
                emb = new EmbedBuilder()
                    .WithAuthor(discordUser.Username, discordUser.GetDisplayAvatarUrl())
                    .WithTitle(stats.ArmaName)
                    .WithThumbnailUrl(discordUser.GetDisplayAvatarUrl())
                    .WithDescription(sb.ToString())
                    .WithColor(new Color(254, 101, 0));
            }
            // If no discordUser is present, only print the received stats
            else
            {
                emb = new EmbedBuilder()
                    .WithTitle(stats.ArmaName)
                    .WithDescription(sb.ToString())
                    .WithColor(new Color(254, 101, 0));
            }

            return emb;

    }
    

    public enum PlayerStatsSeason
    {
        Overall = 0,
        CurrentSeason = 1,
    }
}