from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ModelImportRequest(BaseModel):
    file_path: str = Field(..., min_length=1)
    project_id: str = Field(..., min_length=1)


class ModelImportResponse(BaseModel):
    model_id: str
    status: str
    source_file: str


class UploadedModel(BaseModel):
    model_id: str
    project_id: str
    file_name: str
    file_path: str
    uploaded_at: datetime


class ModelUploadResponse(BaseModel):
    model: UploadedModel


class ModelListResponse(BaseModel):
    project_id: str
    models: list[UploadedModel]


class CommandExecuteRequest(BaseModel):
    model_id: str = Field(..., min_length=1)
    operation_type: Literal["length_edit", "snap_constraint", "transform"]
    parameters: dict[str, Any] = Field(default_factory=dict)


class OperationRecord(BaseModel):
    operation_id: str
    model_id: str
    operation_type: str
    status: Literal["queued", "applied", "failed"]
    summary: str
    parameters: dict[str, Any]
    created_at: datetime


class CommandExecuteResponse(BaseModel):
    operation: OperationRecord


class OperationHistoryResponse(BaseModel):
    model_id: str
    operations: list[OperationRecord]


class BomGenerateRequest(BaseModel):
    project_id: str = Field(..., min_length=1)
    model_name: str | None = None  # filename in 3D Models dir, or None for uploaded


class BomItem(BaseModel):
    part_number: str
    name: str
    quantity: int
    description: str = ""
    step_id: str = ""


class BomGenerateResponse(BaseModel):
    project_id: str
    items: list[BomItem]


class DeleteModelResponse(BaseModel):
    model_id: str
    deleted: bool


class Vec3(BaseModel):
    x: float
    y: float
    z: float


class AssemblyTransform(BaseModel):
    position: Vec3
    rotation: Vec3
    scale: Vec3


class AssemblyPartState(BaseModel):
    name: str = Field(..., min_length=1)
    source_type: Literal["local", "uploaded"]
    model_id: str | None = None
    color: int
    visible: bool = True
    locked: bool = False
    transform: AssemblyTransform


class AssemblyDocument(BaseModel):
    assembly_id: str
    project_id: str
    name: str
    parts: list[AssemblyPartState]
    updated_at: datetime


class AssemblyUpsertRequest(BaseModel):
    name: str = Field(default="Workspace", min_length=1)
    parts: list[AssemblyPartState] = Field(default_factory=list)


class AssemblyResponse(BaseModel):
    assembly: AssemblyDocument
