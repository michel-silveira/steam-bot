const fs = require('fs');
const path = require('path');

const SteamUser = require('steam-user'),
    SteamTotp = require('steam-totp'),
    SteamCommunity = require('steamcommunity'),
    TradeOfferManager = require('steam-tradeoffer-manager');

// Everything private (credentials, owner SteamID, refresh token) lives in
// config.json and data/, both of which are gitignored.
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_PATH = path.join(DATA_DIR, 'refresh-token');

// Exit code that tells run.bat not to restart (config problems, bad password)
const EXIT_FATAL = 2;

const config = loadConfig();
const prefix = config.prefix || '/';

const client = new SteamUser({ dataDirectory: DATA_DIR, renewRefreshTokens: true }),
    community = new SteamCommunity();

const manager = new TradeOfferManager({
    steam: client,
    community: community,
    language: 'en'
});

let wallet = 'unknown';
let personaState = SteamUser.EPersonaState.Online;
let usingToken = false;

console.log(`\nSteam Bot v3.0`);
console.log(`\nHere we go~\n`);
logIn();

// ---------------------------------------------------------------------------
// Config / token helpers
// ---------------------------------------------------------------------------

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error('config.json not found. Copy config.example.json to config.json and fill it in.');
        process.exit(EXIT_FATAL);
    }

    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cfg.owner = String(cfg.owner || '');
    if (!/^\d{17}$/.test(cfg.owner)) {
        console.error('config.json: "owner" must be the SteamID64 (17 digits) of the account allowed to send commands.');
        process.exit(EXIT_FATAL);
    }
    cfg.trades = cfg.trades || {};
    return cfg;
}

function readToken() {
    try {
        return fs.readFileSync(TOKEN_PATH, 'utf8').trim() || null;
    } catch (err) {
        return null;
    }
}

function saveToken(token) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
}

