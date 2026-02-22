from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .models import AssemblyDocument, AssemblyPartState, AssemblyTransform, OperationRecord, UploadedModel, Vec3

REPO_ROOT = Path(__file__).resolve().parents[4]
DATA_DIR = REPO_ROOT / ".gfun-data"
MODELS_DIR = DATA_DIR / "models"
REGISTRY_PATH = DATA_DIR / "models.json"
OPERATIONS_PATH = DATA_DIR / "operations.json"
ASSEMBLIES_PATH = DATA_DIR / "assemblies.json"


def _ensure_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if not REGISTRY_PATH.exists():
        REGISTRY_PATH.write_text("[]", encoding="utf-8")
    if not OPERATIONS_PATH.exists():
        OPERATIONS_PATH.write_text("[]", encoding="utf-8")
    if not ASSEMBLIES_PATH.exists():
        ASSEMBLIES_PATH.write_text("[]", encoding="utf-8")


def _read_registry() -> list[UploadedModel]:
    _ensure_storage()
    raw = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return [UploadedModel.model_validate(item) for item in raw]


def _write_registry(models: list[UploadedModel]) -> None:
    serialized = [model.model_dump(mode="json") for model in models]
    REGISTRY_PATH.write_text(json.dumps(serialized, indent=2), encoding="utf-8")


def _read_operations() -> list[OperationRecord]:
    _ensure_storage()
    raw = json.loads(OPERATIONS_PATH.read_text(encoding="utf-8"))
    return [OperationRecord.model_validate(item) for item in raw]


def _write_operations(operations: list[OperationRecord]) -> None:
    serialized = [operation.model_dump(mode="json") for operation in operations]
    OPERATIONS_PATH.write_text(json.dumps(serialized, indent=2), encoding="utf-8")


def _read_assemblies() -> list[AssemblyDocument]:
    _ensure_storage()
    raw = json.loads(ASSEMBLIES_PATH.read_text(encoding="utf-8"))
    return [AssemblyDocument.model_validate(item) for item in raw]


def _write_assemblies(assemblies: list[AssemblyDocument]) -> None:
    serialized = [assembly.model_dump(mode="json") for assembly in assemblies]
    ASSEMBLIES_PATH.write_text(json.dumps(serialized, indent=2), encoding="utf-8")


def save_uploaded_model(project_id: str, file_name: str, file_content: bytes) -> UploadedModel:
    _ensure_storage()
    model_id = f"mdl-{uuid4().hex[:12]}"
    extension = Path(file_name).suffix.lower() or ".step"
    storage_name = f"{model_id}{extension}"
    storage_path = MODELS_DIR / storage_name
    storage_path.write_bytes(file_content)

    model = UploadedModel(
        model_id=model_id,
        project_id=project_id,
        file_name=file_name,
        file_path=str(storage_path),
        uploaded_at=datetime.now(timezone.utc),
    )

    models = _read_registry()
    models.append(model)
    _write_registry(models)
    return model


def list_models(project_id: str | None = None) -> list[UploadedModel]:
    models = _read_registry()
    if project_id is None:
        return models
    return [model for model in models if model.project_id == project_id]


def get_model(model_id: str) -> UploadedModel | None:
    models = _read_registry()
    for model in models:
        if model.model_id == model_id:
            return model
    return None


def append_operation(
    *,
    model_id: str,
    operation_type: str,
    summary: str,
    parameters: dict,
    status: str = "applied",
) -> OperationRecord:
    operations = _read_operations()
    operation = OperationRecord(
        operation_id=f"op-{uuid4().hex[:12]}",
        model_id=model_id,
        operation_type=operation_type,
        status=status,
        summary=summary,
        parameters=parameters,
        created_at=datetime.now(timezone.utc),
    )
    operations.append(operation)
    _write_operations(operations)
    return operation


def list_operations(model_id: str) -> list[OperationRecord]:
    operations = _read_operations()
    return [operation for operation in operations if operation.model_id == model_id]


def delete_model(model_id: str) -> bool:
    """Remove a model from the registry and delete its file. Returns True if found and deleted."""
    models = _read_registry()
    target = next((m for m in models if m.model_id == model_id), None)
    if target is None:
        return False
    # Delete the stored file
    file_path = Path(target.file_path)
    if file_path.exists():
        file_path.unlink()
    # Remove from registry
    updated = [m for m in models if m.model_id != model_id]
    _write_registry(updated)
    # Remove associated operations
    operations = _read_operations()
    _write_operations([op for op in operations if op.model_id != model_id])
    return True


def get_assembly(project_id: str, assembly_id: str) -> AssemblyDocument:
    assemblies = _read_assemblies()
    found = next((a for a in assemblies if a.project_id == project_id and a.assembly_id == assembly_id), None)
    if found:
        return found
    return AssemblyDocument(
        assembly_id=assembly_id,
        project_id=project_id,
        name="Workspace",
        parts=[],
        updated_at=datetime.now(timezone.utc),
    )


def save_assembly(
    *,
    project_id: str,
    assembly_id: str,
    name: str,
    parts: list[AssemblyPartState],
) -> AssemblyDocument:
    assemblies = _read_assemblies()
    now = datetime.now(timezone.utc)
    updated = AssemblyDocument(
        assembly_id=assembly_id,
        project_id=project_id,
        name=name,
        parts=parts,
        updated_at=now,
    )
    kept = [a for a in assemblies if not (a.project_id == project_id and a.assembly_id == assembly_id)]
    kept.append(updated)
    _write_assemblies(kept)
    return updated
