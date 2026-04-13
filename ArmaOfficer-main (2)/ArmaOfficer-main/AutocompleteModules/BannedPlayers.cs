using Discord;
using Discord.Interactions;
using ImpulseGaming.ArmaOfficer.Helpers;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer.AutocompleteModules;

public class BannedPlayers : AutocompleteHandler
{
    public override async Task<AutocompletionResult> GenerateSuggestionsAsync(IInteractionContext context,
        IAutocompleteInteraction autocompleteInteraction,
        IParameterInfo parameter, IServiceProvider services)
    {
        var searchTerm = (string)autocompleteInteraction.Data.Current.Value;
        // Get the application settings
        var appSettings = services.GetRequiredService<ApplicationSettings>();

        var banListResponse =
            JsonConvert.DeserializeObject<BanListResponse>(
                await WebApi.GetAllUserBansAsync(appSettings.WebApiConfiguration));
        if (banListResponse is null)
            return AutocompletionResult.FromError(new Exception("Couldn't parse Web API response."));

        var banList = banListResponse.Bans;

        // Filter the bans according the search term
        if (!string.IsNullOrWhiteSpace(searchTerm))
            banList = banList.Where(o =>
                o.BannedArmaUsername.ToLower().Contains(searchTerm.ToLower()) ||
                o.UserIdBanned.ToLower().Contains(searchTerm.ToLower())).ToArray();

        try
        {
            // Put the players into a List of AutocompleteResults
            // If more than 1 member has the same username in the search results, we're adding the last 5 characters of their UID to the name.
            var results = banList
                .Select(result => new AutocompleteResult(
                    $"{(banList.Count(name => name.BannedArmaUsername == result.BannedArmaUsername) > 1 ? result.BannedArmaUsername + " [..." + result.UserIdBanned[..5] + "]" : result.BannedArmaUsername)}",
                    $"player:{result.UserIdBanned}"))
                .Select(o =>
                    string.IsNullOrWhiteSpace(o.Name)
                        ? new AutocompleteResult($"'{o.Name}'", o.Value)
                        : o) // Fix whitespace-only names
                .ToList();
            return AutocompletionResult.FromSuccess(results.Take(25));
        }
        catch (Exception ex)
        {
            Console.WriteLine(ex);
        }

        return AutocompletionResult.FromError(new Exception("Error parsing the ban list."));
    }
}