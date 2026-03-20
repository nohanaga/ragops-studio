"""Custom Skill Runtime for Azure AI Search Custom Skills.

Endpoints:
    GET  /health         — Health check + active skill information
    POST /simulate       — Execute ad-hoc Python code against test input
    POST /execute        — Execute the active skill loaded from Blob Storage
    POST /skills/{name}  — Execute a named skill loaded from Blob Storage
    POST /upload         — Publish skill code to Blob Storage and switch the active skill

The runtime loads skill code dynamically from Azure Blob Storage so the Container App
does not need to be rebuilt or redeployed for every skill-code change.
"""

import hashlib
import io
import json
import os
import re
import tempfile
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any, Callable

from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Skill Runtime", version="0.3.0")

# CORS — allow the RAGOps Studio frontend to call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class SkillRecord(BaseModel):
    recordId: str
    data: dict[str, Any]


class SkillPayload(BaseModel):
    values: list[SkillRecord]


class SimulateRequest(BaseModel):
    skill_code: str
    input: SkillPayload
    timeout: int = 30


class SimulateResponse(BaseModel):
    success: bool
    output: dict[str, Any] | None = None
    error: str | None = None
    executionTimeMs: float | None = None
    logs: str | None = None


class UploadRequest(BaseModel):
    skill_name: str
    skill_code: str
    skillset_name: str | None = None
    requirements_txt: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class SkillStorageConfig:
    account_url: str
    container_name: str
    prefix: str
    managed_identity_client_id: str | None = None


