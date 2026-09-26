"""WebSocket connection manager for the ``/ws/alerts`` hazard stream."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import WebSocket

log = logging.getLogger(__name__)


class AlertBroadcaster:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            clients = list(self._clients)
        if not clients:
            return
        results = await asyncio.gather(
            *(c.send_json(payload) for c in clients), return_exceptions=True
        )
        dead = [c for c, r in zip(clients, results) if isinstance(r, Exception)]
        if dead:
            log.info("dropping %d dead websocket client(s)", len(dead))
            async with self._lock:
                self._clients.difference_update(dead)
