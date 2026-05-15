# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Centralized structured logging with secret-key redaction for Caracal Python services and SDKs.

from __future__ import annotations

import atexit
import contextvars
import json
import logging
import logging.handlers
import os
import queue
import re
import signal
import socket
import sys
import time
import traceback
from typing import Any, Callable, Mapping

SECRET_KEYS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "id_token",
    "authorization",
    "auth",
    "cookie",
    "set-cookie",
    "client_secret",
    "private_key",
    "signing_key",
    "hmac_key",
    "encryption_key",
    "session",
    "credential",
    "credentials",
)

REDACT_VALUE = "***"

_LEVELS = {"debug": 10, "info": 20, "warn": 30, "warning": 30, "error": 40, "fatal": 50, "critical": 50}

_BEARER_RE = re.compile(r"bearer\s+[A-Za-z0-9._\-+/=]{8,}", re.IGNORECASE)
_JWT_RE = re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")
_AWS_AKIA_RE = re.compile(r"AKIA[0-9A-Z]{16}")
_AWS_ASIA_RE = re.compile(r"ASIA[0-9A-Z]{16}")
_GCP_KEY_RE = re.compile(r"AIza[0-9A-Za-z_\-]{35}")
_GITHUB_PAT_RE = re.compile(r"gh[pousr]_[A-Za-z0-9]{36,255}")
_SLACK_TOKEN_RE = re.compile(r"xox[abprs]-[A-Za-z0-9\-]{10,}")
_PEM_BLOCK_RE = re.compile(
    r"-----BEGIN [A-Z ]+PRIVATE KEY-----.*?-----END [A-Z ]+PRIVATE KEY-----",
    re.DOTALL,
)

MAX_FIELD_BYTES = int(os.environ.get("CARACAL_LOG_MAX_FIELD_BYTES", "8192"))
_DEBUG_SAMPLE_N = max(1, int(os.environ.get("CARACAL_LOG_SAMPLE_DEBUG", "1")))


def is_secret_key(key: str) -> bool:
    if not key:
        return False
    lk = key.lower()
    return any(s in lk for s in SECRET_KEYS)


def redact_string(s: str) -> str:
    """Scrub bearer tokens, JWTs, and common cloud-secret patterns."""
    if len(s) < 16:
        return s
    s = _PEM_BLOCK_RE.sub(REDACT_VALUE, s)
    s = _BEARER_RE.sub(f"Bearer {REDACT_VALUE}", s)
    s = _JWT_RE.sub(REDACT_VALUE, s)
    s = _AWS_AKIA_RE.sub(REDACT_VALUE, s)
    s = _AWS_ASIA_RE.sub(REDACT_VALUE, s)
    s = _GCP_KEY_RE.sub(REDACT_VALUE, s)
    s = _GITHUB_PAT_RE.sub(REDACT_VALUE, s)
    s = _SLACK_TOKEN_RE.sub(REDACT_VALUE, s)
    return s


def truncate_string(s: str) -> str:
    if MAX_FIELD_BYTES <= 0 or len(s) <= MAX_FIELD_BYTES:
        return s
    return s[:MAX_FIELD_BYTES] + "…[truncated]"


def _serialize_exception(exc: BaseException) -> dict[str, Any]:
    out: dict[str, Any] = {
        "name": type(exc).__name__,
        "message": str(exc),
        "stack": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    }
    if exc.__cause__ is not None:
        out["cause"] = _serialize_exception(exc.__cause__)
    return out


