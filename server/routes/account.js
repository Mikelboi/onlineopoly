const { sendJson, getSession } = require('./httpHelpers');
const fs = require('fs');
const path = require('path');

function readBody(req, res, maxBytes = 10000) {
    return new Promise((resolve, reject) => {
        let body = '';
        let tooLarge = false;

        req.on('data', chunk => {
            if (tooLarge) return;

            body += chunk;

            if (Buffer.byteLength(body, 'utf8') > maxBytes) {
                tooLarge = true;
                sendJson(res, 413, { message: 'Request too large.' });
            }
        });

        req.on('end', () => {
            if (tooLarge) {
                resolve(null);
                return;
            }

            resolve(body);
        });

        req.on('error', reject);
    });
}

function handleAccountRequest(req, res, dependencies) {
    const { db, bcrypt, crypto, sessions, SESSION_DURATION } = dependencies;
    const route = req.url.split('?')[0];

    if (req.method === 'POST' && route === '/register') {
        register(req, res, db, bcrypt);
        return true;
    }

    if (req.method === 'POST' && route === '/login') {
        login(req, res, db, bcrypt, crypto, sessions, SESSION_DURATION);
        return true;
    }

    if (req.method === 'POST' && route === '/logout') {
        const cookie = (req.headers.cookie || '')
            .split(';')
            .map(item => item.trim())
            .find(item => item.startsWith('onlineopoly_session='));

        if (cookie) {
            let sessionId = cookie.substring('onlineopoly_session='.length);
            try {
                sessionId = decodeURIComponent(sessionId);
            } catch (error) {
                // A malformed cookie cannot identify a valid session.
            }

            const session = sessions.get(sessionId);
            if (session) {
                sessions.delete(sessionId);
                if (dependencies.io) {
                    for (const socket of dependencies.io.sockets.sockets.values()) {
                        if (socket.data.sessionId === sessionId) {
                            socket.disconnect(true);
                        }
                    }
                }
            }
        }

        sendJson(res, 200, { message: 'You have been logged out.' }, {
            'Set-Cookie':
                'onlineopoly_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
            'Cache-Control': 'no-store'
        });
        return true;
    }

    if (req.method === 'POST' && route === '/avatar') {
        saveAvatar(req, res, db, sessions);
        return true;
    }

    if (req.method === 'POST' && route === '/avatar-upload') {
        saveUploadedAvatar(req, res, db, sessions);
        return true;
    }

    if (req.method === 'GET' && route === '/session') {
        const session = getSession(req, sessions);

        if (!session) {
            sendJson(res, 401, {
                loggedIn: false,
                message: 'You are not logged in or your session has expired.'
            });
            return true;
        }

        db.query(
            'SELECT `avatar_path` FROM `User` WHERE `user_id` = ?',
            [session.userId],
            (err, results) => {
                if (err) {
                    sendJson(res, 500, {
                        message: 'Could not load your account details.'
                    });
                    return;
                }

                sendJson(res, 200, {
                    loggedIn: true,
                    userId: session.userId,
                    username: session.username,
                    avatarPath: results[0]?.avatar_path || null
                });
            }
        );

        return true;
    }

    return false;
}

async function saveAvatar(req, res, db, sessions) {
    const session = getSession(req, sessions);

    if (!session) {
        sendJson(res, 401, {
            message: 'Please log in before saving an avatar.'
        });
        return;
    }

    try {
        const body = await readBody(req, res);

        if (body === null) {
            return;
        }

        const { avatarPath } = JSON.parse(body);
        const allowedAvatarPaths = [
            '/Game/sprites/Hat.png',
            '/Game/sprites/Car.png',
            '/Game/sprites/Dog.png',
            '/Game/sprites/Battleship.png',
            '/Game/sprites/Thimble.png',
            '/Game/sprites/Boot.png',
            '/Game/sprites/cat.png',
            '/Game/sprites/Wheelbarrow.png',
            '/Game/sprites/duck.png',
            '/Game/sprites/windmill.png'
        ];

        if (!allowedAvatarPaths.includes(avatarPath)) {
            sendJson(res, 400, {
                message: 'Choose one of the available game-piece images.'
            });
            return;
        }

        db.query(
            'UPDATE `User` SET `avatar_path` = ? WHERE `user_id` = ?',
            [avatarPath, session.userId],
            err => {
                if (err) {
                    sendJson(res, 500, {
                        message: 'Could not save your avatar.'
                    });
                    return;
                }

                sendJson(res, 200, {
                    message: 'Avatar saved.',
                    avatarPath
                });
            }
        );
    } catch (error) {
        if (!res.writableEnded) {
            sendJson(res, 400, {
                message: 'Invalid avatar request.'
            });
        }
    }
}

