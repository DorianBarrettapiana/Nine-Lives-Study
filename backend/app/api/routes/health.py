"""Health check routes."""

from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def healthcheck() -> dict[str, str]:
    """Return a simple health status."""
    return {"status": "ok"}
