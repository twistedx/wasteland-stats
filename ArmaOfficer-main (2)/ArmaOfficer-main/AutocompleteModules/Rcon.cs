using Discord;
using Discord.Interactions;
using Microsoft.Extensions.DependencyInjection;

namespace ImpulseGaming.ArmaOfficer.AutocompleteModules;

public class Rcon : AutocompleteHandler
{
    public override async Task<AutocompletionResult> GenerateSuggestionsAsync(IInteractionContext context,
        IAutocompleteInteraction autocompleteInteraction,
        IParameterInfo parameter, IServiceProvider services)
    {
        var rconServers = services.GetRequiredService<ApplicationSettings>().RconEndpoints;

        // Put the servers into a List of AutocompleteResults
        var results = rconServers.Select((rcon, index) => new AutocompleteResult($"{rcon.Name}", $"rcon:{index}"))
            .ToList();

        return AutocompletionResult.FromSuccess(results.Take(25));
    }
}