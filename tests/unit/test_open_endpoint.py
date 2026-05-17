"""Tests for POST /api/model/open — runtime PBIP switching."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from model_lenz.server import create_app

REPO_ROOT = Path(__file__).resolve().parents[2]
TINY_PBIP = REPO_ROOT / "examples" / "tiny_pbip"


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(TINY_PBIP))


def test_open_pbip_succeeds_for_valid_path(client: TestClient, tmp_path: Path):
    r = client.post("/api/model/open", json={"path": str(TINY_PBIP)})
    assert r.status_code == 200
    body = r.json()
    assert body["path"] == str(TINY_PBIP.resolve())
    assert body["summary"]["counts"]["tables"] >= 1


def test_subsequent_get_reflects_switched_pbip(client: TestClient):
    """After /api/model/open succeeds, /healthz and /api/model use the new path."""
    r = client.post("/api/model/open", json={"path": str(TINY_PBIP)})
    assert r.status_code == 200
    new_path = r.json()["path"]

    h = client.get("/healthz").json()
    assert h["pbip"] == new_path

    summary = client.get("/api/model").json()
    assert summary == r.json()["summary"]


def test_open_pbip_400_for_missing_path(client: TestClient):
    r = client.post("/api/model/open", json={"path": "D:/definitely-not-a-real-path-zxq"})
    assert r.status_code == 400
    assert "does not exist" in r.json()["detail"]


def test_open_pbip_400_for_folder_without_semantic_model(client: TestClient, tmp_path: Path):
    # tmp_path exists but contains no *.SemanticModel folder.
    r = client.post("/api/model/open", json={"path": str(tmp_path)})
    assert r.status_code == 400
    assert "SemanticModel" in r.json()["detail"]


def test_open_pbip_409_in_diff_mode():
    app = create_app(
        TINY_PBIP,
        diff_context={
            "base_path": str(TINY_PBIP),
            "head_path": str(TINY_PBIP),
            "base_label": "base",
            "head_label": "head",
            "base_is_default_branch": False,
        },
    )
    client = TestClient(app)
    r = client.post("/api/model/open", json={"path": str(TINY_PBIP)})
    assert r.status_code == 409
    assert "diff session" in r.json()["detail"]
