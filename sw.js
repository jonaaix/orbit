const CACHE = 'orbit-v1';

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
        .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
        .then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'skip-waiting') {
        self.skipWaiting();
    }
});

function remember(request, response) {
    if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
}

// ----- Relay resources: answered by a window that holds the tunnel -----

const RELAY_SEGMENT = '~relay/';
const RELAY_DOWNLOAD_PARAM = '~download';
const RELAY_ACCEPT_TIMEOUT_MS = 3000;
const RELAY_HEAD_TIMEOUT_MS = 60000;
const RELAY_BUFFERED_CHUNKS = 4;
const RELAY_REQUEST_HEADERS = ['accept', 'range', 'if-range', 'if-none-match', 'if-modified-since'];
const RELAY_PAGE_SANDBOX = new Set(['allow-scripts', 'allow-forms', 'allow-popups', 'allow-modals', 'allow-downloads']);
const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

function relayTarget(url) {
    const prefix = `${new URL(self.registration.scope).pathname}${RELAY_SEGMENT}`;
    if (!url.pathname.startsWith(prefix)) {
        return null;
    }
    const match = /^([^/]+)\/api\/(.*)$/s.exec(url.pathname.slice(prefix.length));
    if (!match) {
        return { serverId: null, path: '', download: null };
    }
    const params = new URLSearchParams(url.search);
    const download = params.get(RELAY_DOWNLOAD_PARAM);
    params.delete(RELAY_DOWNLOAD_PARAM);
    const query = params.toString();
    return { serverId: decodeURIComponent(match[1]), path: query ? `${match[2]}?${query}` : match[2], download };
}

function attachment(existing, filename) {
    if (filename) {
        return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    return existing ? existing.replace(/^\s*inline\b/i, 'attachment') : 'attachment';
}

function relayExchange(port) {
    const early = [];
    let waiting = null;
    port.onmessage = (event) => {
        if (waiting) {
            const resolve = waiting;
            waiting = null;
            resolve(event.data);
        }
        else {
            early.push(event.data);
        }
    };
    return {
        post: message => port.postMessage(message),
        next: (timeoutMs) => {
            const message = early.length > 0 ? Promise.resolve(early.shift()) : new Promise((resolve) => { waiting = resolve; });
            if (!timeoutMs) {
                return message;
            }
            return Promise.race([message, new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))]);
        },
        close: () => port.close(),
    };
}

async function relayWindows(clientId) {
    const windows = (await self.clients.matchAll({ type: 'window' }))
        .filter(client => client.frameType === 'top-level' && !client.url.startsWith(`${self.registration.scope}${RELAY_SEGMENT}`));
    const rank = client => (client.id === clientId ? 0 : client.visibilityState === 'visible' ? 1 : 2);
    return windows.sort((a, b) => rank(a) - rank(b));
}

function relayPolicy(headers) {
    const policy = headers.get('content-security-policy') || '';
    const sandbox = policy.split(';').map(directive => directive.trim().toLowerCase().split(/\s+/)).find(directive => directive[0] === 'sandbox');
    if (sandbox && sandbox.slice(1).every(token => RELAY_PAGE_SANDBOX.has(token))) {
        return policy;
    }
    // Browsers refuse to show a PDF in a sandboxed document; the chat leaves PDFs unsandboxed for the same reason.
    if (!sandbox && (headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'application/pdf') {
        return policy || null;
    }
    return 'sandbox';
}

function relayHeaders(entries, download) {
    const headers = new Headers(entries);
    headers.delete('set-cookie');
    if (download !== null) {
        headers.set('content-disposition', attachment(headers.get('content-disposition'), download));
    }
    const policy = relayPolicy(headers);
    if (policy) {
        headers.set('content-security-policy', policy);
    }
    headers.set('x-content-type-options', 'nosniff');
    return headers;
}

function relayBody(exchange, finish) {
    return new ReadableStream({
        async pull(controller) {
            exchange.post({ type: 'pull' });
            const message = await exchange.next();
            if (message && message.type === 'chunk') {
                controller.enqueue(new Uint8Array(message.data));
                return;
            }
            if (message && message.type === 'end') {
                controller.close();
            }
            else {
                controller.error(new Error('The relay resource broke off'));
            }
            exchange.close();
            finish();
        },
        cancel() {
            exchange.post({ type: 'cancel' });
            exchange.close();
            finish();
        },
    }, new CountQueuingStrategy({ highWaterMark: RELAY_BUFFERED_CHUNKS }));
}

function relayFailure(status) {
    return new Response(null, { status, headers: { 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff' } });
}

async function relayResource(event, target, finish) {
    const request = event.request;
    if (!target.serverId) {
        return relayFailure(404);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return relayFailure(405);
    }
    const headers = {};
    for (const name of RELAY_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) {
            headers[name] = value;
        }
    }
    for (const client of await relayWindows(event.clientId || event.resultingClientId)) {
        const channel = new MessageChannel();
        const exchange = relayExchange(channel.port1);
        client.postMessage({ type: 'relay-request', serverId: target.serverId, path: target.path, method: request.method, headers }, [channel.port2]);
        const accepted = await exchange.next(RELAY_ACCEPT_TIMEOUT_MS);
        if (!accepted || accepted.type !== 'accepted') {
            exchange.close();
            continue;
        }
        const head = await exchange.next(RELAY_HEAD_TIMEOUT_MS);
        if (!head || head.type !== 'head') {
            exchange.close();
            return relayFailure(503);
        }
        const bodyless = request.method === 'HEAD' || BODYLESS_STATUSES.has(head.status);
        if (bodyless) {
            exchange.post({ type: 'cancel' });
            exchange.close();
        }
        return new Response(bodyless ? null : relayBody(exchange, finish), { status: head.status, headers: relayHeaders(head.headers, target.download) });
    }
    return relayFailure(503);
}

function answerRelayResource(event, target) {
    let finish;
    event.waitUntil(new Promise((resolve) => { finish = resolve; }));
    event.respondWith(relayResource(event, target, finish).then(
        (response) => {
            if (!response.body) {
                finish();
            }
            return response;
        },
        () => {
            finish();
            return relayFailure(503);
        },
    ));
}

// ----- Fetch routing -----

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    const relay = url.origin === self.location.origin ? relayTarget(url) : null;
    if (relay) {
        answerRelayResource(event, relay);
        return;
    }
    if (request.method !== 'GET' || url.origin !== self.location.origin) {
        return;
    }
    if (request.mode === 'navigate') {
        const shell = self.registration.scope;
        event.respondWith(fetch(request).then(response => remember(shell, response)).catch(() => caches.match(shell)));
        return;
    }
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => remember(request, response))));
});

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const scope = self.registration.scope;
    const server = data.hubRef ? `?server=${encodeURIComponent(data.hubRef)}` : '';
    event.waitUntil(self.registration.showNotification(data.title || 'Orbit', {
        body: data.body || '',
        tag: data.conversationId,
        icon: `${scope}icons/icon-192.png`,
        data: { target: `${scope}${server}#/c/${data.conversationId || ''}` },
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.target) || self.registration.scope;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
        const open = windows[0];
        return open ? open.navigate(target).then(client => client && client.focus()) : self.clients.openWindow(target);
    }));
});