async function saveUploadedAvatar(req, res, db, sessions) {
    const session = getSession(req, sessions);

    if (!session) {
        sendJson(res, 401, {
            message: 'Please log in before saving an avatar.'
        });
        return;
    }

    try {
        const body = await readBody(req, res, 7 * 1024 * 1024);

        if (body === null) {
            return;
        }

        const { imageData } = JSON.parse(body);
        const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
            imageData
        );

        if (!match) {
            sendJson(res, 400, {
                message: 'Choose a PNG, JPEG, or WebP image.'
            });
            return;
        }

        const [, imageType, base64Data] = match;
        const imageBuffer = Buffer.from(base64Data, 'base64');

        if (imageBuffer.length === 0 || imageBuffer.length > 5 * 1024 * 1024) {
            sendJson(res, 400, {
                message: 'Choose an image smaller than 5 MB.'
            });
            return;
        }

        const isPng =
            imageType === 'png' &&
            imageBuffer.subarray(0, 8).equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
            );
        const isJpeg =
            imageType === 'jpeg' &&
            imageBuffer[0] === 0xff &&
            imageBuffer[1] === 0xd8 &&
            imageBuffer[2] === 0xff;
        const isWebp =
            imageType === 'webp' &&
            imageBuffer.toString('ascii', 0, 4) === 'RIFF' &&
            imageBuffer.toString('ascii', 8, 12) === 'WEBP';

        if (!isPng && !isJpeg && !isWebp) {
            sendJson(res, 400, {
                message: 'The selected file is not a valid supported image.'
            });
            return;
        }

        const extension = imageType === 'jpeg' ? 'jpg' : imageType;
        const filename = `avatar-upload-${session.userId}.${extension}`;
        const filePath = path.join(
            __dirname,
            '..',
            '..',
            'client',
            'Game',
            'sprites',
            filename
        );
        const avatarPath = `/Game/sprites/${filename}`;

        await fs.promises.writeFile(filePath, imageBuffer);

        db.query(
            'UPDATE `User` SET `avatar_path` = ? WHERE `user_id` = ?',
            [avatarPath, session.userId],
            err => {
                if (err) {
                    sendJson(res, 500, {
                        message: 'Could not save your avatar.'
                    });
                    return;
                }

                sendJson(res, 200, {
                    message: 'Avatar saved.',
                    avatarPath
                });
            }
        );
    } catch (error) {
        if (!res.writableEnded) {
            sendJson(res, 400, {
                message: 'Could not process the uploaded image.'
            });
        }
    }
}

async function register(req, res, db, bcrypt) {
    try {
        const body = await readBody(req, res);
        if (body === null) return;

        const { username, password } = JSON.parse(body);

        if (
            typeof username !== 'string' ||
            typeof password !== 'string' ||
            !username.trim() ||
            password.length < 8 ||
            Buffer.byteLength(password, 'utf8') > 72
        ) {
            sendJson(res, 400, {
                message: 'Enter a username and a password of 8–72 bytes.'
            });
            return;
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        db.query(
            'INSERT INTO `User` (username, password) VALUES (?, ?)',
            [username.trim(), hashedPassword],
            err => {
                if (err) {
                    const duplicate = err.code === 'ER_DUP_ENTRY';

                    sendJson(res, duplicate ? 409 : 500, {
                        message: duplicate
                            ? 'That username is already taken.'
                            : 'Could not create your account.'
                    });
                    return;
                }

                sendJson(res, 201, {
                    message: 'Account created successfully!'
                });
            }
        );
    } catch (err) {
        if (!res.writableEnded) {
            sendJson(res, 400, {
                message: 'Invalid registration request.'
            });
        }
    }
}

async function login(
    req, res, db, bcrypt, crypto, sessions, SESSION_DURATION
) {
    try {
        const body = await readBody(req, res);
        if (body === null) return;

        const { username, password } = JSON.parse(body);

        if (
            typeof username !== 'string' ||
            typeof password !== 'string' ||
            !username.trim() ||
            !password
        ) {
            sendJson(res, 400, {
                message: 'Enter your username and password.'
            });
            return;
        }

        db.query(
            'SELECT user_id, username, password FROM `User` WHERE username = ?',
            [username.trim()],
            async (err, results) => {
                if (err) {
                    sendJson(res, 500, {
                        message: 'Login could not be completed.'
                    });
                    return;
                }

                if (results.length === 0) {
                    sendJson(res, 401, {
                        message: 'Invalid username or password.'
                    });
                    return;
                }

                try {
                    const user = results[0];
                    const matches = await bcrypt.compare(
                        password,
                        user.password
                    );

                    if (!matches) {
                        sendJson(res, 401, {
                            message: 'Invalid username or password.'
                        });
                        return;
                    }

                    const sessionId = crypto.randomBytes(32).toString('hex');

                    sessions.set(sessionId, {
                        userId: user.user_id,
                        username: user.username,
                        expiresAt: Date.now() + SESSION_DURATION
                    });

                    sendJson(res, 200, {
                        message: `Welcome back, ${user.username}!`,
                        userId: user.user_id
                    }, {
                        'Set-Cookie':
                            `onlineopoly_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
                    });
                } catch (error) {
                    if (!res.writableEnded) {
                        sendJson(res, 500, {
                            message: 'Login could not be completed.'
                        });
                    }
                }
            }
        );
    } catch (error) {
        if (!res.writableEnded) {
            sendJson(res, 400, {
                message: 'Invalid login request.'
            });
        }
    }
}

module.exports = handleAccountRequest;
