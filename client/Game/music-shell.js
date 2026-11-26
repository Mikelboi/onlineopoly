(() => {
    const appFrame = document.getElementById('app-content');
    let firstPageLoad = true;

    function getFrameUrl() {
        const contentLocation = appFrame.contentWindow.location;
        return `${contentLocation.pathname}${contentLocation.search}${contentLocation.hash}`;
    }

    appFrame.addEventListener('load', () => {
        const frameUrl = getFrameUrl();
        const currentUrl =
            `${window.location.pathname}${window.location.search}${window.location.hash}`;

        if (frameUrl !== currentUrl) {
            if (firstPageLoad) {
                window.history.replaceState({ musicShell: true }, '', frameUrl);
            } else {
                window.history.pushState({ musicShell: true }, '', frameUrl);
            }
        }

        firstPageLoad = false;
        document.title = appFrame.contentDocument.title || 'Onlineopoly';
        window.dispatchEvent(new CustomEvent('onlineopoly:pagechange', {
            detail: {
                pathname: appFrame.contentWindow.location.pathname
            }
        }));
    });

    window.addEventListener('popstate', () => {
        appFrame.src =
            `${window.location.pathname}${window.location.search}${window.location.hash}`;
    });
})();
