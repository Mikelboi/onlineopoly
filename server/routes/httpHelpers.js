function sendJson(res, status, data, headers = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...headers
    });
    res.end(JSON.stringify(data));
}

function getSession(req, sessions, decodeSessionId = false) {
    const cookies = (req.headers.cookie || '').split(';');
    const cookie = cookies
        .map(item => item.trim())
        .find(item => item.startsWith('onlineopoly_session='));

    if (!cookie) return null;

    let sessionId = cookie.substring('onlineopoly_session='.length);
    if (decodeSessionId) {
        sessionId = decodeURIComponent(sessionId);
    }

    const session = sessions.get(sessionId);

    if (!session || session.expiresAt <= Date.now()) {
        if (session) sessions.delete(sessionId);
        return null;
    }

    return session;
}

module.exports = { sendJson, getSession };