function clearToken() {
    try { fs.unlinkSync(TOKEN_PATH); } catch (err) { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function logIn() {
    const token = readToken();
    usingToken = !!token;

    if (token) {
        console.log('Logging in with saved session...');
        client.logOn({ refreshToken: token });
        return;
    }

    if (!config.username || !config.password) {
        console.error('No saved session and no username/password in config.json.');
        process.exit(EXIT_FATAL);
    }

    console.log('Logging in with username and password...');
    const logOnOptions = {
        accountName: config.username,
        password: config.password
    };
    // Without a shared_secret, steam-user will prompt for the Steam Guard code in the terminal
    if (config.shared_secret)
        logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(config.shared_secret);

    client.logOn(logOnOptions);
}

// Steam hands out a refresh token (~200 days) after a password login and
// renews it periodically; saving it means no 2FA prompt on restart.
client.on('refreshToken', (token) => {
    saveToken(token);
    console.log('Saved login session to data/.');
});

client.on('loggedOn', () => {
    console.log('Successfully logged into Steam!');

    client.setPersona(personaState);
    client.gamesPlayed(config.games || []);
});

client.on('error', (err) => {
    const EResult = SteamUser.EResult;
    console.error(`Steam error: ${err.message} (EResult ${err.eresult})`);

    // Saved token expired or was revoked: drop it and fall back to password
    if (usingToken && [EResult.InvalidPassword, EResult.AccessDenied, EResult.Expired, EResult.Revoked].includes(err.eresult)) {
        clearToken();
        console.log('Saved session is no longer valid, retrying with password...');
        return setTimeout(logIn, 5 * 1000);
    }

    if (err.eresult === EResult.InvalidPassword) {
        console.error('Wrong username or password, check config.json.');
        process.exit(EXIT_FATAL);
    }

    // Retrying fast while rate limited only extends the limit
    const delay = err.eresult === EResult.RateLimitExceeded ? 30 * 60 * 1000 : 60 * 1000;
    console.log(`Reconnecting in ${delay / 60000} minute(s)...`);
    setTimeout(logIn, delay);
});

// Cookies for trade offers and community actions (comments, confirmations)
client.on('webSession', (sessionID, cookies) => {
    community.setCookies(cookies);
    manager.setCookies(cookies, (err) => {
        if (err) console.error('Trade manager could not start: ' + err.message);
    });
});

client.on('wallet', (hasWallet, currency, balance) => {
    wallet = hasWallet ? SteamUser.formatCurrency(balance, currency) : 'no wallet';
});

// ---------------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------------

function displayName(id64) {
    return client.users[id64] ? client.users[id64].player_name + ' ' : '';
}

// Takes a SteamID object or a SteamID64 string
function acceptFriend(steamId) {
    const id64 = steamId.toString();
    client.addFriend(steamId)
        .then(() => console.log('Accepted a friend request from ' + displayName(id64) + '(' + id64 + ')'))
        .catch((err) => console.error('Could not accept friend request: ' + err.message));
}

client.on('friendRelationship', (steamId, relationship) => {
    if (config.autoAcceptFriends && relationship === SteamUser.EFriendRelationship.RequestRecipient)
        acceptFriend(steamId);
});

// Friend requests that arrived while the bot was offline
client.on('friendsList', () => {
    if (!config.autoAcceptFriends) return;
    for (const id64 in client.myFriends) {
        if (client.myFriends[id64] === SteamUser.EFriendRelationship.RequestRecipient)
            acceptFriend(id64);
    }
});

// ---------------------------------------------------------------------------
// Chat commands
// ---------------------------------------------------------------------------

function reply(steamId, text) {
    return client.chat.sendFriendMessage(steamId, text)
        .catch((err) => console.error('Could not send message: ' + err.message));
}

function requireSteamId(arg, usage) {
    if (!/^\d{17}$/.test(arg || ''))
        throw new Error(`Please specify a Steam64 ID (${prefix}${usage})`);
    return arg;
}

const states = {
    online: SteamUser.EPersonaState.Online,
    away: SteamUser.EPersonaState.Away,
    snooze: SteamUser.EPersonaState.Snooze,
    busy: SteamUser.EPersonaState.Busy,
    trade: SteamUser.EPersonaState.LookingToTrade,
    play: SteamUser.EPersonaState.LookingToPlay,
    invisible: SteamUser.EPersonaState.Invisible
};

const commands = {
    help: {
        usage: 'help',
        run: (steamId) => reply(steamId, 'Commands:\n' + Object.values(commands).map((c) => prefix + c.usage).join('\n'))
    },

    idle: {
        usage: 'idle <appid1 appid2 ...>',
        run: (steamId, args) => {
            const games = args.map((a) => parseInt(a, 10));
            if (!games.length || games.some(isNaN))
                return reply(steamId, `Please use the command correctly! (${prefix}idle <appid1 appid2>)`);
            if (games.length > 32)
                return reply(steamId, 'Steam only allows idling up to 32 games at once.');
            client.gamesPlayed(games);
            return reply(steamId, `Now idling: ${games.join(', ')}`);
        }
    },

    stop: {
        usage: 'stop',
        run: (steamId) => {
            client.gamesPlayed([]);
            return reply(steamId, 'Stopped idling.');
        }
    },

    add: {
        usage: 'add <steam64id>',
        run: async (steamId, args) => {
            await client.addFriend(requireSteamId(args[0], 'add <steam64id>'));
            return reply(steamId, 'Friend request sent.');
        }
    },

    remove: {
        usage: 'remove <steam64id>',
        run: (steamId, args) => {
            client.removeFriend(requireSteamId(args[0], 'remove <steam64id>'));
            return reply(steamId, 'Friend removed.');
        }
    },

    block: {
        usage: 'block <steam64id>',
        run: async (steamId, args) => {
            await client.blockUser(requireSteamId(args[0], 'block <steam64id>'));
            return reply(steamId, 'User blocked.');
        }
    },

    unblock: {
        usage: 'unblock <steam64id>',
        run: async (steamId, args) => {
            await client.unblockUser(requireSteamId(args[0], 'unblock <steam64id>'));
            return reply(steamId, 'User unblocked.');
        }
    },

    funds: {
        usage: 'funds',
        run: (steamId) => reply(steamId, `My wallet balance is: ${wallet}`)
    },

    reply: {
        usage: 'reply <message>',
        run: (steamId, args) => args.length && reply(steamId, args.join(' '))
    },

    comment: {
        usage: 'comment <steam64id> <message>',
        run: (steamId, args) => {
            const target = requireSteamId(args[0], 'comment <steam64id> <message>');
            const comment = args.slice(1).join(' ');
            if (!comment) return reply(steamId, `Please write a comment (${prefix}comment <steam64id> <message>)`);
            community.postUserComment(target, comment, (err) => {
                reply(steamId, err ? 'Could not post comment: ' + err.message : 'Comment posted.');
            });
        }
    },

    rename: {
        usage: 'rename <name>',
        run: (steamId, args) => {
            const username = args.join(' ');
            if (username.length < 2)
                return reply(steamId, `Username must be at least 2 characters (${prefix}rename <name>)`);
            if (username.length > 32)
                return reply(steamId, 'Username must not be greater than 32 characters');
            client.setPersona(personaState, username);
            return reply(steamId, `Renamed to ${username}`);
        }
    },

    setstatus: {
        usage: 'setstatus <' + Object.keys(states).join('|') + '>',
        run: (steamId, args) => {
            const state = (args[0] || '').toLowerCase();
            if (!(state in states))
                return reply(steamId, `Sorry but I couldn't find a state with the name ${state}\nAvailable states: ${Object.keys(states).join(', ')}`);
            personaState = states[state];
            client.setPersona(personaState);
            return reply(steamId, `Status set to ${state}`);
        }
    },

    reboot: {
        usage: 'reboot',
        run: async (steamId) => {
            await reply(steamId, 'Rebooting...');
            client.logOff();
            // run.bat restarts the bot on any exit code other than EXIT_FATAL
            setTimeout(() => process.exit(1), 1000);
        }
    }
};

client.chat.on('friendMessage', async (message) => {
    const steamId = message.steamid_friend;
    const id64 = steamId.getSteamID64();
    const text = message.message.trim();

    console.log('Message from ' + displayName(id64) + '(' + id64 + '): ' + text);

    // Only the owner from config.json can control the bot
    if (id64 !== config.owner || !text.startsWith(prefix))
        return;

    const [name, ...args] = text.slice(prefix.length).split(/\s+/);
    const command = commands[name.toLowerCase()];
    if (!command)
        return reply(steamId, `Unknown command. Use ${prefix}help to list commands.`);

    try {
        await command.run(steamId, args);
    } catch (err) {
        reply(steamId, err.message);
    }
});

// ---------------------------------------------------------------------------
// Trade offers
// ---------------------------------------------------------------------------

manager.on('newOffer', (offer) => {
    const partner = offer.partner.getSteamID64();

    if (config.trades.autoAcceptFromOwner && partner === config.owner) {
        offer.accept((err, status) => {
            if (err) return console.error('Could not accept trade offer: ' + err.message);
            console.log(`Trade offer #${offer.id} accepted. Status: ${status}.`);

            // Offers where the bot gives items away need a mobile confirmation
            if (status !== 'pending') return;
            if (!config.identity_secret)
                return console.log('Trade needs mobile confirmation, but no identity_secret is set in config.json.');

            community.acceptConfirmationForObject(config.identity_secret, offer.id, (err) => {
                if (err) console.error('Could not confirm trade: ' + err.message);
                else console.log(`Trade offer #${offer.id} confirmed.`);
            });
        });
    } else if (config.trades.declineOthers) {
        offer.decline((err) => {
            if (err) console.error('Could not decline trade offer: ' + err.message);
            else console.log(`Declined trade offer #${offer.id} from another account.`);
        });
    }
});

process.on('SIGINT', () => {
    console.log('\nLogging off...');
    client.logOff();
    setTimeout(() => process.exit(EXIT_FATAL), 1000);
});
