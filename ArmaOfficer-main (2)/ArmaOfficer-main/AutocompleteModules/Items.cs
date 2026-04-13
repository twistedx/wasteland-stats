using Discord;
using Discord.Interactions;
using ImpulseGaming.ArmaOfficer.Helpers;
using Microsoft.Extensions.DependencyInjection;
using Newtonsoft.Json;

namespace ImpulseGaming.ArmaOfficer.AutocompleteModules;

public class Items : AutocompleteHandler
{
    public override async Task<AutocompletionResult> GenerateSuggestionsAsync(IInteractionContext context,
        IAutocompleteInteraction autocompleteInteraction,
        IParameterInfo parameter, IServiceProvider services)
    {
        // var searchTerm = (string)autocompleteInteraction.Data.Current.Value;
        // Get the application settings
        var appSettings = services.GetRequiredService<ApplicationSettings>();
        
        var response = await WebApi.GetAllAvailableSkinsAsync(appSettings.WebApiConfiguration);
        
        if (JsonConvert.DeserializeObject<SkinItems>(response) is not { } skins)
            return AutocompletionResult.FromError(new Exception("Wasn't able to retrieve the list of items."));
        
        var results = skins.Items.Select((itemName, index) => new AutocompleteResult($"{itemName}", $"item:{index}"))
            .ToList();
        return AutocompletionResult.FromSuccess(results.Take(25));

    }
}