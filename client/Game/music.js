(() => {
    // The persistent player belongs to the outer page, not the game iframe.
    if (window.top !== window.self) {
        document.getElementById('menu-music-toggle')?.setAttribute('hidden', '');
        const pageMusicButton = document.getElementById('music-toggle');
        const isBoardPage = window.location.pathname === '/board';

        if (pageMusicButton) {
            pageMusicButton.hidden = !isBoardPage;

            if (isBoardPage) {
                pageMusicButton.addEventListener('click', event => {
                    event.stopPropagation();
                    window.parent.postMessage(
                        { type: 'onlineopoly-music-toggle' },
                        window.location.origin
                    );
                });
            }
        }

        window.addEventListener('message', event => {
            if (
                event.origin === window.location.origin &&
                event.source === window.parent &&
                event.data?.type === 'onlineopoly-music-state' &&
                pageMusicButton
            ) {
                pageMusicButton.textContent = event.data.isPlaying
                    ? 'Music: On'
                    : 'Music: Off';
                pageMusicButton.setAttribute(
                    'aria-pressed',
                    String(event.data.isPlaying)
                );
            }
        });

        const requestPlayback = event => {
            if (event.target.closest?.('#music-toggle')) {
                return;
            }

            const startParentMusic =
                window.parent.onlineopolyStartMusicFromGesture;

            if (typeof startParentMusic === 'function') {
                startParentMusic();
                return;
            }

            window.parent.postMessage(
                { type: 'onlineopoly-music-user-gesture' },
                window.location.origin
            );
        };

        document.addEventListener('pointerdown', requestPlayback, {
            passive: true
        });
        document.addEventListener('keydown', requestPlayback);
        return;
    }

    const positionKey = 'onlineopolyMusicPosition';
    const positionTrackKey = 'onlineopolyMusicPositionTrack';
    const preferenceKey = 'onlineopolyMusicEnabled';
    const menuTrack =
        '/Game/Audio/Monopoly%20Tycoon%20OST%20-%201960s%20Theme.mp3';
    const boardTrack =
        '/Game/Audio/Monopoly%20%281995%20PC%20Game%29%20Soundtrack%207.%20Passin%27%20Go%20%2B%20Download.mp3';
    const loginTrack =
        '/Game/Audio/Monopoly%20Tycoon%20OST%20-%201940s%20Theme.mp3';
    const auctionTrack = '/Game/Audio/Monopoly - Bidding War.mp3';
    const music = new Audio();
    const musicButton = document.createElement('button');
    let musicEnabled = true;
    let activeTrack = '';
    let auctionMusicSnapshot = null;

    localStorage.setItem(preferenceKey, 'true');
    music.autoplay = true;
    music.loop = true;
    music.volume = 0.25;

    musicButton.type = 'button';
    musicButton.id = 'persistent-music-toggle';
    musicButton.style.cssText = [
        'position:fixed',
        'top:16px',
        'right:16px',
        'z-index:10000',
        'padding:9px 14px',
        'border:2px solid #356b43',
        'border-radius:8px',
        'background:#fff',
        'color:#222',
        'font-weight:bold',
        'cursor:pointer',
        'box-shadow:0 2px 6px rgba(0,0,0,.18)'
    ].join(';');
    document.body.appendChild(musicButton);

    function updateButton() {
        const isEnabled = musicEnabled;
        musicButton.textContent = isEnabled ? 'Music: On' : 'Music: Off';
        musicButton.setAttribute('aria-pressed', String(isEnabled));

        const boardMusicButton = document
            .getElementById('app-content')
            ?.contentDocument
            ?.getElementById('music-toggle');

        if (boardMusicButton) {
            boardMusicButton.textContent = isEnabled
                ? 'Music: On'
                : 'Music: Off';
            boardMusicButton.setAttribute('aria-pressed', String(isEnabled));
        }
    }

    function updateMusicControlLocation(pathname) {
        const isBoardPage = pathname === '/board';
        const isRulesPage = pathname === '/rules';
        const appFrame = document.getElementById('app-content');
        const boardMusicButton = appFrame
            ?.contentDocument
            ?.getElementById('music-toggle');

        // Use the board's own music control beside its sound effects button.
        musicButton.hidden = isBoardPage;
        musicButton.style.bottom = isRulesPage ? '16px' : 'auto';
        musicButton.style.top = isRulesPage ? 'auto' : '16px';
        musicButton.style.left = 'auto';
        musicButton.style.right = '16px';
        if (boardMusicButton) {
            boardMusicButton.hidden = !isBoardPage;
        }
        updateButton();
    }

    function savePosition() {
        if (activeTrack && Number.isFinite(music.currentTime)) {
            sessionStorage.setItem(positionKey, String(music.currentTime));
            sessionStorage.setItem(positionTrackKey, activeTrack);
        }
    }

    function playMusic() {
        if (musicEnabled) {
            music.loop = true;
            music.play().catch(updateButton);
        }
    }

    // Call synchronously from a click or key press inside the app iframe so
    // browsers can use that gesture to permit audio playback in this page.
    window.onlineopolyStartMusicFromGesture = () => {
        if (musicEnabled && music.paused) {
            playMusic();
        }
    };

    function startAuctionMusic() {
        if (auctionMusicSnapshot) {
            return;
        }

        savePosition();
        auctionMusicSnapshot = {
            source: music.src,
            track: activeTrack,
            time: music.currentTime
        };
        activeTrack = auctionTrack;
        music.pause();
        music.src = auctionTrack;
        music.loop = true;
        music.load();
        music.addEventListener('loadedmetadata', () => {
            if (auctionMusicSnapshot && activeTrack === auctionTrack) {
                playMusic();
            }
        }, { once: true });
    }

    function stopAuctionMusic(restorePreviousTrack = true) {
        if (!auctionMusicSnapshot) {
            return;
        }

        const snapshot = auctionMusicSnapshot;
        auctionMusicSnapshot = null;
        music.pause();
        music.loop = false;

        if (!restorePreviousTrack) {
            activeTrack = '';
            return;
        }

        if (!snapshot.source) {
            activeTrack = '';
            useTrackForPage(window.location.pathname);
            return;
        }

        activeTrack = snapshot.track;
        music.src = snapshot.source;
        music.loop = true;
        music.load();
        music.addEventListener('loadedmetadata', () => {
            if (Number.isFinite(snapshot.time) && snapshot.time > 0) {
                music.currentTime = Number.isFinite(music.duration) && music.duration > 0
                    ? snapshot.time % music.duration
                    : snapshot.time;
            }

            if (activeTrack) {
                sessionStorage.setItem(positionKey, String(music.currentTime));
                sessionStorage.setItem(positionTrackKey, activeTrack);
            }
            playMusic();
        }, { once: true });
    }

    function useTrackForPage(pathname) {
        let requestedTrack = menuTrack;

        if (pathname === '/' || pathname === '/login') {
            requestedTrack = loginTrack;
        } else if (pathname === '/board') {
            requestedTrack = boardTrack;
        }

        const trackUrl = new URL(requestedTrack, window.location.origin).href;
        music.loop = true;

        if (music.src === trackUrl) {
            playMusic();
            return;
        }

        const savedPosition =
            sessionStorage.getItem(positionTrackKey) === requestedTrack
                ? Number(sessionStorage.getItem(positionKey))
                : 0;
        activeTrack = requestedTrack;
        music.src = requestedTrack;
        music.load();
        music.addEventListener('loadedmetadata', () => {
            if (
                Number.isFinite(savedPosition) &&
                savedPosition > 0 &&
                Number.isFinite(music.duration) &&
                music.duration > 0
            ) {
                music.currentTime = savedPosition % music.duration;
            }

            playMusic();
        }, { once: true });
    }

    updateMusicControlLocation(window.location.pathname);
    useTrackForPage(window.location.pathname);
    music.addEventListener('timeupdate', savePosition);
    window.addEventListener('pagehide', savePosition);
    window.addEventListener('onlineopoly:pagechange', event => {
        if (auctionMusicSnapshot && event.detail.pathname !== '/board') {
            stopAuctionMusic(false);
        }
        updateMusicControlLocation(event.detail.pathname);
        useTrackForPage(event.detail.pathname);
    });
    window.addEventListener('resize', () => {
        updateMusicControlLocation(window.location.pathname);
    });

    music.addEventListener('play', updateButton);
    music.addEventListener('pause', updateButton);
    music.addEventListener('ended', () => {
        if (musicEnabled) {
            music.loop = true;
            music.currentTime = 0;
            playMusic();
        }
    });

    function toggleMusic() {
        if (!musicEnabled || music.paused) {
            musicEnabled = true;
            localStorage.setItem(preferenceKey, 'true');
            playMusic();
        } else {
            musicEnabled = false;
            localStorage.setItem(preferenceKey, 'false');
            music.pause();
            savePosition();
            updateButton();
        }
    }

    musicButton.addEventListener('click', toggleMusic);

    updateButton();

    window.addEventListener('message', event => {
        const appFrame = document.getElementById('app-content');
        const validAppMessage =
            event.origin === window.location.origin &&
            event.source === appFrame?.contentWindow;

        if (
            validAppMessage &&
            event.data?.type === 'onlineopoly-music-toggle'
        ) {
            toggleMusic();
            return;
        }

        if (
            validAppMessage &&
            event.data?.type === 'onlineopoly-music-user-gesture' &&
            musicEnabled &&
            music.paused
        ) {
            playMusic();
            return;
        }

        if (
            validAppMessage &&
            event.data?.type === 'onlineopoly-auction-music-start'
        ) {
            startAuctionMusic();
            return;
        }

        if (
            validAppMessage &&
            event.data?.type === 'onlineopoly-auction-music-stop'
        ) {
            stopAuctionMusic();
        }
    });
})();
