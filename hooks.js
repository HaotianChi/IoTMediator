'use strict';

// Unified ingress for simulator/device stream items.
// Both events and commands are routed to one handler so replay behavior
// matches the online pipeline path.
let streamHandler = async ({next}) => {
    if (typeof next === 'function') {
        await next();
    }
    return {allowed: true};
};

function setStreamHandler(fn) {
    streamHandler = fn;
}

async function runStreamHandler(kind, payload, onAllow) {
    let forwarded = false;
    const next = async () => {
        forwarded = true;
        if (typeof onAllow === 'function') {
            await onAllow();
        }
    };
    try {
        const handlerResult = await streamHandler({kind, payload, next});
        // Keep backwards compatibility (`allowed`), while preserving
        // simulator-facing metadata (observation/decisions/forwarded).
        const declaredAllowed = handlerResult && typeof handlerResult.allowed === 'boolean'
            ? handlerResult.allowed
            : undefined;
        const allowed = declaredAllowed !== undefined ? declaredAllowed : forwarded;
        if (handlerResult && typeof handlerResult === 'object') {
            return { allowed, forwarded, ...handlerResult };
        }
        return { allowed, forwarded };
    } catch (err) {
        console.error(`${kind} stream_handler error:`, err);
        return {allowed: false, reason: 'hook_error'};
    }
}

async function handleDeviceEvent(event, onAllow) {
    return runStreamHandler('event', event, onAllow);
}

async function handlePlatformCommand(command, onAllow) {
    return runStreamHandler('command', command, onAllow);
}

module.exports = {
    setStreamHandler,
    handleDeviceEvent,
    handlePlatformCommand,
};