def _normalize_skill_name(name: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", name.strip().lower()).strip("-")
    return normalized or "custom-skill"


def _normalize_storage_prefix(prefix: str) -> str:
    parts = [part for part in prefix.replace("\\", "/").split("/") if part]
    return "/".join(parts)


def _get_storage_config() -> SkillStorageConfig | None:
    account_url = (
        os.getenv("SKILL_STORAGE_ACCOUNT_URL")
        or os.getenv("AZURE_STORAGE_BLOB_URL")
        or os.getenv("AZURE_STORAGEBLOB_RESOURCEENDPOINT")
        or ""
    ).strip().rstrip("/")
    container_name = (
        os.getenv("SKILL_STORAGE_CONTAINER")
        or os.getenv("AZURE_STORAGE_BLOB_CONTAINER")
        or ""
    ).strip()
    prefix = _normalize_storage_prefix(os.getenv("SKILL_STORAGE_PREFIX") or "skills")
    managed_identity_client_id = (
        os.getenv("SKILL_STORAGE_MANAGED_IDENTITY_CLIENT_ID")
        or os.getenv("Managed_Identity_Client_ID")
        or ""
    ).strip() or None

    if not account_url or not container_name:
        return None

    return SkillStorageConfig(
        account_url=account_url,
        container_name=container_name,
        prefix=prefix,
        managed_identity_client_id=managed_identity_client_id,
    )


def _get_blob_service_client(config: SkillStorageConfig) -> BlobServiceClient:
    credential_kwargs: dict[str, Any] = {}
    if config.managed_identity_client_id:
        credential_kwargs["managed_identity_client_id"] = config.managed_identity_client_id

    credential = DefaultAzureCredential(**credential_kwargs)
    return BlobServiceClient(account_url=config.account_url, credential=credential)


def _normalize_skillset_name(name: str | None) -> str | None:
    if not name or not name.strip():
        return None
    normalized = re.sub(r"[^a-z0-9-]+", "-", name.strip().lower()).strip("-")
    return normalized or None


def _active_skill_blob_name(config: SkillStorageConfig, skillset_name: str | None = None) -> str:
    ns = _normalize_skillset_name(skillset_name)
    if ns:
        base = f"{ns}/active-skill.json"
    else:
        base = "active-skill.json"
    return f"{config.prefix}/{base}" if config.prefix else base


def _skill_blob_name(config: SkillStorageConfig, skill_name: str, file_name: str, skillset_name: str | None = None) -> str:
    normalized_skill_name = _normalize_skill_name(skill_name)
    ns = _normalize_skillset_name(skillset_name)
    if ns:
        base_path = f"{ns}/{normalized_skill_name}/{file_name}"
    else:
        base_path = f"{normalized_skill_name}/{file_name}"
    return f"{config.prefix}/{base_path}" if config.prefix else base_path


def _download_text_blob(
    blob_service_client: BlobServiceClient,
    config: SkillStorageConfig,
    blob_name: str,
) -> str | None:
    blob_client = blob_service_client.get_blob_client(
        container=config.container_name,
        blob=blob_name,
    )

    try:
        content = blob_client.download_blob().readall()
    except ResourceNotFoundError:
        return None

    if isinstance(content, bytes):
        return content.decode("utf-8")
    return str(content)


def _upload_text_blob(
    blob_service_client: BlobServiceClient,
    config: SkillStorageConfig,
    blob_name: str,
    content: str,
    content_type: str,
) -> None:
    blob_client = blob_service_client.get_blob_client(
        container=config.container_name,
        blob=blob_name,
    )
    blob_client.upload_blob(
        content.encode("utf-8"),
        overwrite=True,
        content_settings=ContentSettings(content_type=content_type),
    )


def _ensure_container(blob_service_client: BlobServiceClient, config: SkillStorageConfig) -> None:
    container_client = blob_service_client.get_container_client(config.container_name)
    try:
        container_client.create_container()
    except ResourceExistsError:
        pass


def _load_active_skill_name(
    blob_service_client: BlobServiceClient,
    config: SkillStorageConfig,
    skillset_name: str | None = None,
) -> str | None:
    raw_config = _download_text_blob(blob_service_client, config, _active_skill_blob_name(config, skillset_name))
    if not raw_config:
        return None

    try:
        parsed = json.loads(raw_config)
    except json.JSONDecodeError:
        return None

    active_skill = parsed.get("activeSkill")
    if isinstance(active_skill, str) and active_skill.strip():
        return active_skill.strip()

    return None


def _build_error_payload(payload: SkillPayload, message: str) -> dict[str, Any]:
    return {
        "values": [
            {
                "recordId": record.recordId,
                "data": {},
                "errors": [{"message": message}],
                "warnings": [],
            }
            for record in payload.values
        ]
    }


def _join_logs(*parts: str | None) -> str | None:
    text = "".join(part for part in parts if part)
    return text or None


def _load_process_function(skill_code: str) -> tuple[Callable[[dict[str, Any]], Any] | None, str | None, str | None]:
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    try:
        with tempfile.TemporaryDirectory(prefix="skill-runtime-") as temp_dir:
            module_path = Path(temp_dir) / "skill_logic.py"
            module_path.write_text(skill_code, encoding="utf-8")

            module_name = f"skill_runtime_{time.time_ns()}"
            spec = spec_from_file_location(module_name, module_path)
            if spec is None or spec.loader is None:
                return None, None, "Failed to create a module spec for the skill code."

            module = module_from_spec(spec)
            with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
                spec.loader.exec_module(module)
    except SyntaxError as exc:
        return None, None, f"Syntax error in skill code: {exc}"
    except Exception as exc:
        return None, _join_logs(stdout_capture.getvalue(), stderr_capture.getvalue()), f"Error executing skill code: {exc}"

    process_fn = getattr(module, "process", None)
    if not callable(process_fn):
        return None, _join_logs(stdout_capture.getvalue(), stderr_capture.getvalue()), (
            "Skill code must define a callable `process(input: dict) -> dict` function."
        )

    return process_fn, _join_logs(stdout_capture.getvalue(), stderr_capture.getvalue()), None


def _execute_skill_code(skill_code: str, payload: SkillPayload) -> tuple[dict[str, Any] | None, float | None, str | None, str | None]:
    """Compile and execute a skill, returning output, elapsed ms, logs, error."""
    process_fn, import_logs, error = _load_process_function(skill_code)
    if error or process_fn is None:
        return None, None, import_logs, error or "Skill code could not be loaded."

    output_values: list[dict[str, Any]] = []
    start_time = time.perf_counter()
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    for record in payload.values:
        record_result: dict[str, Any] = {
            "recordId": record.recordId,
            "data": {},
            "errors": [],
            "warnings": [],
        }

        try:
            with redirect_stdout(stdout_capture), redirect_stderr(stderr_capture):
                result = process_fn(record.data)

            if isinstance(result, dict):
                record_result["data"] = result
            else:
                record_result["errors"].append(
                    {
                        "message": (
                            f"process() must return a dict, got {type(result).__name__}"
                        )
                    }
                )
        except Exception:
            record_result["errors"].append({"message": traceback.format_exc()})

        output_values.append(record_result)

    elapsed_ms = (time.perf_counter() - start_time) * 1000
    logs = _join_logs(import_logs, stdout_capture.getvalue(), stderr_capture.getvalue())
    return {"values": output_values}, round(elapsed_ms, 2), logs or None, None


def _load_deployed_skill(skill_name: str | None = None, skillset_name: str | None = None) -> tuple[str | None, str | None]:
    config = _get_storage_config()
    if not config:
        return None, "Blob Storage is not configured. Set SKILL_STORAGE_ACCOUNT_URL and SKILL_STORAGE_CONTAINER."

    try:
        blob_service_client = _get_blob_service_client(config)
        resolved_skill_name = skill_name or _load_active_skill_name(blob_service_client, config, skillset_name)
        if not resolved_skill_name:
            return None, "No active skill is configured in Blob Storage."

        blob_name = _skill_blob_name(config, resolved_skill_name, "skill_logic.py", skillset_name)
        skill_code = _download_text_blob(blob_service_client, config, blob_name)
        if not skill_code:
            return None, f"No deployed skill code found in Blob Storage for {resolved_skill_name}."

        return skill_code, None
    except Exception as exc:
        return None, f"Failed to load skill code from Blob Storage: {exc}"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    active_skill = None
    config = _get_storage_config()
    if config:
        try:
            blob_service_client = _get_blob_service_client(config)
            active_skill = _load_active_skill_name(blob_service_client, config)
        except Exception:
            active_skill = None
    return {
        "status": "ok",
        "version": "0.3.0",
        "activeSkill": active_skill,
        "storageConfigured": config is not None,
    }


@app.post("/simulate", response_model=SimulateResponse)
async def simulate(request: SimulateRequest):
    """
    Execute a Python skill against test input.

    The skill_code must define a `process(input: dict) -> dict` function.
    Each record in `input.values` is processed individually, and the results
    are collected into a Custom Skill Interface response.
    """
    output, elapsed_ms, logs, error = _execute_skill_code(request.skill_code, request.input)
    if error:
        return SimulateResponse(success=False, error=error, logs=logs)

    return SimulateResponse(
        success=True,
        output=output,
        executionTimeMs=elapsed_ms,
        logs=logs,
    )


@app.post("/execute")
async def execute_active_skill(payload: SkillPayload, skillset_name: str | None = None):
    """Azure AI Search WebApiSkill endpoint for the active Blob-backed skill."""
    skill_code, error = _load_deployed_skill(skillset_name=skillset_name)
    if error or not skill_code:
        return _build_error_payload(payload, error or "No deployed skill code found.")

    output, _elapsed_ms, _logs, exec_error = _execute_skill_code(skill_code, payload)
    if exec_error or not output:
        return _build_error_payload(payload, exec_error or "Skill execution failed.")
    return output


@app.post("/skills/{skill_name}")
async def execute_named_skill(skill_name: str, payload: SkillPayload, skillset_name: str | None = None):
    """Optional named endpoint when multiple skills exist in Blob Storage."""
    skill_code, error = _load_deployed_skill(skill_name, skillset_name=skillset_name)
    if error or not skill_code:
        return _build_error_payload(payload, error or "No deployed skill code found.")

    output, _elapsed_ms, _logs, exec_error = _execute_skill_code(skill_code, payload)
    if exec_error or not output:
        return _build_error_payload(payload, exec_error or "Skill execution failed.")
    return output


@app.get("/skills/{skill_name}/code")
async def get_skill_code(skill_name: str, skillset_name: str | None = None):
    """Download the deployed skill code from Blob Storage."""
    config = _get_storage_config()
    if not config:
        raise HTTPException(status_code=500, detail="Blob Storage is not configured.")

    normalized_name = _normalize_skill_name(skill_name)

    try:
        blob_service_client = _get_blob_service_client(config)

        code_blob = _skill_blob_name(config, normalized_name, "skill_logic.py", skillset_name)
        skill_code = _download_text_blob(blob_service_client, config, code_blob)
        if not skill_code:
            raise HTTPException(status_code=404, detail=f"No skill code found for '{normalized_name}'.")

        meta_blob = _skill_blob_name(config, normalized_name, "metadata.json", skillset_name)
        raw_meta = _download_text_blob(blob_service_client, config, meta_blob)
        metadata = json.loads(raw_meta) if raw_meta else {}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load skill code: {exc}") from exc

    return {
        "skillName": normalized_name,
        "skillCode": skill_code,
        "updatedAt": metadata.get("updatedAt"),
        "codeHash": metadata.get("codeHash"),
    }


@app.post("/upload")
async def upload(request: UploadRequest):
    """
    Publish skill code to Blob Storage and switch the active skill.

    When `skillset_name` is provided, the runtime stores files under a
    skillset-namespaced path:
      - {prefix}/{skillset_name}/{skill_name}/skill_logic.py
      - {prefix}/{skillset_name}/{skill_name}/requirements.txt
      - {prefix}/{skillset_name}/{skill_name}/metadata.json
      - {prefix}/{skillset_name}/active-skill.json

    When `skillset_name` is omitted, falls back to a flat path:
      - {prefix}/{skill_name}/skill_logic.py
      - {prefix}/{skill_name}/requirements.txt
      - {prefix}/{skill_name}/metadata.json
      - {prefix}/active-skill.json
    """
    config = _get_storage_config()
    if not config:
        raise HTTPException(
            status_code=500,
            detail="Blob Storage is not configured. Set SKILL_STORAGE_ACCOUNT_URL and SKILL_STORAGE_CONTAINER.",
        )

    skill_name = _normalize_skill_name(request.skill_name)
    skillset_name = request.skillset_name
    updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    code_hash = hashlib.sha256(request.skill_code.encode("utf-8")).hexdigest()

    metadata = {
        "skillName": skill_name,
        "skillsetName": _normalize_skillset_name(skillset_name) or None,
        "updatedAt": updated_at,
        "codeHash": code_hash,
        "metadata": request.metadata or {},
    }

    try:
        blob_service_client = _get_blob_service_client(config)
        _ensure_container(blob_service_client, config)

        _upload_text_blob(
            blob_service_client,
            config,
            _skill_blob_name(config, skill_name, "skill_logic.py", skillset_name),
            request.skill_code,
            "text/x-python",
        )

        if request.requirements_txt is not None:
            _upload_text_blob(
                blob_service_client,
                config,
                _skill_blob_name(config, skill_name, "requirements.txt", skillset_name),
                request.requirements_txt,
                "text/plain",
            )

        _upload_text_blob(
            blob_service_client,
            config,
            _skill_blob_name(config, skill_name, "metadata.json", skillset_name),
            json.dumps(metadata, indent=2),
            "application/json",
        )

        _upload_text_blob(
            blob_service_client,
            config,
            _active_skill_blob_name(config, skillset_name),
            json.dumps(
                {
                    "activeSkill": skill_name,
                    "updatedAt": updated_at,
                },
                indent=2,
            ),
            "application/json",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to upload skill to Blob Storage: {exc}") from exc

    return {
        "success": True,
        "message": f"Skill '{skill_name}' published to Blob Storage.",
        "executePath": "/execute",
        "skillPath": f"/skills/{skill_name}",
        "activeSkill": skill_name,
        "codeHash": code_hash,
    }
