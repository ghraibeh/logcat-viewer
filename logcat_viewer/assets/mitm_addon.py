"""mitmproxy addon: print one JSON line per completed flow to stdout.

Loaded by Logcat Viewer's Network Intercept tab (Tier 2), run headlessly as:

    mitmdump -q -p <port> -s mitm_addon.py --set flow_detail=0

The parent process (``MitmdumpWorker`` in ``intercept.py``) reads stdout
line-by-line and rebuilds each request/response into a ``Flow``. Bodies are
capped and either sent as UTF-8 text or, when binary, ``base64:``-prefixed.
"""
import base64
import json
import sys

MAX_BODY = 1_048_576


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
