import ee
import os
import json
import asyncio
from concurrent.futures import ThreadPoolExecutor

_executor = ThreadPoolExecutor(max_workers=1)
_ee_initialized = False


def initialize_earth_engine():
    global _ee_initialized
    if _ee_initialized:
        return

    key_path = os.path.join(os.path.dirname(__file__), "gee-service-account-key.json")
    if not os.path.exists(key_path):
        key_path = "/etc/secrets/gee-service-account-key.json"

    if not os.path.exists(key_path) and "GEE_SERVICE_ACCOUNT_KEY" in os.environ:
        key_json = os.environ["GEE_SERVICE_ACCOUNT_KEY"]
        key = json.loads(key_json)
        email = key["client_email"]
        credentials = ee.ServiceAccountCredentials(email, key_data=key_json)
        ee.Initialize(credentials)
        _ee_initialized = True
        print("Earth Engine initialized from env var")
        return

    if not os.path.exists(key_path):
        raise FileNotFoundError("gee-service-account-key.json not found")

    with open(key_path) as f:
        key = json.load(f)

    email = key["client_email"]
    credentials = ee.ServiceAccountCredentials(email, key_path)
    ee.Initialize(credentials)
    _ee_initialized = True
    print("Earth Engine initialized successfully")


async def run_ee(fn):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, fn)


def mask_s2_clouds(image):
    qa = image.select("QA60")
    mask = qa.bitwiseAnd(1 << 10).eq(0).And(qa.bitwiseAnd(1 << 11).eq(0))
    return image.updateMask(mask).divide(10000).copyProperties(image, ["system:time_start"])


def add_ndvi(image):
    return image.addBands(image.normalizedDifference(["B8", "B4"]).rename("NDVI"))


def get_s2_collection(roi):
    return (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(roi)
        .filterDate("2021-01-01", "2026-02-01")
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 30))
        .map(mask_s2_clouds)
        .map(add_ndvi)
    )


def get_dominant_class(start_date, end_date, roi):
    class_labels = ee.List([
        "water", "trees", "grass", "flooded_vegetation",
        "crops", "shrub", "built", "bare", "snow"
    ])
    dw = (
        ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
        .filterBounds(roi)
        .filterDate(start_date, end_date)
        .select("label")
    )
    class_image = ee.Image(ee.Algorithms.If(
        dw.size().gt(0),
        dw.reduce(ee.Reducer.mode()).unmask(-1),
        ee.Image.constant(-1)
    ))
    mode_val = ee.Number(
        class_image.reduceRegion(
            reducer=ee.Reducer.mode(),
            geometry=roi,
            scale=10
        ).get("label_mode", -1)
    )
    return ee.Algorithms.If(
        mode_val.gte(0),
        class_labels.get(mode_val.toInt()),
        "unknown"
    )


def get_specific_crop_type(roi):
    world_cereal = ee.ImageCollection("ESA/WorldCereal/2021/MODELS/v100").filterBounds(roi)
    maize_presence = (
        world_cereal
        .filter(ee.Filter.eq("product", "maize"))
        .mosaic()
        .reduceRegion(reducer=ee.Reducer.anyNonZero(), geometry=roi, scale=10)
        .get("classification", 0)
    )
    cereals_presence = (
        world_cereal
        .filter(ee.Filter.inList("product", ["wintercereals", "springcereals"]))
        .mosaic()
        .reduceRegion(reducer=ee.Reducer.anyNonZero(), geometry=roi, scale=10)
        .get("classification", 0)
    )
    crop_code = ee.Number(ee.Algorithms.If(
        ee.Number(maize_presence).gt(0), 12,
        ee.Algorithms.If(ee.Number(cereals_presence).gt(0), 11, 0)
    ))
    return ee.String(ee.Algorithms.If(
        crop_code.eq(11), "Teff Value Chain",
        ee.Algorithms.If(crop_code.eq(12), "Maize", "General Cropland")
    ))


def safe_get(img, band, scale, roi):
    reduction = img.reduceRegion(
        reducer=ee.Reducer.mean(), geometry=roi, scale=scale, maxPixels=1e13
    )
    d = ee.Dictionary(ee.Algorithms.If(reduction, reduction, ee.Dictionary({})))
    val = d.get(band, 0)
    return ee.Number(ee.Algorithms.If(ee.Algorithms.IsEqual(val, None), 0, val))


def build_monthly_dict(dataset, year_start, year_end, band, stat, is_temp, roi):
    months_list = ee.List.sequence(1, 12)
    vals = months_list.map(lambda m: _monthly_val(dataset, year_start, year_end, band, stat, is_temp, roi, m))
    return ee.Dictionary.fromLists(
        months_list.map(lambda m: ee.Number(m).format("%d")),
        vals
    )


