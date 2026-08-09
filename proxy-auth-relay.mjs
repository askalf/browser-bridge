// ════════════════════════════════════════════════════════════════════
// Authenticated upstream proxy support.
//
// Chromium cannot authenticate to a proxy from the command line. Credentials
// embedded in --proxy-server (http://user:pass@host) are parsed off and
// discarded, and there is no --proxy-auth flag; the browser expects to answer
// the 407 interactively. That leaves every authenticated proxy — which is to
// say every commercial residential/rotating proxy, and any VPN sidecar with
// auth switched on — unreachable from a headless container.
//
// The usual workaround is puppeteer's page.authenticate(), but that enables
// the CDP Fetch domain on each page. browser-bridge exists to be driven by
// EXTERNAL CDP clients, and a client calling setRequestInterception would then
// be fighting us for the same domain. Breaking request interception to gain
// proxy auth is a bad trade for this image specifically.
//
// So instead: a loopback relay. Chromium points at 127.0.0.1, unauthenticated;
// the relay adds Proxy-Authorization and forwards upstream. Chromium's network
// stack is untouched, no CDP domain is claimed, and external clients keep full
// use of Fetch and Network.
//
// The relay binds loopback only. It is deliberately an open proxy — anything
// that can reach it can use the upstream credentials — so it must never be
// exposed beyond the container.
// ════════════════════════════════════════════════════════════════════

import http from 'node:http';
import net from 'node:net';

// Mask a `user:pass@` authority in a string that may not be a valid URL.
// Anything between `//` (or the start) and the last `@` is treated as
// credentials, since that is how the authority is delimited regardless of
// whether the rest of the URL parses.
function redactAuthority(value) {
  return value.replace(/(^|\/\/)([^/@]*):([^/@]*)@/, (_m, lead, user) => `${lead}${user}:***@`);
}

/**
 * Split a proxy URL into its parts, separating credentials from the address.
 *
 * Deliberately lenient about everything EXCEPT credentials. Chromium's
 * --proxy-server takes forms this does not model — bare `host:port`,
 * `socks5://…`, per-scheme rule lists — and those worked before the relay
 * existed. Anything without credentials is therefore handed to Chromium
 * exactly as the operator wrote it, and only a credentialed URL has to be
 * something the relay can actually serve.
 *
 * @param {string} raw  e.g. http://user:pass@10.0.0.2:1082
 * @returns {{host: string, port: number, username: string, password: string,
 *            hasCredentials: boolean, proxyArg: string, redacted: string}}
 */
export function parseProxyUrl(raw) {
  const value = String(raw).trim();
  const passthrough = {
    host: '', port: 0, username: '', password: '',
    hasCredentials: false,
    proxyArg: value,
    // Blunt-instrument redaction for the branch where the URL did NOT parse.
    // A malformed URL is exactly when a password is most likely to be sitting
    // in the string — a bad port, a stray character — and printing the raw
    // value there would leak it to the logs at the first sign of trouble.
    redacted: redactAuthority(value),
  };

  // A bare host:port is valid for --proxy-server but not for URL.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return passthrough;
  }
  if (!url.hostname) return passthrough;

  // URL percent-encodes credentials, so a password containing @ or : survives.
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  const hasCredentials = Boolean(username || password);
  if (!hasCredentials) return passthrough;

  if (url.protocol !== 'http:') {
    // An https proxy means TLS to the proxy itself and a SOCKS proxy means a
    // different protocol entirely; the relay speaks neither. Fail at startup
    // rather than at the first navigation, where it would look like a network
    // fault rather than a configuration one.
    throw new Error(
      `credentials in a ${url.protocol}// proxy URL are not supported `
      + '— the auth relay speaks plain http to the upstream proxy',
    );
  }

  const port = url.port ? Number(url.port) : 80;
  return {
    host: url.hostname,
    port,
    username,
    password,
    hasCredentials: true,
    // Credential-free address, for the (unused here) case of pointing a client
    // straight at the upstream.
    proxyArg: `${url.protocol}//${url.hostname}:${port}`,
    // Safe to log. The password never reaches stdout, container logs, or a
    // crash report — logs are the most common way a proxy credential leaks.
    redacted: `${url.protocol}//${username}:***@${url.hostname}:${port}`,
  };
}

function credentialHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// Headers that describe a single hop and must not be forwarded to the next one
// (RFC 9110 §7.6.1). `transfer-encoding` is the one that bites: Node has already
// decoded a chunked body by the time we see it, so passing the header along
// would tell the client to expect an encoding the bytes no longer carry.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// Copy a header bag, dropping the per-hop entries. Built on a null-prototype
// object so a header literally named `__proto__` or `constructor` is data
// rather than a prototype write.
function forwardableHeaders(headers) {
  const out = Object.create(null);
  for (const name of Object.keys(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = headers[name];
  }
  return out;
}

// Read up to the end of the upstream's response head, then hand back the head
// and whatever body bytes arrived with it.
function readResponseHead(socket, onHead, onFail) {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) {
      // A proxy that never terminates its head would otherwise buffer forever.
      if (buffer.length > 32768) {
        socket.removeListener('data', onData);
        onFail(new Error('upstream response head exceeded 32KB'));
      }
      return;
    }
    socket.removeListener('data', onData);
    onHead(buffer.subarray(0, end).toString('latin1'), buffer.subarray(end + 4));
  };
  socket.on('data', onData);
}

/**
 * Build the loopback relay. Call listen() on the returned server.
 *
 * @param {object} o
 * @param {string} o.host      upstream proxy host
 * @param {number} o.port      upstream proxy port
 * @param {string} o.username
 * @param {string} o.password
 * @param {(msg: string) => void} [o.log]
 * @returns {import('node:http').Server}
 */
export function createAuthRelay({ host, port, username, password, log = () => {} }) {
  const credential = credentialHeader(username, password);

  const server = http.createServer((req, res) => {
    // Chromium sends absolute-form requests for http:// URLs. Pass them
    // through unchanged apart from the credential.
    const upstream = http.request({
      host,
      port,
      method: req.method,
      path: req.url,
      headers: { ...forwardableHeaders(req.headers), 'proxy-authorization': credential },
      setHost: false,
    });

    upstream.on('response', (upstreamRes) => {
      // Header names here come from the origin server, which is remote and
      // untrusted — but relaying them is the entire job of a proxy, and this
      // one talks only to Chromium, the intended recipient. Node rejects
      // invalid header names and CR/LF in values, so response splitting isn't
      // reachable; what does need handling is the per-hop set, dropped above.
      res.writeHead(upstreamRes.statusCode, forwardableHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstream.on('error', (err) => {
      log(`upstream request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream proxy unreachable\n');
    });

    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());

    const upstream = net.connect(port, host, () => {
      upstream.write(
        `CONNECT ${req.url} HTTP/1.1\r\n`
        + `Host: ${req.url}\r\n`
        + `Proxy-Authorization: ${credential}\r\n`
        + 'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });

    const fail = (err) => {
      log(`CONNECT ${req.url} failed: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
      }
      upstream.destroy();
    };

    upstream.on('error', fail);

    readResponseHead(
      upstream,
      (responseHead, rest) => {
        const status = Number(responseHead.split(' ')[1]);
        if (status !== 200) {
          // Relay the upstream's own answer rather than inventing one — a 407
          // here means the credentials are wrong, and that should be legible
          // in the browser's error rather than flattened into a 502.
          log(`CONNECT ${req.url} refused upstream: ${responseHead.split('\r\n')[0]}`);
          clientSocket.end(`${responseHead}\r\n\r\n`);
          upstream.destroy();
          return;
        }

        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Bytes that arrived alongside the upstream head, and bytes Chromium
        // sent before the tunnel opened (the TLS ClientHello). Dropping either
        // stalls the handshake with no error to explain it.
        if (rest.length) clientSocket.write(rest);
        if (head && head.length) upstream.write(head);

        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
      fail,
    );
  });

  server.on('clientError', (_err, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/**
 * Start the relay on an ephemeral loopback port.
 *
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string}>}
 */
export function startAuthRelay(options) {
  const server = createAuthRelay(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0 — the kernel picks a free one. A fixed port would collide with
    // whatever else the image grows later, and nothing outside needs to guess it.
    server.listen(options.listenPort ?? 0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}
