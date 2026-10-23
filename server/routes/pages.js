const fs = require('fs');
const path = require('path');

const loginPath = path.join(__dirname, '..', '..', 'client', 'Account', 'login.html');
const registerPath = path.join(__dirname, '..', '..', 'client', 'Account', 'register.html');
const lobbyPath = path.join(__dirname, '..', '..', 'client', 'Game', 'lobby.html');
const roomPath = path.join(__dirname, '..', '..', 'client', 'Game', 'room.html');
const boardPath = path.join(__dirname, '..', '..', 'client', 'Game', 'board.html');
const tokenSelectionPath = path.join(__dirname, '..', '..', 'client', 'Game', 'token-selection.html');
const menuPath = path.join( __dirname, '..', '..', 'client', 'Game', 'menu.html');

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


function handlePageRequest(req, res) {
    const route = req.url.split('?')[0];

    if (req.method !== 'GET') {
        return false;
    }

    // Serve sprite images.
    if (route.startsWith('/Game/sprites/')) {
        const filename = path.basename(route);
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

    let filePath;

    if (route === '/' || route === '/login') {
        filePath = loginPath;
    } else if (route === '/register') {
        filePath = registerPath;
    } else if (route === '/menu') {
        filePath = menuPath;
    } else if (route === '/lobby') {
        filePath = lobbyPath;
    } else if (route === '/room' || route.startsWith('/room/')) {
        filePath = roomPath;
    } else if (route === '/token-selection') {
        filePath = tokenSelectionPath;
    } else if (route === '/board') {
        filePath = boardPath;
    } else {
        return false;
    }

    servePage(filePath, res);
    return true;
}
module.exports = handlePageRequest;