def redact(value: Any) -> Any:
    if isinstance(value, BaseException):
        return _serialize_exception(value)
    if isinstance(value, str):
        return truncate_string(redact_string(value))
    if isinstance(value, Mapping):
        return {k: (REDACT_VALUE if is_secret_key(str(k)) else redact(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        seq = [redact(v) for v in value]
        return seq if isinstance(value, list) else tuple(seq)
    return value


_trace_ctx: contextvars.ContextVar[dict[str, str] | None] = contextvars.ContextVar(
    "caracal_trace", default=None
)


def bind_trace(trace_id: str | None = None, span_id: str | None = None) -> contextvars.Token:
    """Bind trace identifiers to the current async/sync context; returns a token
    that can be passed to reset_trace to restore the previous value."""
    payload: dict[str, str] = {}
    if trace_id:
        payload["trace_id"] = trace_id
    if span_id:
        payload["span_id"] = span_id
    return _trace_ctx.set(payload or None)


def reset_trace(token: contextvars.Token) -> None:
    _trace_ctx.reset(token)


def current_trace() -> dict[str, str]:
    cur = _trace_ctx.get()
    return dict(cur) if cur else {}


def parse_traceparent(header: str | None) -> dict[str, str]:
    """Decode a W3C traceparent header into trace_id/span_id keys; empty on parse failure."""
    if not header:
        return {}
    parts = header.split("-")
    if len(parts) < 4 or len(parts[1]) != 32 or len(parts[2]) != 16:
        return {}
    return {"trace_id": parts[1], "span_id": parts[2]}


def _process_base_fields(service: str) -> dict[str, Any]:
    try:
        host = socket.gethostname() or "unknown"
    except OSError:
        host = "unknown"
    return {
        "service": service,
        "hostname": host,
        "pid": os.getpid(),
        "version": os.environ.get("CARACAL_VERSION", "dev"),
        "env": os.environ.get("CARACAL_ENV") or os.environ.get("APP_ENV") or "development",
    }


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
        }
        base = getattr(record, "_caracal_base", None)
        if isinstance(base, Mapping):
            payload.update(base)
        payload["msg"] = record.getMessage()
        bound = getattr(record, "_caracal_bound", None)
        if isinstance(bound, Mapping):
            for k, v in redact(dict(bound)).items():
                payload[k] = v
        extra = getattr(record, "_caracal_extra", None)
        if isinstance(extra, Mapping):
            for k, v in redact(dict(extra)).items():
                payload[k] = v
        if record.exc_info and record.exc_info[1] is not None:
            payload["error"] = _serialize_exception(record.exc_info[1])
        return json.dumps(payload, default=str, separators=(",", ":"))


# Process-wide queue infrastructure: log records produced by application threads
# are pushed onto a bounded queue by QueueHandler (cheap, no formatting), and a
# background QueueListener thread formats and writes to stderr.
_QUEUE_MAXSIZE = int(os.environ.get("CARACAL_LOG_QUEUE_SIZE", "16384"))
_log_queue: "queue.Queue[logging.LogRecord]" = queue.Queue(maxsize=_QUEUE_MAXSIZE)
_listener: logging.handlers.QueueListener | None = None
_listener_started = False
_dropped = 0
_emitted = 0
_sampled = 0
_debug_counter = 0


def _ensure_listener() -> None:
    global _listener, _listener_started
    if _listener_started:
        return
    handler = _DynamicStderrHandler()
    handler.setFormatter(_JsonFormatter())
    _listener = logging.handlers.QueueListener(_log_queue, handler, respect_handler_level=True)
    _listener.start()
    _listener_started = True
    atexit.register(_shutdown_listener)


class _DynamicStderrHandler(logging.Handler):
    """StreamHandler that resolves sys.stderr at emit time so test redirection works."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            stream = sys.stderr
            stream.write(msg + "\n")
            try:
                stream.flush()
            except Exception:
                pass
        except Exception:  # noqa: BLE001
            self.handleError(record)


def _shutdown_listener() -> None:
    global _listener, _listener_started
    if _listener is not None:
        try:
            _listener.stop()
        except Exception:
            pass
        _listener = None
    _listener_started = False


def flush_for_test() -> None:
    """Block until the background queue is drained; intended for tests only."""
    _log_queue.join() if hasattr(_log_queue, "join") and False else None
    # QueueListener's internal queue does not support join(); poll instead.
    deadline = time.time() + 1.0
    while time.time() < deadline:
        if _log_queue.empty():
            return
        time.sleep(0.005)


class _NonBlockingQueueHandler(logging.Handler):
    """Pushes records onto the shared queue without blocking; drops when full."""

    def emit(self, record: logging.LogRecord) -> None:
        global _dropped, _emitted
        try:
            _log_queue.put_nowait(record)
            _emitted += 1
        except queue.Full:
            _dropped += 1


class DevLogger:
    """Structured JSON dev/diagnostics logger.

    Two streams in Caracal: this one (developer/infra) and AuditClient
    (immutable end-user audit). Records carry per-service base fields and are
    handed off to a background QueueListener so caller threads never block on
    stderr writes.
    """

    def __init__(self, service: str, level: str | int = "info", bound: Mapping[str, Any] | None = None) -> None:
        self._service = service
        self._bound: dict[str, Any] = dict(bound or {})
        self._base = _process_base_fields(service)
        _ensure_listener()
        self._logger = logging.getLogger(f"caracal.{service}")
        if not any(isinstance(h, _NonBlockingQueueHandler) for h in self._logger.handlers):
            self._logger.handlers.clear()
            self._logger.addHandler(_NonBlockingQueueHandler())
            self._logger.propagate = False
        self.set_level(level)

    def set_level(self, level: str | int) -> None:
        if isinstance(level, str):
            level = _LEVELS.get(level.lower(), logging.INFO)
        self._logger.setLevel(level)

    def with_(self, **fields: Any) -> "DevLogger":
        merged = dict(self._bound)
        merged.update(fields)
        child = DevLogger.__new__(DevLogger)
        child._service = self._service
        child._bound = merged
        child._base = self._base
        child._logger = self._logger
        return child

    def _emit(self, level: int, msg: str, fields: Mapping[str, Any] | None) -> None:
        global _debug_counter, _sampled
        if not self._logger.isEnabledFor(level):
            return
        if level == logging.DEBUG and _DEBUG_SAMPLE_N > 1:
            _debug_counter += 1
            if _debug_counter % _DEBUG_SAMPLE_N != 0:
                _sampled += 1
                return
        exc_info = None
        if fields:
            err = fields.get("err") or fields.get("error") or fields.get("exception")
            if isinstance(err, BaseException):
                exc_info = (type(err), err, err.__traceback__)
        record = self._logger.makeRecord(self._logger.name, level, "", 0, msg, (), exc_info)
        record._caracal_base = self._base  # type: ignore[attr-defined]
        merged_bound = dict(self._bound)
        merged_bound.update(current_trace())
        record._caracal_bound = merged_bound  # type: ignore[attr-defined]
        record._caracal_extra = dict(fields) if fields else None  # type: ignore[attr-defined]
        self._logger.handle(record)

    def debug(self, msg: str, **fields: Any) -> None: self._emit(logging.DEBUG, msg, fields)
    def info(self, msg: str, **fields: Any) -> None: self._emit(logging.INFO, msg, fields)
    def warn(self, msg: str, **fields: Any) -> None: self._emit(logging.WARNING, msg, fields)
    def warning(self, msg: str, **fields: Any) -> None: self._emit(logging.WARNING, msg, fields)
    def error(self, msg: str, **fields: Any) -> None: self._emit(logging.ERROR, msg, fields)
    def fatal(self, msg: str, **fields: Any) -> None: self._emit(logging.CRITICAL, msg, fields)


def shutdown_logging() -> None:
    """Flush and stop the background log listener; safe to call multiple times."""
    _shutdown_listener()


def dropped_log_records() -> int:
    """Number of log records dropped because the background queue was full."""
    return _dropped


def dev_log_metrics() -> dict[str, int]:
    """Snapshot of dev-log counters for /metrics exposure."""
    return {
        "emitted": _emitted,
        "dropped": _dropped,
        "sampled": _sampled,
        "queue_depth": _log_queue.qsize(),
        "queue_cap": _QUEUE_MAXSIZE,
    }


def install_shutdown_handler(extra: Callable[[], None] | None = None, timeout: float = 2.0) -> None:
    """Wire SIGTERM/SIGINT to flush dev logs (and optionally invoke `extra`,
    typically AuditClient.close) before the process exits."""

    def _handler(signum: int, _frame: Any) -> None:
        try:
            if extra is not None:
                extra()
        finally:
            shutdown_logging()
            raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _handler)
    signal.signal(signal.SIGINT, _handler)


def create_logger(service: str, level: str | int | None = None) -> DevLogger:
    if level is None:
        level = os.environ.get("CARACAL_LOG_LEVEL") or os.environ.get("LOG_LEVEL") or "info"
    return DevLogger(service, level)

