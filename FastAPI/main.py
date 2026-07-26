import os
import time
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional

from gee_helper import (
    initialize_earth_engine,
    create_geometry,
    get_annual_peak_values,
    get_environment_data,
    get_land_security_data,
    get_recent_ndvi,
    _resolve_ee_obj,
    run_ee,
)

app = FastAPI(
    title="Agri-Lend Geospatial Telemetry API",
    description="API for querying satellite-derived farm data (NDVI, rainfall, temperature, soil metrics)",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RoiRequest(BaseModel):
    roiCoordinates: list[list[float]] = Field(
        ..., description="Polygon vertices as [[lon, lat], ...] (min 3 pairs)"
    )
    farmId: Optional[str] = Field(None, description="Optional farm identifier")


@app.on_event("startup")
def startup():
    initialize_earth_engine()


def validate_roi(req: RoiRequest):
    if not req.roiCoordinates or len(req.roiCoordinates) < 3:
        raise HTTPException(
            status_code=400,
            detail={
                "success": False,
                "error": "roiCoordinates must have at least 3 [lon, lat] pairs",
                "example": {
                    "roiCoordinates": [
                        [38.80507383455457, 8.894908870559417],
                        [38.805165029661076, 8.894744573515876],
                        [38.80527231802167, 8.894559076765212],
                        [38.8054761659068, 8.894686274547222],
                    ],
                    "farmId": "farm-123",
                },
            },
        )
    return create_geometry(req.roiCoordinates)


def make_response(data, farm_id: str = None, compute_time: float = None):
    resp = {
        "success": True,
        "data": data,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "farm_id": farm_id or "not-specified",
        },
    }
    if compute_time is not None:
        resp["metadata"]["compute_time_ms"] = round(compute_time, 2)
    return resp


def make_error(message: str):
    return {
        "success": False,
        "error": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/")
def root():
    return {
        "message": "Agri-Lend Geospatial API",
        "docs": "GET /api/v1/docs",
        "health": "GET /api/v1/health",
    }


@app.get("/api/v1/health")
def health():
    return {
        "success": True,
        "status": "ok",
        "service": "Agri-Lend Geospatial Telemetry API",
        "version": "1.0.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/v1/docs")
def docs():
    return {
        "service": "Agri-Lend Geospatial Telemetry API",
        "version": "1.0.0",
        "base_url": "https://agri-lend-api.onrender.com",
        "request_format": {
            "method": "POST",
            "headers": {"Content-Type": "application/json"},
            "body": {
                "roiCoordinates": "[[lon, lat], [lon, lat], ...]  polygon vertices",
                "farmId": "optional string identifier",
            },
        },
        "endpoints": [
            {
                "name": "Get All Telemetry Data",
                "method": "POST",
                "path": "/api/v1/farms/telemetry",
                "description": "Returns annual peaks, environment, land security, and NDVI in one call",
                "example_request": {
                    "roiCoordinates": [[38.5, 8.5], [38.6, 8.5], [38.6, 8.6], [38.5, 8.6]],
                    "farmId": "farm-001",
                },
            },
            {
                "name": "Get Annual Peaks",
                "method": "POST",
                "path": "/api/v1/farms/annual-peaks",
                "description": "NDVI peak values per year (2021-2025) with dominant land cover and detected crop type",
            },
            {
                "name": "Get Environment Data",
                "method": "POST",
                "path": "/api/v1/farms/environment",
                "description": "Monthly rainfall & temperature for actual season vs historical baseline (2005-2025)",
            },
            {
                "name": "Get Land Security",
                "method": "POST",
                "path": "/api/v1/farms/land-security",
                "description": "Soil metrics (clay, organic carbon, pH, nitrogen), terrain slope, distance to water",
            },
            {
                "name": "Get NDVI Timeline",
                "method": "POST",
                "path": "/api/v1/farms/ndvi",
                "description": "Weekly mean NDVI values (2023-2026), crop type, environmental exposure metrics",
            },
            {
                "name": "Health Check",
                "method": "GET",
                "path": "/api/v1/health",
                "description": "API status check",
            },
        ],
    }


@app.post("/api/v1/farms/telemetry")
def telemetry(req: RoiRequest):
    start = time.time()
    roi = validate_roi(req)
    annual_peaks = get_annual_peak_values(roi)
    env_data = _resolve_ee_obj(get_environment_data(roi))
    land_security = _resolve_ee_obj(get_land_security_data(roi))
    ndvi = get_recent_ndvi(roi)
    elapsed = (time.time() - start) * 1000
    return make_response(
        {
            "annual_peak_values": annual_peaks,
            "environment_data": env_data,
            "land_security_data": land_security,
            "recent_ndvi": ndvi,
        },
        farm_id=req.farmId,
        compute_time=elapsed,
    )


@app.post("/api/v1/farms/annual-peaks")
def annual_peaks(req: RoiRequest):
    roi = validate_roi(req)
    data = get_annual_peak_values(roi)
    return make_response(data, farm_id=req.farmId)


@app.post("/api/v1/farms/environment")
def environment(req: RoiRequest):
    roi = validate_roi(req)
    data = _resolve_ee_obj(get_environment_data(roi))
    return make_response(data, farm_id=req.farmId)


@app.post("/api/v1/farms/land-security")
def land_security(req: RoiRequest):
    roi = validate_roi(req)
    data = _resolve_ee_obj(get_land_security_data(roi))
    return make_response(data, farm_id=req.farmId)


@app.post("/api/v1/farms/ndvi")
def ndvi(req: RoiRequest):
    roi = validate_roi(req)
    data = get_recent_ndvi(roi)
    return make_response(data, farm_id=req.farmId)


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 5001))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