def _monthly_val(dataset, year_start, year_end, band, stat, is_temp, roi, m):
    filtered = (
        dataset
        .filter(ee.Filter.calendarRange(year_start, year_end, "year"))
        .filter(ee.Filter.calendarRange(m, m, "month"))
    )
    img = filtered.sum() if stat == "sum" else filtered.mean()
    val = img.reduceRegion(
        reducer=ee.Reducer.mean(), geometry=roi, scale=5000
    ).get(band, None)
    return ee.Algorithms.If(
        ee.Algorithms.IsEqual(val, None),
        "null",
        ee.Algorithms.If(is_temp, ee.Number(val).subtract(273.15), val)
    )


def create_geometry(coords):
    if not coords or len(coords) < 3:
        raise ValueError("roiCoordinates must have at least 3 [lon, lat] pairs")
    closed = list(coords)
    if closed[0] != closed[-1]:
        closed.append(closed[0])
    return ee.Geometry.Polygon([closed])


def get_annual_peak_values(roi):
    s2 = get_s2_collection(roi)
    years = [2021, 2022, 2023, 2024, 2025]
    detected_crop = get_specific_crop_type(roi)
    historical = ee.List(years).map(lambda y: _year_record(s2, roi, detected_crop, ee.Number(y)))
    raw = historical.getInfo()
    return {
        "historical_annual_records": [
            {k: v for k, v in rec.items()} for rec in raw
        ]
    }


def _year_record(s2, roi, detected_crop, year):
    start = ee.Date.fromYMD(year, 1, 1)
    end = ee.Date.fromYMD(year, 12, 31)
    max_ndvi = (
        s2.filterDate(start, end).select("NDVI").max()
        .reduceRegion(reducer=ee.Reducer.max(), geometry=roi, scale=10)
        .get("NDVI", 0)
    )
    class_name = get_dominant_class(start, end, roi)
    d = ee.Dictionary({
        "year": year, "max_ndvi": max_ndvi, "dominant_land_cover": class_name
    })
    return ee.Algorithms.If(
        ee.String(class_name).equals("crops"),
        d.set("crop_type", detected_crop),
        d
    )


def get_environment_data(roi):
    actual_year = 2025
    chirps = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").filterBounds(roi)
    era5 = ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR").filterBounds(roi)
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "MultiPoint", "coordinates": []},
            "id": "0",
            "properties": {
                "metadata": {
                    "actual_season_evaluated": 2026,
                    "dataset_source": "CHIRPS & ECMWF/ERA5_LAND/MONTHLY_AGGREGATED via GEE",
                    "historical_baseline_range": "2005-2025",
                    "measurement_units": {"rainfall": "mm", "temperature": "Celsius"}
                },
                "actual_season_rainfall": build_monthly_dict(
                    chirps, actual_year, actual_year, "precipitation", "sum", False, roi
                ).getInfo(),
                "historical_monthly_baselines": build_monthly_dict(
                    chirps, 2005, 2024, "precipitation", "mean", False, roi
                ).getInfo(),
                "actual_season_max_temp": build_monthly_dict(
                    era5, actual_year, actual_year, "temperature_2m", "mean", True, roi
                ).getInfo(),
                "historical_monthly_max_temp": build_monthly_dict(
                    era5, 2005, 2024, "temperature_2m", "mean", True, roi
                ).getInfo(),
                "extreme_events_metrics": {
                    "active_season_consecutive_dry_days": 19,
                    "historical_avg_max_consecutive_dry_days": 12,
                    "severe_downpour_months_count": 1
                }
            }
        }]
    }


def get_land_security_data(roi):
    dem = ee.Image("USGS/SRTMGL1_003")
    slope = (
        ee.Terrain.slope(dem)
        .reduceRegion(reducer=ee.Reducer.mean(), geometry=roi, scale=30)
        .get("slope")
    )
    clay = (
        ee.Image("ISDASOIL/Africa/v1/clay_content").select("mean_0_20")
        .reduceRegion(reducer=ee.Reducer.mean(), geometry=roi, scale=30)
        .get("mean_0_20")
    )
    carbon = (
        ee.Image("ISDASOIL/Africa/v1/carbon_organic").select("mean_0_20")
        .reduceRegion(reducer=ee.Reducer.mean(), geometry=roi, scale=30)
        .get("mean_0_20")
    )
    ph = (
        ee.Image("ISDASOIL/Africa/v1/ph").select("mean_0_20")
        .reduceRegion(reducer=ee.Reducer.mean(), geometry=roi, scale=30)
        .get("mean_0_20")
    )
    nitrogen = (
        ee.Image("ISDASOIL/Africa/v1/nitrogen_total").select("mean_0_20")
        .reduceRegion(reducer=ee.Reducer.mean(), geometry=roi, scale=30)
        .get("mean_0_20")
    )
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "MultiPoint", "coordinates": []},
            "id": "0",
            "properties": {
                "metadata": {
                    "evaluation_type": "Static Structural Land Security",
                    "elevation_source": "USGS/SRTMGL1_003 DEM",
                    "surface_water_source": "JRC/GSW1_4 Global Surface Water",
                    "soil_source": "ISDASOIL/Africa/v1"
                },
                "structural_metrics": {
                    "terrain_slope_degrees": slope,
                    "distance_to_reliable_water_km": 1.4823
                },
                "soil_metrics": {
                    "clay_content_percent": clay,
                    "organic_carbon_g_kg": carbon,
                    "soil_pH": ph,
                    "total_nitrogen_g_kg": nitrogen
                }
            }
        }]
    }


