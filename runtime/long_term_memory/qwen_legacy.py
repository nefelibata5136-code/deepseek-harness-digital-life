"""Unmodified API symbols reused from knowledge_point_retrieval.py. See qwen-provenance.json."""
from __future__ import annotations
import os
import random
import threading
import time
from typing import Any
import requests

def resolve_api_key() -> tuple[str | None, str]:
    return os.environ.get('DASHSCOPE_API_KEY'), 'host-process'


def endpoint_urls(workspace_id: str) -> tuple[str, str]:
    root = f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com"
    return (
        f"{root}/compatible-mode/v1/embeddings",
        f"{root}/compatible-api/v1/reranks",
    )


class RateLimiter:
    def __init__(self, min_interval: float) -> None:
        self.min_interval = max(0.0, min_interval)
        self._lock = threading.Lock()
        self._next_time = 0.0

    def wait(self) -> None:
        if self.min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next_time)
            self._next_time = start + self.min_interval
        delay = start - now
        if delay > 0:
            time.sleep(delay)


class ApiClient:
    def __init__(
        self,
        api_key: str,
        workspace_id: str,
        timeout: float,
        max_retries: int,
        min_interval: float,
        use_system_proxy: bool,
    ) -> None:
        self.api_key = api_key
        self.workspace_id = workspace_id
        self.timeout = timeout
        self.max_retries = max_retries
        self.embedding_url, self.rerank_url = endpoint_urls(workspace_id)
        self.rate_limiter = RateLimiter(min_interval)
        self.use_system_proxy = use_system_proxy

    def _request(self, url: str, body: dict[str, Any], operation: str) -> dict[str, Any]:
        last_error: dict[str, Any] | None = None
        for attempt in range(self.max_retries + 1):
            self.rate_limiter.wait()
            started = time.monotonic()
            try:
                session = requests.Session()
                session.trust_env = self.use_system_proxy
                response = session.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                        "User-Agent": "DigitalLifeRuntime/memory-retrieval",
                    },
                    json=body,
                    timeout=self.timeout,
                )
                latency_ms = round((time.monotonic() - started) * 1000, 3)
                try:
                    payload = response.json()
                except ValueError:
                    payload = {"raw_text": response.text[:2000]}
                request_id = (
                    payload.get("request_id")
                    or payload.get("requestId")
                    or response.headers.get("X-DashScope-Request-Id")
                    or response.headers.get("x-request-id")
                )
                error_code = payload.get("code") if isinstance(payload, dict) else None
                successful = 200 <= response.status_code < 300 and not error_code
                if successful:
                    return {
                        "ok": True,
                        "payload": payload,
                        "status_code": response.status_code,
                        "request_id": request_id,
                        "attempts": attempt + 1,
                        "latency_ms": latency_ms,
                        "operation": operation,
                    }
                message = payload.get("message") if isinstance(payload, dict) else None
                last_error = {
                    "ok": False,
                    "status_code": response.status_code,
                    "code": error_code,
                    "message": message or payload.get("raw_text", "HTTP error"),
                    "request_id": request_id,
                    "attempt": attempt + 1,
                    "latency_ms": latency_ms,
                    "operation": operation,
                }
                retryable = response.status_code == 429 or response.status_code >= 500
            except requests.RequestException as exc:
                last_error = {
                    "ok": False,
                    "status_code": None,
                    "code": type(exc).__name__,
                    "message": str(exc)[:1000],
                    "request_id": None,
                    "attempt": attempt + 1,
                    "latency_ms": round((time.monotonic() - started) * 1000, 3),
                    "operation": operation,
                }
                retryable = True
            if attempt < self.max_retries and retryable:
                delay = random.uniform(0.25, 1.5 * (2**attempt))
                time.sleep(delay)
                continue
            break
        assert last_error is not None
        return last_error

    def embed(self, texts: list[str], model: str, dimension: int) -> dict[str, Any]:
        body = {
            "model": model,
            "input": texts,
            "dimensions": dimension,
            "encoding_format": "float",
        }
        return self._request(self.embedding_url, body, "embedding")

    def rerank(self, query: str, documents: list[str], model: str, top_n: int) -> dict[str, Any]:
        body = {
            "model": model,
            "query": query,
            "documents": documents,
            "top_n": top_n,
            "return_documents": False,
        }
        return self._request(self.rerank_url, body, "rerank")


def parse_embeddings(payload: dict[str, Any], expected_count: int, dimension: int) -> list[list[float]]:
    data = payload.get("data")
    if data is None and isinstance(payload.get("output"), dict):
        data = payload["output"].get("embeddings") or payload["output"].get("data")
    if not isinstance(data, list) or len(data) != expected_count:
        raise ValueError(f"Embedding response count mismatch: expected {expected_count}, got {len(data) if isinstance(data, list) else 'none'}")
    ordered: list[list[float] | None] = [None] * expected_count
    for fallback_index, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError("Embedding response item is not an object")
        index = item.get("index", item.get("text_index", fallback_index))
        vector = item.get("embedding")
        if not isinstance(index, int) or not isinstance(vector, list):
            raise ValueError("Embedding response lacks integer index or vector")
        if not 0 <= index < expected_count or len(vector) != dimension:
            raise ValueError(f"Invalid embedding index/dimension: index={index}, dimension={len(vector) if isinstance(vector, list) else 'none'}")
        ordered[index] = [float(value) for value in vector]
    if any(vector is None for vector in ordered):
        raise ValueError("Embedding response has missing indices")
    return [vector for vector in ordered if vector is not None]


def parse_rerank(payload: dict[str, Any], expected_count: int, top_n: int) -> list[dict[str, Any]]:
    results = payload.get("results")
    if results is None and isinstance(payload.get("output"), dict):
        results = payload["output"].get("results")
    if not isinstance(results, list) or not results:
        raise ValueError("Rerank response has no results")
    parsed: list[dict[str, Any]] = []
    for fallback_rank, item in enumerate(results, 1):
        if not isinstance(item, dict):
            raise ValueError("Rerank response item is not an object")
        index = item.get("index", item.get("document_index"))
        score = item.get("relevance_score", item.get("score"))
        if not isinstance(index, int) or not isinstance(score, (int, float)):
            raise ValueError(f"Rerank response lacks index/score: {item}")
        if not 0 <= index < expected_count:
            raise ValueError(f"Rerank response index out of range: {index}")
        parsed.append({"index": index, "score": float(score), "rank": fallback_rank})
    parsed.sort(key=lambda item: (-item["score"], item["index"]))
    for rank, item in enumerate(parsed[:top_n], 1):
        item["rank"] = rank
    return parsed[:top_n]


def usage_tokens(payload: dict[str, Any]) -> int | None:
    usage = payload.get("usage")
    if not isinstance(usage, dict) and isinstance(payload.get("output"), dict):
        usage = payload["output"].get("usage")
    if not isinstance(usage, dict):
        return None
    for key in ("total_tokens", "input_tokens", "prompt_tokens"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return None
