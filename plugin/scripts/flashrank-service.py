#!/usr/bin/env python3
"""
Flashrank reranker microservice for claude-mem.

Wraps the Flashrank library to provide HTTP-based reranking of search results.
Uses the ms-marco-MiniLM-L-12-v2 model (~22MB quantized ONNX) for better score resolution than TinyBERT.

Usage:
  python flashrank-service.py [--port PORT] [--host HOST]

The service accepts POST /rerank with:
  {
    "query": "search query text",
    "passages": [
      {"id": "any-id", "text": "passage text to score"},
      ...
    ],
    "top_k": 20  (optional, default: 20)
  }

Returns:
  {
    "results": [
      {"id": "any-id", "score": 0.95},
      ...
    ],
    "latency_ms": 26.3
  }
  Ordered by score descending (most relevant first).
"""

import argparse
import json
import logging
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [flashrank-service] %(levelname)s %(message)s"
)
logger = logging.getLogger(__name__)

# Lazy-load the model on first request to avoid startup delay
_ranker = None
MODEL_NAME = "ms-marco-MiniLM-L-12-v2"


def get_ranker():
    """Lazy-initialize the Flashrank ranker."""
    global _ranker
    if _ranker is None:
        logger.info(f"Loading Flashrank model: {MODEL_NAME}")
        t0 = time.time()
        from flashrank import Ranker
        _ranker = Ranker(model_name=MODEL_NAME)
        elapsed = (time.time() - t0) * 1000
        logger.info(f"Model loaded in {elapsed:.0f}ms")
    return _ranker


def rerank(query: str, passages: list, top_k: int = 20) -> tuple[list, float]:
    """
    Rerank passages for a query.

    Args:
        query: The search query.
        passages: List of dicts with "id" and "text" keys.
        top_k: Number of top results to return.

    Returns:
        Tuple of (reranked list of {id, score}, latency_ms).
    """
    from flashrank import RerankRequest

    ranker = get_ranker()

    # Build passage list for Flashrank (it expects list of dicts with "text" key)
    flashrank_passages = [{"id": p["id"], "text": p["text"]} for p in passages]

    rerank_request = RerankRequest(query=query, passages=flashrank_passages)

    t0 = time.time()
    results = ranker.rerank(rerank_request)
    latency_ms = (time.time() - t0) * 1000

    # Return top_k results with scores, ordered by score descending
    scored = [
        {"id": r["id"], "score": float(r["score"])}
        for r in results[:top_k]
    ]

    return scored, latency_ms


class RerankHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default HTTP request logging (we use our own)
        pass

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok", "model": MODEL_NAME})
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/rerank":
            self._respond(404, {"error": "not found"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._respond(400, {"error": "empty body"})
            return

        try:
            body = self.rfile.read(content_length)
            data = json.loads(body)
        except (json.JSONDecodeError, Exception) as e:
            self._respond(400, {"error": f"invalid JSON: {e}"})
            return

        query = data.get("query", "").strip()
        passages = data.get("passages", [])
        top_k = int(data.get("top_k", 20))

        if not query:
            self._respond(400, {"error": "query is required"})
            return

        if not passages:
            self._respond(200, {"results": [], "latency_ms": 0.0})
            return

        # Validate passage format
        for p in passages:
            if "id" not in p or "text" not in p:
                self._respond(400, {"error": "each passage must have 'id' and 'text' keys"})
                return

        try:
            results, latency_ms = rerank(query, passages, top_k)
            logger.info(
                f"Reranked {len(passages)} passages -> top {len(results)} "
                f"in {latency_ms:.1f}ms"
            )
            self._respond(200, {"results": results, "latency_ms": latency_ms})
        except Exception as e:
            logger.error(f"Rerank failed: {e}", exc_info=True)
            self._respond(500, {"error": f"rerank failed: {e}"})

    def _respond(self, status: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Flashrank reranker microservice")
    parser.add_argument("--port", type=int, default=37778, help="Port to listen on (default: 37778)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")
    args = parser.parse_args()

    # Eagerly load the model at startup so first request is fast
    try:
        get_ranker()
    except Exception as e:
        logger.error(f"Failed to load model at startup: {e}")
        raise

    server = HTTPServer((args.host, args.port), RerankHandler)
    logger.info(f"Flashrank service listening on {args.host}:{args.port}")
    logger.info(f"Model: {MODEL_NAME}")
    logger.info("Ready to accept requests at POST /rerank")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
