const fs = require('fs');
const path = require('path');

const loginPath = path.join(__dirname, '..', '..', 'client', 'Account', 'login.html');
const registerPath = path.join(__dirname, '..', '..', 'client', 'Account', 'register.html');
const lobbyPath = path.join(__dirname, '..', '..', 'client', 'Game', 'lobby.html');
const roomPath = path.join(__dirname, '..', '..', 'client', 'Game', 'room.html');
const boardPath = path.join(__dirname, '..', '..', 'client', 'Game', 'board.html');
const tokenSelectionPath = path.join(__dirname, '..', '..', 'client', 'Game', 'token-selection.html');
const menuPath = path.join( __dirname, '..', '..', 'client', 'Game', 'menu.html');
const rulesPath = path.join(__dirname, '..', '..', 'client', 'Game', 'rules.html');
const statsPath = path.join(__dirname, '..', '..', 'client', 'Game', 'stats.html');
const localLobbyPath = path.join(__dirname, '..', '..', 'client', 'Game', 'local-lobby.html');
const avatarPath = path.join(__dirname, '..', '..', 'client', 'Game', 'avatar.html');
const musicScriptPath = path.join(__dirname, '..', '..', 'client', 'Game', 'music.js');
const musicShellScriptPath = path.join(__dirname, '..', '..', 'client', 'Game', 'music-shell.js');

function servePage(filePath, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error('Error loading page:', err);
            res.writeHead(500, {
                'Content-Type': 'text/plain'
            });
            res.end('Error loading page.');
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/html'
        });
        res.end(data);
    });
}


function escapeHtmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function serveMusicShell(requestUrl, res) {
    const safeUrl = escapeHtmlAttribute(requestUrl);

    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
    });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Onlineopoly</title>
    <style>
        html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
        #app-content { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
    </style>
</head>
<body>
    <iframe id="app-content" name="app-content" src="${safeUrl}" title="Onlineopoly" allow="autoplay"></iframe>
    <script src="/Game/music.js"></script>
    <script src="/Game/music-shell.js"></script>
</body>
</html>`);
}

function handlePageRequest(req, res) {
    const route = req.url.split('?')[0];

    if (req.method !== 'GET') {
        return false;
    }

    // Serve sprite images.
    if (route.startsWith('/Game/sprites/')) {
        const filename = path.basename(decodeURIComponent(route));
        const spritePath = path.join(
            __dirname,
            '..',
            '..',
            'client',
            'Game',
            'sprites',
            filename
        );

        const extension = path.extname(filename).toLowerCase();

        const contentTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.gif': 'image/gif'
        };

        fs.readFile(spritePath, (err, data) => {
            if (err) {
                console.error('Sprite loading error:', err.message);
                res.writeHead(404, {
                    'Content-Type': 'text/plain'
                });
                res.end('Sprite not found');
                return;
            }

            res.writeHead(200, {
                'Content-Type':
                    contentTypes[extension] || 'application/octet-stream'
            });
            res.end(data);
        });

        return true;
    }

    // Serve audio files.
    if (route.startsWith('/Game/Audio/')) {
        const filename = path.basename(decodeURIComponent(route));
        const audioPath = path.join(
            __dirname,
            '..',
            '..',
            'client',
            'Game',
            'Audio',
            filename
        );

        const extension = path.extname(filename).toLowerCase();
        const contentTypes = {
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.ogg': 'audio/ogg',
            '.m4a': 'audio/mp4'
        };

        fs.readFile(audioPath, (err, data) => {
            if (err) {
                console.error('Audio loading error:', err.message);
                res.writeHead(404, {
                    'Content-Type': 'text/plain'
                });
                res.end('Audio file not found');
                return;
            }

            res.writeHead(200, {
                'Content-Type':
                    contentTypes[extension] || 'application/octet-stream'
            });
            res.end(data);
        });

        return true;
    }

    const gameScriptPath = route === '/Game/music.js'
        ? musicScriptPath
        : route === '/Game/music-shell.js'
            ? musicShellScriptPath
            : null;

    if (gameScriptPath) {
        fs.readFile(gameScriptPath, (err, data) => {
            if (err) {
                console.error('Music script loading error:', err.message);
                res.writeHead(500, {
                    'Content-Type': 'text/plain'
                });
                res.end('Music controls could not be loaded.');
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8'
            });
            res.end(data);
        });

        return true;
    }

    let filePath;

    if (route === '/' || route === '/login') {
        filePath = loginPath;
    } else if (route === '/register') {
        filePath = registerPath;
    } else if (route === '/menu') {
        filePath = menuPath;
    } else if (route === '/rules') {
        filePath = rulesPath;
    } else if (route === '/stats') {
        filePath = statsPath;
    } else if (route === '/avatar-selection') {
        filePath = avatarPath;
    } else if (route === '/lobby') {
        filePath = lobbyPath;
    } else if (route === '/local-lobby') {
        filePath = localLobbyPath;
    } else if (route === '/room' || route.startsWith('/room/')) {
        filePath = roomPath;
    } else if (route === '/token-selection') {
        filePath = tokenSelectionPath;
    } else if (route === '/board') {
        filePath = boardPath;
    } else {
        return false;
    }

    if (req.headers['sec-fetch-dest'] !== 'iframe') {
        serveMusicShell(req.url, res);
        return true;
    }

    servePage(filePath, res);
    return true;
}
module.exports = handlePageRequest;
