using Discord;
using Discord.Interactions;
using Discord.WebSocket;
using ImpulseGaming.ArmaOfficer.Features;
using ImpulseGaming.ArmaOfficer.Services;
using Microsoft.Extensions.DependencyInjection;

namespace ImpulseGaming.ArmaOfficer;

public class DiscordConnection
{
    private readonly ApplicationSettings _appSettings;
    private ServiceProvider _serviceProvider;

    private DiscordConnection(ApplicationSettings applicationSettings)
    {
        _appSettings = applicationSettings;
    }

    public static async Task RunAsync(ApplicationSettings applicationSettings)
    {
        var startup = new DiscordConnection(applicationSettings);
        await startup.InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        var services = new ServiceCollection();
        ConfigureServices(services);

        _serviceProvider = services.BuildServiceProvider();
        
        var rconEndpoints = _serviceProvider.GetRequiredService<ApplicationSettings>().RconEndpoints;
        foreach (var r in rconEndpoints)
        {
            Console.Write($"Authenticating to RCON host {r.Name}...");
            if(await r.AuthenticateAsync())
                Console.WriteLine("OK!");
            else
                Console.WriteLine("FAILED!");
        }
        Console.WriteLine("Starting discord");
        
        await _serviceProvider.GetRequiredService<InteractionHandler>().InitializeAsync();
        await _serviceProvider.GetRequiredService<StartupService>().StartAsync();
        _serviceProvider.GetRequiredService<LoggingService>().InitializeAsync(_appSettings.LogChannelId);
        
        if(_appSettings.Modules.Any(o => o == "AutoBanNewUsers"))
            _serviceProvider.GetRequiredService<AutoBanNewUsers>().Initialize();
        
        // Do not initialize the UserMetrics yet. We don't have an API endpoint yet to store data into the database.
        // if(_appSettings.Modules.Any(o => o == "UserMetrics"))
        //    _serviceProvider.GetRequiredKeyedService<UserMetrics>(_appSettings).Initialize();
        
        
        
        // Catch SIGINT signal to clean up before exiting
        Console.CancelKeyPress += ConsoleOnCancelKeyPress;

        await Task.Delay(-1);
    }

    private async void ConsoleOnCancelKeyPress(object? sender, ConsoleCancelEventArgs e)
    {
        Console.WriteLine("Shutting down...");
        var client = _serviceProvider.GetRequiredService<DiscordSocketClient>();
        await client.LogoutAsync();
        await client.StopAsync();
        await client.DisposeAsync();
        Environment.Exit(0);
    }

    private void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton(new DiscordSocketClient(new DiscordSocketConfig
            {
                LogLevel = LogSeverity.Debug,
                MessageCacheSize = 1000,
                GatewayIntents = GatewayIntents.AllUnprivileged,
                AlwaysDownloadUsers = true
            }))
            .AddSingleton(_appSettings)
            .AddSingleton(x => new InteractionService(x.GetRequiredService<DiscordSocketClient>(),
                new InteractionServiceConfig
                {
                    InteractionCustomIdDelimiters = [';']
                }))
            .AddSingleton<InteractionHandler>()
            .AddSingleton<StartupService>()
            .AddSingleton<LoggingService>()
            .AddSingleton<UserMetrics>()
            .AddSingleton<AutoBanNewUsers>();
    }
}