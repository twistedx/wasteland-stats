using System.Diagnostics;
using Discord;
using Discord.Interactions;
using Discord.WebSocket;
using ImpulseGaming.ArmaOfficer.Extensions;
using Microsoft.Extensions.DependencyInjection;

namespace ImpulseGaming.ArmaOfficer.InteractionModules;

[Group("my", "User context commands")]
public class MyModule : InteractionModuleBase<ImpulseInteractionContext>
{
    /// <summary>
    /// Cross calling the public static method from the GeneralModule to avoid having repeated code.
    /// </summary>
    [SlashCommand("stats", "Display your own stats")]
    private async Task PrintMyStatsAsync([Choice("Overall",0)][Choice("Current season",1)] int season)
    {
        var appSettings = Context.Services.GetRequiredService<ApplicationSettings>();
        var guildUser = Context.Guild.GetUser(Context.User.Id);
        if (guildUser is null)
        {
            await RespondAsync("An error occured. Sounds weird but I wasn't able to find you...");
            return;
        }
        Debug.Assert(guildUser != null);
        
        if (appSettings.ServerTagLimiter is not null 
            && appSettings.ServerTagLimiter.Enabled 
            && !string.IsNullOrWhiteSpace(appSettings.ServerTagLimiter.BadgeHash))
        {
            if ((guildUser.PrimaryGuild.HasValue
                 && guildUser.PrimaryGuild.Value.BadgeHash == appSettings.ServerTagLimiter.BadgeHash
                 && guildUser.PrimaryGuild.Value.IdentityEnabled.HasValue
                 && guildUser.PrimaryGuild.Value.IdentityEnabled.Value)
                || (appSettings.ServerTagLimiter.DonatorRoleID.HasValue 
                && guildUser.Roles.Any(role => role.Id == appSettings.ServerTagLimiter.DonatorRoleID.Value)))
            {
                var seasonChoice = (GeneralModule.PlayerStatsSeason)season;
                await GeneralModule.GetAllStatsOfUserAsync(Context.User,seasonChoice, Context);
            }
            else
            {
                await RespondAsync(embed: new EmbedBuilder()
                    .WithColor(Color.Red)
                    .WithDescription("Wear the `GAME` Discord tag or become a donator to unlock this feature!")
                    .Build(), ephemeral:true);
            }
        }
        else
        {
            var seasonChoice = (GeneralModule.PlayerStatsSeason)season;
            await GeneralModule.GetAllStatsOfUserAsync(Context.User,seasonChoice, Context);
        }
        
        
    }
}