from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .models import (
    AssemblyResponse,
    AssemblyUpsertRequest,
    BomGenerateRequest,
    BomGenerateResponse,
    BomItem,
    CommandExecuteRequest,
    CommandExecuteResponse,
    DeleteModelResponse,
    ModelImportRequest,
    ModelImportResponse,
    ModelListResponse,
    ModelUploadResponse,
    OperationHistoryResponse,
)
from .storage import (
    append_operation,
    delete_model,
    get_model,
    get_assembly,
    list_models,
    list_operations,
    save_assembly,
    save_uploaded_model,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cad_api")

# ── STEP BOM parser ───────────────────────────────────────────────────────────
_PRODUCT_RE2 = re.compile(
    r"#\s*(\d+)\s*=\s*PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'",
    re.IGNORECASE,
)
_NAUO_RE = re.compile(
    r"#\d+\s*=\s*NEXT_ASSEMBLY_USAGE_OCCUR(?:R?ENCE)\s*\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*#(\d+)\s*,\s*#(\d+)",
    re.IGNORECASE,
)


def _parse_step_bom(step_text: str) -> list[BomItem]:
    """Parse PRODUCT / NEXT_ASSEMBLY_USAGE_OCCURENCE records from a STEP file."""
    # Strip whitespace from lines to normalise
    flat = re.sub(r"\s+", " ", step_text)

    products: dict[str, dict] = {}
    for m in _PRODUCT_RE2.finditer(flat):
        sid, pid, pname, desc = m.group(1), m.group(2), m.group(3), m.group(4)
        canonical = pname.strip() or pid.strip() or f"PART-{sid}"
        products[sid] = {
            "step_id": sid,
            "part_number": pid.strip() or canonical,
            "name": canonical,
            "desc": desc.strip(),
        }

    nauos: list[tuple[str, str]] = []
    for m in _NAUO_RE.finditer(flat):
        nauos.append((m.group(1), m.group(2)))

    counts: dict[str, int] = {}
    if nauos:
        for _parent, child in nauos:
            counts[child] = counts.get(child, 0) + 1
        parts = {cid: counts[cid] for cid in counts if cid in products}
    else:
        parts = {pid: 1 for pid in products}

    if not parts:
        # Absolute fallback: list all discovered products once
        parts = {pid: 1 for pid in products}

    if not parts:
        return [BomItem(part_number="UNKNOWN", name="No PRODUCT records found", quantity=1)]

    items: list[BomItem] = []
    for step_id, qty in sorted(parts.items(), key=lambda kv: int(kv[0])):
        p = products.get(step_id, {})
        items.append(BomItem(
            step_id=step_id,
            part_number=p.get("part_number") or f"P{step_id}",
            name=p.get("name") or f"Part {step_id}",
            quantity=qty,
            description=p.get("desc", ""),
        ))
    return items

app = FastAPI(title="GFun CAD API", version="0.1.0")

_cors_env = os.getenv("GFUN_CORS_ORIGINS", "*")
_cors_origins = [origin.strip() for origin in _cors_env.split(",") if origin.strip()]
if not _cors_origins:
    _cors_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_logger(request: Request, call_next):
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = (time.perf_counter() - start) * 1000
        logger.exception("%s %s -> 500 (%.1f ms)", request.method, request.url.path, elapsed_ms)
        raise
    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info("%s %s -> %s (%.1f ms)", request.method, request.url.path, response.status_code, elapsed_ms)
    return response

# Resolve paths
_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parents[3]
_WEB_UI_DIR = _REPO_ROOT / "apps" / "web" / "public"
_LOCAL_MODELS_DIR = _REPO_ROOT / "3D Models"
_SAMPLE_STEP = _LOCAL_MODELS_DIR / "GFA-802G.step"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> dict[str, str]:
    return {
        "name": "GFun CAD API",
        "version": "0.1.0",
        "docs": "/docs",
        "health": "/health",
        "api": "/api/v1"
    }


@app.get("/api/v1")
def api_info() -> dict[str, str]:
    return {
        "version": "1.0.0",
        "endpoints": "See /docs for full API documentation"
    }


@app.get("/api/v1/assemblies/{assembly_id}", response_model=AssemblyResponse)
def assembly_get(assembly_id: str, project_id: str = Query("default-project")) -> AssemblyResponse:
    return AssemblyResponse(assembly=get_assembly(project_id=project_id, assembly_id=assembly_id))


@app.put("/api/v1/assemblies/{assembly_id}", response_model=AssemblyResponse)
def assembly_upsert(
    assembly_id: str,
    request: AssemblyUpsertRequest,
    project_id: str = Query("default-project"),
) -> AssemblyResponse:
    assembly = save_assembly(
        project_id=project_id,
        assembly_id=assembly_id,
        name=request.name,
        parts=request.parts,
    )
    return AssemblyResponse(assembly=assembly)


@app.post("/api/v1/models/import", response_model=ModelImportResponse)
def import_model(request: ModelImportRequest) -> ModelImportResponse:
    model_name = request.file_path.split("/")[-1]
    return ModelImportResponse(
        model_id=f"model-{request.project_id}-{model_name}",
        status="queued",
        source_file=request.file_path,
    )


@app.post("/api/v1/models/upload", response_model=ModelUploadResponse)
async def upload_model(project_id: str = Query(...), file: UploadFile = File(...)) -> ModelUploadResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Uploaded file must include a filename.")

    extension = Path(file.filename).suffix.lower()
    if extension not in {".step", ".stp"}:
        raise HTTPException(status_code=400, detail="Only STEP files (.step/.stp) are supported right now.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded STEP file is empty.")

    model = save_uploaded_model(project_id=project_id, file_name=file.filename, file_content=content)
    return ModelUploadResponse(model=model)


@app.get("/api/v1/models", response_model=ModelListResponse)
def models_list(project_id: str = Query(...)) -> ModelListResponse:
    return ModelListResponse(project_id=project_id, models=list_models(project_id=project_id))


@app.delete("/api/v1/models/{model_id}", response_model=DeleteModelResponse)
def remove_model(model_id: str) -> DeleteModelResponse:
    deleted = delete_model(model_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Model not found")
    return DeleteModelResponse(model_id=model_id, deleted=True)


@app.get("/api/v1/models/{model_id}/bom", response_model=BomGenerateResponse)
def uploaded_model_bom(model_id: str) -> BomGenerateResponse:
    """Parse BOM from an uploaded model's STEP file."""
    model = get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="Model not found")
    path = Path(model.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Model file missing from storage")
    step_text = path.read_text(encoding="utf-8", errors="replace")
    items = _parse_step_bom(step_text)
    return BomGenerateResponse(project_id=model.project_id, items=items)


@app.get("/api/v1/models/{model_id}/content")
def model_content(model_id: str) -> FileResponse:
    model = get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="Model not found")

    path = Path(model.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Model file is missing from storage")

    return FileResponse(path=path, media_type="application/step", filename=model.file_name)


@app.get("/api/v1/models/{model_id}/operations", response_model=OperationHistoryResponse)
def operation_history(model_id: str) -> OperationHistoryResponse:
    model = get_model(model_id)
    if model is None:
        raise HTTPException(status_code=404, detail="Model not found")

    return OperationHistoryResponse(model_id=model_id, operations=list_operations(model_id))


@app.post("/api/v1/commands/execute", response_model=CommandExecuteResponse)
def execute_command(request: CommandExecuteRequest) -> CommandExecuteResponse:
    if get_model(request.model_id) is None:
        raise HTTPException(status_code=404, detail="Model not found")

    if request.operation_type == "length_edit":
        length = request.parameters.get("target_length_mm", "?")
        axis   = request.parameters.get("axis", "z")
        summary = f"Length edit axis={axis} \u2192 {length} mm"
    elif request.operation_type == "snap_constraint":
        ctype  = request.parameters.get("constraint", "coincident")
        src    = request.parameters.get("source_ref", "src")
        tgt    = request.parameters.get("target_ref", "tgt")
        summary = f"Snap {ctype}: {src} \u2192 {tgt}"
    elif request.operation_type == "transform":
        summary = "Transform: " + ", ".join(f"{k}={v}" for k, v in request.parameters.items())
    else:
        summary = f"{request.operation_type}: {request.parameters}"

    operation = append_operation(
        model_id=request.model_id,
        operation_type=request.operation_type,
        summary=summary,
        parameters=request.parameters,
        status="applied",
    )
    return CommandExecuteResponse(operation=operation)


@app.post("/api/v1/bom/generate", response_model=BomGenerateResponse)
def generate_bom(request: BomGenerateRequest) -> BomGenerateResponse:
    """Generate BOM from a local library model by filename."""
    if request.model_name:
        safe = Path(request.model_name).name
        path = _LOCAL_MODELS_DIR / safe
        if path.exists() and path.suffix.lower() in {".step", ".stp"}:
            step_text = path.read_text(encoding="utf-8", errors="replace")
            items = _parse_step_bom(step_text)
            return BomGenerateResponse(project_id=request.project_id, items=items)
    return BomGenerateResponse(
        project_id=request.project_id,
        items=[BomItem(part_number="NONE", name="No model selected", quantity=1)],
    )


@app.get("/api/v1/sample-step")
def sample_step() -> FileResponse:
    if not _SAMPLE_STEP.exists():
        raise HTTPException(status_code=404, detail="Sample STEP file not found")
    return FileResponse(path=_SAMPLE_STEP, media_type="application/step", filename="GFA-802G.step")


@app.get("/api/v1/local-models")
def list_local_models() -> dict:
    """List all STEP files in the '3D Models' directory bundled with the repo."""
    if not _LOCAL_MODELS_DIR.exists():
        return {"models": []}
    files = sorted(
        f.name
        for f in _LOCAL_MODELS_DIR.iterdir()
        if f.suffix.lower() in {".step", ".stp"}
    )
    return {"models": files}


@app.get("/api/v1/local-models/{filename}/bom", response_model=BomGenerateResponse)
def local_model_bom(filename: str) -> BomGenerateResponse:
    """Parse and return the BOM from a library STEP file."""
    safe = Path(filename).name
    path = _LOCAL_MODELS_DIR / safe
    if not path.exists() or path.suffix.lower() not in {".step", ".stp"}:
        raise HTTPException(status_code=404, detail="Model file not found")
    step_text = path.read_text(encoding="utf-8", errors="replace")
    items = _parse_step_bom(step_text)
    return BomGenerateResponse(project_id="library", items=items)


@app.get("/api/v1/local-models/{filename}")
def get_local_model(filename: str) -> FileResponse:
    """Serve a specific STEP file from the '3D Models' directory."""
    safe_name = Path(filename).name
    path = _LOCAL_MODELS_DIR / safe_name
    if not path.exists() or path.suffix.lower() not in {".step", ".stp"}:
        raise HTTPException(status_code=404, detail="Model file not found")
    return FileResponse(path=path, media_type="application/step", filename=safe_name)


# Mount web UI static files (must be LAST so API routes take priority)
if _WEB_UI_DIR.exists():
    app.mount("/", StaticFiles(directory=str(_WEB_UI_DIR), html=True), name="web-ui")
