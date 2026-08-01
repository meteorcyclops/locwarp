from fastapi import APIRouter

router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"])


@router.get("/connection")
async def connection_diagnostics():
    from main import app_state

    return app_state.connection_health.snapshot()
