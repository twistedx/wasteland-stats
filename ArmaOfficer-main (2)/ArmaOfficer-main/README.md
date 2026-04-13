# Arma Officer

> © Damian Ryse, December 2024

## Description

*Arma Officer* is a Discord bot for managing RCON based servers of **Bohemia Interactive**s video game "Arma Reforger".
The goal of the bot is to provide an easy interface via the Discord functionalities to moderate the game. For this,
*Arma Officer* supports */SlashCommands* that can be used on either the Desktop application, the mobile application or
in a web browser. Those slash commands are then translated into RCON commands and send to the configured servers.

Additionally, the bot supports the custom web API '*banByArmaID*' and integrated it into the slash commands as well.

## Slash Commands

**/rcon list-players**: Connects to all available RCON hosts and sends the `players` command, then waits for a server
message containing the list. The bot parses the responses, orders them and then prints them to Discord.

**/rcon kick-player**: This command takes a GUID as input parameter and also supports a selection menu for
autocompletion (taken from the cache of `list-players`).
The bot translates the GUID to the player number and calls the RCON `kick` request on the server where the user was
found. An up-to-date player cache is required.

**/rcon ban-player**: This command takes the following input parameters: **GUID**, **Duration** (*optional*), **Reason
** (*optional*).
The bot performs a POST request to a hardcoded API endpoint `banByArmaID`, using the given parameters. If the POST
request
was successful, the bot will then send a `kick` command to all RCON hosts.

**/rcon reconnect**: Tries to reconnect the bot to the RCON hosts.

**/verify-account**: Takes a temporary password as parameter and executes a web API request to verify an Arma account.

**/search-player**: Searches for players using the `searchUsersByName` API endpoint with the provided search term.

**/list-bans**: Lists all currently banned players via the web API.

**/unban-player**: Takes a GUID or a selection as parameter and unbans the GUID via the web API.

**/my stats**: Retrieves the player stats (kills, death, KDR, etc). This command can be limited/paywalled. To limit usage of this command, make sure you have the following configuration setting in your config file:
```json
{
  "ServerTagLimiter": {
    "Enabled": true,
    "BadgeHash": "HASH VALUE OF YOUR SERVERS TAG BADGE",
    "DonatorRoleID": 1234567890
  }
}
```

**/playerstats**: Same as `/my stats` but takes a GUID as parameter.

## User context commands
> Right click on a user -> Apps -> command....

**Show stats**: Same as `/my stats` but for the selected user.

## Basic setup

Download the precompiled package of the bot and extract it on your Linux server in a suitable location (
e.g.: `/usr/bin/armaofficer/`).
Make sure **.NET 8.0 RUNTIME** is installed on the machine:

- **Arch based distros:** `sudo pacman -S dotnet-runtime`
- **Debian based distros:** `sudo apt install dotnet-runtime-8.0`
- **CentOS:** `dnf install dotnet-runtime-8.0`

Create a new directory: `/etc/ImpulseGaming/` and put a new file in there: `ArmaOfficer.conf`.
The configuration file is written in JSON format. Here is an example:

```json
{
    "DiscordToken": "<YOUR-DISCORD-BOT-TOKEN>",
    "LogChannelID": 1234567890123456,
    "RCON":[
        {
	    "Address": "127.0.0.1",
	    "Port": 27552,
	    "User": null,
	    "Pass": "myRconPassword",
	    "Name": "Local game server #1"
	},
	{
	    "Address": "192.168.1.15",
	    "Port": 27552,
	    "User": "",
	    "Pass": "myRconPassword",
	    "Name": "Remote game server #2"
	}
    ],
  "WebAPI" : {
    "BaseURL": "http://158.69.247.134:3000/",
    "ApiToken": "YourTokenHere"
  }
}
```

## Security

For security reasons, I'd recommend to `chmod 0600` the configuration file, so it's only readable by root. Alternatively
if you plan to use a separate user account to run the bot, `chown user:group ArmaOfficer.conf` first and
then `chmod 0600` the file.

It's also recommended to restrict the access to the `/rcon` commands in your Discord server settings.

## Running the bot

To manually start the bot,
execute `dotnet /usr/bin/armaofficer/armaofficer.dll -c /etc/ImpulseGaming/ArmaOfficer.conf`.
Executing the bot without parameters will print a help message.

If you like to run the bot as a service, please consult your distros wiki/documentation.