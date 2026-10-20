function sendJson(res, status, data, headers = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...headers
    });
    res.end(JSON.stringify(data));
}

function readBody(req, res) {
    return new Promise((resolve, reject) => {
        let body = '';
        let tooLarge = false;

        req.on('data', chunk => {
            if (tooLarge) return;

            body += chunk;

            if (Buffer.byteLength(body, 'utf8') > 10000) {
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

function getSession(req, sessions) {
    const cookies = (req.headers.cookie || '').split(';');
    const cookie = cookies
        .map(item => item.trim())
        .find(item => item.startsWith('onlineopoly_session='));

    if (!cookie) return null;

    const sessionId = cookie.substring('onlineopoly_session='.length);
    const session = sessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
        if (session) sessions.delete(sessionId);
        return null;
    }

    return session;
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

    if (req.method === 'GET' && route === '/session') {
        const session = getSession(req, sessions);

        if (!session) {
            sendJson(res, 401, {
                loggedIn: false,
                message: 'You are not logged in or your session has expired.'
            });
            return true;
        }

        sendJson(res, 200, {
            loggedIn: true,
            userId: session.userId,
            username: session.username
        });

        return true;
    }

    return false;
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