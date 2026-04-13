using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;

namespace ImpulseGaming.ArmaOfficer.Helpers;

public static class WebApi
{
    public static async Task BanAsync(string armaId, string reason, string adminName, WebApiConfiguration conf,
        long durationHours = -1)
    {
        var relativeEndpoint = $"user/banByArmaID?token={conf.ApiToken}";
        var body =
            $"{{\"duration_hours\": {durationHours}, " +
            $"\"admin_name\": \"{adminName}\", " +
            $"\"arma_id\": \"{armaId}\", " +
            $"\"reason\": \"{reason}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Post, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    public static async Task UnbanUserAsync(string armaId, WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/removeUserBanByID?token={conf.ApiToken}";
        var body = $"{{\"arma_id\": \"{armaId}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Post, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    public static async Task<string> GetPlayerStatsByIdAsync(string armaId, WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/getPlayerStatsByID?token={conf.ApiToken}";
        var body = $"{{\"arma_id\": \"{armaId}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }
    
    public static async Task<string> GetPlayerStatsByIdCurrentSeasonAsync(string armaId, WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/getPlayerStatsByIDCurrentSeason?token={conf.ApiToken}";
        var body = $"{{\"arma_id\": \"{armaId}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }
    
    
    public static async Task<string> GetPlayerIdsByName(string armaName, WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/getPlayerIDsByName?token={conf.ApiToken}";
        var body = $"{{\"arma_username\": \"{armaName}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }

    public static async Task<string> VerifyUserAccountAsync(string tempPassword, ulong discordUserId,
        WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/verifyUsersByTempPassword?token={conf.ApiToken}";
        var body = $"{{\"temp_password\": \"{tempPassword}\"," +
                   $"\"discord_id\": \"{discordUserId}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Post, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }

    public static async Task<string> SearchUsersByNameAsync(string searchTerm, int page, WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/searchUsersByUsername?token={conf.ApiToken}";
        var body = $"{{\"search\": \"{searchTerm}\"," +
                   $"\"page\": {page}}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }

    public static async Task<string> GetAllUserBansAsync(WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/getAllUserBans?token={conf.ApiToken}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }
    
    public static async Task<string> GetAllPlayerStatsByDiscordId(ulong discordId,WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/getAllPlayerStatsByDiscordID?token={conf.ApiToken}";
        var body = $"{{\"discord_id\": \"{discordId}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }
    
    public static async Task<string> GetAllPlayerStatsByDiscordIdCurrentSeason(ulong discordId,WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/getAllPlayerStatsByDiscordIDCurrentSeason?token={conf.ApiToken}";
        var body = $"{{\"discord_id\": \"{discordId}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }
    
    public static async Task<string> SearchUserBanAsync(string armaId,WebApiConfiguration conf)
    {
        var relativeEndpoint = $"user/searchUserBans?token={conf.ApiToken}";
        var body = $"{{\"arma_id\": \"{armaId}\"}}";

        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadAsStringAsync();
    }
    
    public static async Task<HttpResponseMessage> AssignSkinToDiscordUserAsync(ulong discordId, string skinName, WebApiConfiguration conf)
    {
        var relativeEndpoint = $"/itemsUser/updateDiscordUserItemFromDiscord?token={conf.ApiToken}";
        var body = $"{{\"discord_id\": \"{discordId}\", \"item_name\": \"{skinName}\", \"request_type\": \"set\", \"quantity\": 1 }}";
        
        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Post, relativeEndpoint);
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        
        return await client.SendAsync(request);
    }
    
    public static async Task<string> GetAllAvailableSkinsAsync( WebApiConfiguration conf)
    {
        var relativeEndpoint = $"/item/getItemNames?token={conf.ApiToken}";
        
        var client = new HttpClient();
        client.BaseAddress = new Uri(conf.BaseUrl);
        client.DefaultRequestHeaders
            .Accept
            .Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var request = new HttpRequestMessage(HttpMethod.Get, relativeEndpoint);
        
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        
        return await response.Content.ReadAsStringAsync();
    }
}