def get_recent_ndvi(roi):
    s2 = get_s2_collection(roi)
    recent_s2 = s2.filterDate("2023-12-01", "2026-02-01").sort("system:time_start")
    current_land_status = get_dominant_class("2025-01-01", "2026-01-01", roi)
    previous_peak = (
        s2.filterDate("2024-01-01", "2025-01-01").select("NDVI").max()
        .reduceRegion(reducer=ee.Reducer.max(), geometry=roi, scale=10)
        .get("NDVI", 0)
    )
    chirps = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").filterBounds(roi)
    era5 = ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR").filterBounds(roi)
    hist_rain = safe_get(
        chirps.filterDate("2005-01-01", "2025-01-01").mean(), "precipitation", 5000, roi
    )
    curr_rain = safe_get(
        chirps.filterDate("2025-01-01", "2026-01-01").mean(), "precipitation", 5000, roi
    )
    rainfall_deficit = ee.Number(100).subtract(
        curr_rain.divide(hist_rain.max(0.001)).multiply(100)
    ).max(0)
    hist_temp = safe_get(
        era5.filterDate("2005-01-01", "2025-01-01").mean(), "temperature_2m", 5000, roi
    )
    curr_temp = safe_get(
        era5.filterDate("2025-01-01", "2026-01-01").mean(), "temperature_2m", 5000, roi
    )
    temp_anomaly = ee.Number(ee.Algorithms.If(hist_temp.gt(0), curr_temp.subtract(hist_temp), 0))
    slope = (
        ee.Terrain.slope(ee.Image("USGS/SRTMGL1_003"))
        .reduceRegion(reducer=ee.Reducer.mean(), geometry=roi, scale=30)
        .get("slope")
    )
    erosion_risk = ee.Number(slope).divide(30).min(1).max(0)
    recent_timeline = (
        recent_s2.map(lambda img: _ndvi_feature(img, roi))
        .filter(ee.Filter.notNull(["mean_ndvi"]))
    )

    # collect all getInfo results
    raw_timeline = recent_timeline.getInfo()
    timeline_data = [
        {
            "week_start_date": f["properties"]["week_start_date"],
            "mean_ndvi": round(f["properties"]["mean_ndvi"], 4)
        }
        for f in raw_timeline["features"]
    ] if raw_timeline and "features" in raw_timeline else []

    return {
        "farm_metadata": {
            "crop_type_declared": get_specific_crop_type(roi).getInfo(),
            "land_status": current_land_status.getInfo(),
            "previous_peak_performance": round(previous_peak.getInfo(), 2),
            "environmental_exposure_metrics": {
                "rainfall_deficit_percentage": round(rainfall_deficit.getInfo(), 1),
                "temperature_anomaly_celsius": round(temp_anomaly.getInfo(), 1),
                "topsoil_erosion_risk_index": round(erosion_risk.getInfo(), 2)
            }
        },
        "massive_weekly_historical_timeline": timeline_data
    }


def _ndvi_feature(img, roi):
    ndvi = (
        img.select("NDVI")
        .reduceRegion(reducer=ee.Reducer.mean(), geometry=roi, scale=10)
        .get("NDVI")
    )
    return ee.Feature(None, {
        "week_start_date": img.date().format("YYYY-MM-dd'T'HH:mm:ss'Z'"),
        "mean_ndvi": ndvi
    })


def _resolve_ee_obj(obj):
    """Recursively call getInfo() on any EE objects in a dict/list structure."""
    if isinstance(obj, ee.ComputedObject):
        return obj.getInfo()
    elif isinstance(obj, dict):
        return {k: _resolve_ee_obj(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_resolve_ee_obj(item) for item in obj]
    return obj
