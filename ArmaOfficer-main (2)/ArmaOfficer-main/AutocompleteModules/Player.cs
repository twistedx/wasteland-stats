using Discord;
using Discord.Interactions;
using ImpulseGaming.ArmaOfficer.Helpers;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer.AutocompleteModules;

public class Player : AutocompleteHandler
{
    public override async Task<AutocompletionResult> GenerateSuggestionsAsync(IInteractionContext context,
        IAutocompleteInteraction autocompleteInteraction,
        IParameterInfo parameter, IServiceProvider services)
    {
        var searchTerm = (string)autocompleteInteraction.Data.Current.Value;
        if (string.IsNullOrWhiteSpace(searchTerm) || searchTerm.Length < 3)
            return AutocompletionResult.FromSuccess();

        // Get the application settings
        var appSettings = services.GetRequiredService<ApplicationSettings>();

        var searchResult =
            JsonConvert.DeserializeObject<SearchResult>(
                await WebApi.SearchUsersByNameAsync(searchTerm, 1, appSettings.WebApiConfiguration));
        if (searchResult is null)
            return AutocompletionResult.FromError(new Exception("Couldn't parse Web API response."));

        // Put the players into a List of AutocompleteResults
        // If more than 1 member has the same username in the search results, we're adding the last 5 characters of their UID to the name.
        var results = searchResult.Members
            .Select(result =>
                new AutocompleteResult(
                    $"{(searchResult.Members.Count(name => name.ArmaUsername == result.ArmaUsername) > 1 ? result.ArmaUsername + " [..." + result.ArmaId[..5] + "]" : result.ArmaUsername)}",
                    $"player:{result.ArmaId}"))
            .ToList();

        return AutocompletionResult.FromSuccess(results.Take(25));
    }
}