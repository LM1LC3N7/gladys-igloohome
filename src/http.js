// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTPS request to the
// igloohome cloud on node:https (certificates checked by Node, as always). A
// deadline for the whole exchange, a size cap on the body (one buffer
// allocated once, filled in place), no redirect followed, no keep-alive, no
// User-Agent of an app. Resolves { status, headers, body } for any status;
// rejects an IglooError for the transport failures, with `sent` true as soon
// as the TLS connection was up (the request may then have reached igloohome).
// `sendWithin`: the connection must be up within this many ms, else nothing
// is written (a command never leaves late). `beforeSend`: the last check of a
// command, once connected, right before the first byte is written.
// Headers and bodies carry the client secret or the token: never logged,
// never put in an error. Adapted from LM1LC3N7/gladys-ismartgate (same
// author, Apache-2.0).
// -----------------------------------------------------------------------------

import https from 'node:https';

/**
 * The failures, by kind. Messages are our own words only: never a header, a
 * body, a token, a secret.
 * - timeout:      no complete answer in time
 * - unreachable:  no connection, or a connection lost
 * - late:         a command could not leave before its deadline (nothing sent)
 * - busy:         HTTP 429 or 5xx (a pause)
 * - auth:         the client id or the secret refused (token endpoint)
 * - scope:        the API client lacks a scope this integration needs
 * - unauthorized: HTTP 401 of the API (the token)
 * - forbidden:    HTTP 403 of the API
 * - notFound:     HTTP 404 of the API
 * - http:         another HTTP status
 * - invalid:      an answer not understood (not JSON, fields missing)
 * - tooLarge:     the answer exceeds the size cap
 */
export class IglooError extends Error {
  constructor(kind, { status, sent = false, retryAfter } = {}) {
    super(status ? `${kind} (HTTP ${status})` : kind);
    this.name = 'IglooError';
    this.kind = kind;
    this.status = status;
    this.sent = sent;
    this.retryAfter = retryAfter;
  }
}

/** A short reason for the logs and the user: the kind, and the status if any. */
export const reasonOf = (err) => (err instanceof IglooError ? err.message : 'unexpected error');

/**
 * @param {object} options
 * @param {'GET'|'POST'} options.method
 * @param {string} options.url an https URL
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.beforeSend] if it throws, nothing is sent and
 *   its error is passed on with `beforeSend` set
 */
export function httpsRequest({
  method,
  url,
  headers = {},
  body,
  timeout,
  sendWithin,
  maxBytes,
  beforeSend,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let connected = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new IglooError('timeout', { sent: connected })),
      Math.max(0, timeout),
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(
            () => {
              if (!connected) {
                finish(new IglooError('late'));
              }
            },
            Math.max(0, sendWithin),
          );
    const markConnected = () => {
      if (connected || settled) {
        return;
      }
      clearTimeout(sendTimer);
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          err.sent = false;
          finish(err);
          return;
        }
      }
      connected = true;
      req.end(body);
    };

    try {
      const target = new URL(url);
      if (target.protocol !== 'https:') {
        finish(new IglooError('unreachable'));
        return;
      }
      req = https.request(target, {
        method,
        agent: false,
        headers: {
          accept: 'application/json',
          connection: 'close',
          ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      });
      req.on('response', (res) => {
        const chunks = Buffer.allocUnsafe(maxBytes);
        let size = 0;
        res.on('data', (chunk) => {
          if (size + chunk.length > maxBytes) {
            finish(new IglooError('tooLarge', { sent: true }));
            return;
          }
          chunk.copy(chunks, size);
          size += chunk.length;
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: chunks.subarray(0, size),
          }),
        );
        res.on('error', () => finish(new IglooError('unreachable', { sent: true })));
      });
      req.on('socket', (socket) => {
        // The request leaves once TLS is up: the secret never goes before.
        if (socket.encrypted && !socket.connecting && socket.authorized !== undefined) {
          markConnected();
        } else {
          socket.once('secureConnect', markConnected);
        }
      });
      req.on('error', () => finish(new IglooError('unreachable', { sent: connected })));
    } catch {
      // A URL or a header refused: a failure, never a crash.
      finish(new IglooError('unreachable'));
    }
  });
}
