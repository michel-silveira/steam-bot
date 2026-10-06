# Steam Bot v3.0

Idles games and responds to commands sent over Steam chat from your main account.

## Setup

1. Install [Node.js](https://nodejs.org/) 18 or newer.
2. Run `setup.bat`. This installs the dependencies and creates `config.json` from `config.example.json`.
3. Fill in `config.json`:
   - `username` / `password`: the bot account's login.
   - `owner`: the SteamID64 of your main account. Only this account can send commands, and its trade offers get auto-accepted.
   - `shared_secret` / `identity_secret` (optional): from the bot's mobile authenticator. Without `shared_secret` you'll be asked for the Steam Guard code on the first login. Without `identity_secret`, trades that need a mobile confirmation won't be confirmed.
4. Run `run.bat`. It restarts the bot if it crashes or gets the `reboot` command.

After the first successful login, the session is saved to `data/refresh-token` (valid for about 200 days), so later restarts don't need a 2FA code.

`config.json` and `data/` are gitignored. **Never commit them.**

## Commands

Send these to the bot in Steam chat from the `owner` account (default prefix `/`):

| Command | Description |
| --- | --- |
| `/help` | List commands |
| `/idle <appid ...>` | Idle the given games (up to 32) |
| `/stop` | Stop idling |
| `/setstatus <state>` | online, away, snooze, busy, trade, play, invisible |
| `/rename <name>` | Change the profile name |
| `/funds` | Show the wallet balance |
| `/add`, `/remove`, `/block`, `/unblock <steam64id>` | Manage friends |
| `/comment <steam64id> <message>` | Post a profile comment |
| `/reply <message>` | Bot echoes the message back |
| `/reboot` | Restart the bot |
