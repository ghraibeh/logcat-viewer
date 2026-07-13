"""mitmproxy addon: print one JSON line per completed flow to stdout.

Loaded by AndroidLab's Network Intercept tab (Tier 2), run headlessly as:

    mitmdump -q -p <port> -s mitm_addon.py --set flow_detail=0 \
             --set connection_strategy=lazy

The parent process (``MitmdumpWorker`` in ``intercept.py``) reads stdout
line-by-line and rebuilds each request/response into a ``Flow``. Bodies are
capped and either sent as UTF-8 text or, when binary, ``base64:``-prefixed.

It also implements **TLS passthrough** (see below) so intercepting HTTPS never
strands the device offline — the same trick HTTP Toolkit uses.
"""
import base64
import json
import sys

MAX_BODY = 1_048_576


# --- TLS passthrough: keep cert-pinned / untrusting apps online --------------
# mitmproxy MITMs every TLS connection with its own CA. Any app that doesn't
# trust that CA (cert pinning, or simply no user CA installed — i.e. almost
# every app by default, incl. Play Store & Google apps) would have EVERY HTTPS
# connection killed at the handshake. Device-wide that looks like "no internet".
#
# Instead of breaking those connections we remember each server whose client
# rejected our cert and transparently *tunnel* future connections to it —
# decrypting only the apps that do trust the CA, and passing the rest through
# untouched. The first attempt to a pinned host still fails once; the app's
# retry is tunnelled and succeeds, so connectivity self-heals.
#
# Needs ``--set connection_strategy=lazy`` so mitmproxy can hand off a
# connection to a raw tunnel before it has established server-side TLS.
_passthrough = set()          # {(host, port)} that rejected our cert -> tunnel


def _server_addr(data):
    """The upstream (host, port) for a TLS hook's connection, or None."""
    try:
        return data.context.server.address
    except Exception:
        return None


def tls_clienthello(data):
    """Before intercepting: if this server previously rejected our cert, don't
    MITM it — let mitmproxy tunnel the connection through verbatim."""
    try:
        addr = _server_addr(data)
        if addr is not None and addr in _passthrough:
            data.ignore_connection = True
    except Exception:
        pass


def tls_failed_client(data):
    """The client refused our cert (pinning / untrusted CA). Remember this
    server so the next connection to it is passed through instead of broken."""
    try:
        addr = _server_addr(data)
        if addr is not None:
            _passthrough.add(addr)
    except Exception:
        pass


def _body(content):
    """Return (encoded_body_or_None, true_size, truncated)."""
    if not content:
        return None, 0, False
    size = len(content)
    clip = content[:MAX_BODY]
    try:
        return clip.decode("utf-8"), size, size > MAX_BODY
    except UnicodeDecodeError:
        return "base64:" + base64.b64encode(clip).decode("ascii"), size, size > MAX_BODY


def _content(msg):
    """Content-Encoding-decoded body (gzip/br/zstd handled by mitmproxy),
    falling back to the raw bytes if decoding fails."""
    try:
        return msg.get_content(strict=False)
    except Exception:
        return msg.raw_content


def response(flow):
    try:
        req = flow.request
        resp = flow.response
        req_body, req_size, req_trunc = _body(_content(req))
        if resp is not None:
            resp_body, resp_size, resp_trunc = _body(_content(resp))
        else:
            resp_body, resp_size, resp_trunc = None, 0, False
        duration = None
        try:
            if resp is not None and resp.timestamp_end and req.timestamp_start:
                duration = int((resp.timestamp_end - req.timestamp_start) * 1000)
        except Exception:
            duration = None
        rec = {
            "method": req.method,
            "scheme": req.scheme,
            "host": req.pretty_host,
            "port": req.port,
            "path": req.path,
            "status": resp.status_code if resp is not None else None,
            "req_headers": list(req.headers.items(multi=True)),
            "resp_headers": list(resp.headers.items(multi=True)) if resp is not None else [],
            "req_size": req_size,
            "resp_size": resp_size,
            "duration_ms": duration,
            "req_body": req_body,
            "req_trunc": req_trunc,
            "resp_body": resp_body,
            "resp_trunc": resp_trunc,
            "ts": req.timestamp_start,
        }
        sys.stdout.write(json.dumps(rec) + "\n")
        sys.stdout.flush()
    except Exception:
        # Never let a malformed flow take down mitmdump.
        pass
