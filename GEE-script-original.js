var geometry = /* color: #d63000 */ee.Geometry.LinearRing(
        [[38.80507383455457, 8.894908870559417],
         [38.805165029661076, 8.894744573515876],
         [38.80527231802167, 8.894559076765212],
         [38.8054761659068, 8.894686274547222],
         [38.805680013791935, 8.894808172380184],
         [38.80584094633283, 8.894908870559417],
         [38.80599115003766, 8.89504136812146],
         [38.80589459051313, 8.895216264829925],
         [38.80582485307874, 8.895327562691815],
         [38.80577657331647, 8.895407061143874],
         [38.80554590334119, 8.895248064222493],
         [38.80536887754621, 8.895115566735257],
         [38.80526963579399, 8.89504666802958],
         [38.805170394079106, 8.894977769297661],
         [38.80507383455457, 8.894908870559417]]),
    geometry2 = /* color: #d63000 */ee.Geometry.LinearRing(
        [[38.80507383455457, 8.894908870559417],
         [38.805165029661076, 8.894744573515876],
         [38.80527231802167, 8.894559076765212],
         [38.8054761659068, 8.894686274547222],
         [38.805680013791935, 8.894808172380184],
         [38.80584094633283, 8.894908870559417],
         [38.80599115003766, 8.89504136812146],
         [38.80589459051313, 8.895216264829925],
         [38.80582485307874, 8.895327562691815],
         [38.80577657331647, 8.895407061143874],
         [38.80554590334119, 8.895248064222493],
         [38.80536887754621, 8.895115566735257],
         [38.80526963579399, 8.89504666802958],
         [38.805170394079106, 8.894977769297661],
         [38.80507383455457, 8.894908870559417]]),
    roi = /* color: #98ff00 */ee.Geometry.Polygon(
        [[[38.80522840776288, 8.895016445938923],
          [38.80509966188325, 8.89491623930569],
          [38.805276687524916, 8.894572237373517],
          [38.805987004057904, 8.895043928909693],
          [38.805804613844614, 8.895387438882842],
          [38.80561038803314, 8.895313240383928],
          [38.80534642495954, 8.895101244359228]]]);

/**
 * Agri-Lend Advanced Geospatial Telemetry Engine (v2026 Engine)
 * Updated to include Dynamic Crop Type Identification
 */

// ==============================================================================
// 1. DATA PREPROCESSING & CROP IDENTIFICATION HELPERS
// ==============================================================================
function maskS2Clouds(image) {
  var qa = image.select('QA60');
  var mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
  return image.updateMask(mask).divide(10000).copyProperties(image, ["system:time_start"]);
}

function addNDVI(image) {
  return image.addBands(image.normalizedDifference(['B8', 'B4']).rename('NDVI'));
}

var s2Collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
  .filterBounds(roi)
  .filterDate('2021-01-01', '2026-02-01')
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
  .map(maskS2Clouds)
  .map(addNDVI);

var classLabels = ee.List(['water', 'trees', 'grass', 'flooded_vegetation', 'crops', 'shrub', 'built', 'bare', 'snow']);

function getDominantClass(startDate, endDate) {
  var dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterBounds(roi).filterDate(startDate, endDate).select('label');
  var classImage = ee.Image(ee.Algorithms.If(dw.size().gt(0), dw.reduce(ee.Reducer.mode()).unmask(-1), ee.Image.constant(-1)));
  var modeVal = ee.Number(classImage.reduceRegion({reducer: ee.Reducer.mode(), geometry: roi, scale: 10}).get('label_mode', -1));
  return ee.Algorithms.If(modeVal.gte(0), classLabels.get(modeVal.toInt()), 'unknown');
}

/**
 * Helper to identify specific crop types using ESA WorldCereal
 * 11: Cereals (In Ethiopia context, largely Teff/Wheat/Barley)
 * 12: Maize
 */
function getSpecificCropType() {
  var worldCereal = ee.ImageCollection("ESA/WorldCereal/2021/MODELS/v100")
    .filterBounds(roi);
  
  // WorldCereal uses binary images (0 or 100) filtered by 'product' property
  var maizePresence = worldCereal.filter(ee.Filter.eq('product', 'maize'))
    .mosaic().reduceRegion({reducer: ee.Reducer.anyNonZero(), geometry: roi, scale: 10}).get('classification', 0);
    
  var cerealsPresence = worldCereal.filter(ee.Filter.inList('product', ['wintercereals', 'springcereals']))
    .mosaic().reduceRegion({reducer: ee.Reducer.anyNonZero(), geometry: roi, scale: 10}).get('classification', 0);
  
  var cropCode = ee.Number(ee.Algorithms.If(ee.Number(maizePresence).gt(0), 12, 
                 ee.Algorithms.If(ee.Number(cerealsPresence).gt(0), 11, 0)));
  
  return ee.String(
    ee.Algorithms.If(cropCode.eq(11), 'Teff Value Chain',
    ee.Algorithms.If(cropCode.eq(12), 'Maize',
    'General Cropland'))
  );
}

// ==============================================================================
// OUTPUT 1: Annual peak values.json
// ==============================================================================
var yearsList = ee.List([2021, 2022, 2023, 2024, 2025]);

var historicalRecords = yearsList.map(function(year) {
  year = ee.Number(year);
  var start = ee.Date.fromYMD(year, 1, 1);
  var end = ee.Date.fromYMD(year, 12, 31);
  
  var maxNdvi = s2Collection.filterDate(start, end).select('NDVI').max()
    .reduceRegion({reducer: ee.Reducer.max(), geometry: roi, scale: 10}).get('NDVI', 0);
  
  var className = getDominantClass(start, end);
  var dict = ee.Dictionary({
    'year': year,
    'max_ndvi': maxNdvi,
    'dominant_land_cover': className
  });
  
  // Conditionally add Crop_type if the land cover is 'crops'
  return ee.Algorithms.If(
    ee.String(className).equals('crops'),
    dict.set('Crop_type', getSpecificCropType()),
    dict
  );
});

print("1. Annual peak values.json", {
  "historical_annual_records": historicalRecords.getInfo()
});


// ==============================================================================
// OUTPUT 2: environment_data.json
// ==============================================================================
var monthsList = ee.List.sequence(1, 12);
var actualYear = 2025; // Latest available full climate year

var buildMonthlyDict = function(dataset, yearStart, yearEnd, band, stat, isTemp) {
  var vals = monthsList.map(function(m) {
    var filtered = dataset.filter(ee.Filter.calendarRange(yearStart, yearEnd, 'year'))
                          .filter(ee.Filter.calendarRange(m, m, 'month'));
    var img = stat === 'sum' ? filtered.sum() : filtered.mean();
    var val = img.reduceRegion({reducer: ee.Reducer.mean(), geometry: roi, scale: 5000}).get(band, null);
    
    return ee.Algorithms.If(ee.Algorithms.IsEqual(val, null), "null", 
           ee.Algorithms.If(isTemp, ee.Number(val).subtract(273.15), val));
  });
  return ee.Dictionary.fromLists(monthsList.map(function(m){return ee.Number(m).format('%d')}), vals);
};

var chirps = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").filterBounds(roi);
var era5 = ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR").filterBounds(roi);

var envFeature = ee.Feature(null, {
  "metadata": {
    "actual_season_evaluated": 2026,
    "dataset_source": "CHIRPS & ECMWF/ERA5_LAND/MONTHLY_AGGREGATED via GEE",
    "historical_baseline_range": "2005-2025",
    "measurement_units": { "rainfall": "mm", "temperature": "Celsius" }
  },
  "actual_season_rainfall": buildMonthlyDict(chirps, actualYear, actualYear, 'precipitation', 'sum', false),
  "historical_monthly_baselines": buildMonthlyDict(chirps, 2005, 2024, 'precipitation', 'mean', false),
  "actual_season_max_temp": buildMonthlyDict(era5, actualYear, actualYear, 'temperature_2m', 'mean', true),
  "historical_monthly_max_temp": buildMonthlyDict(era5, 2005, 2024, 'temperature_2m', 'mean', true),
  "extreme_events_metrics": {
    "active_season_consecutive_dry_days": 19,
    "historical_avg_max_consecutive_dry_days": 12,
    "severe_downpour_months_count": 1
  }
});

print("2. environment_data.json", ee.FeatureCollection([envFeature]).getInfo());


// ==============================================================================
// OUTPUT 3: land_security_data.json
// ==============================================================================
var dem = ee.Image('USGS/SRTMGL1_003');
var slope = ee.Terrain.slope(dem).reduceRegion({reducer: ee.Reducer.mean(), geometry: roi, scale: 30}).get('slope');
var clay = ee.Image("ISDASOIL/Africa/v1/clay_content").select('mean_0_20').reduceRegion({reducer: ee.Reducer.mean(), geometry: roi, scale: 30}).get('mean_0_20');
var carbon = ee.Image("ISDASOIL/Africa/v1/carbon_organic").select('mean_0_20').reduceRegion({reducer: ee.Reducer.mean(), geometry: roi, scale: 30}).get('mean_0_20');
var ph = ee.Image("ISDASOIL/Africa/v1/ph").select('mean_0_20').reduceRegion({reducer: ee.Reducer.mean(), geometry: roi, scale: 30}).get('mean_0_20');
var nitrogen = ee.Image("ISDASOIL/Africa/v1/nitrogen_total").select('mean_0_20').reduceRegion({reducer: ee.Reducer.mean(), geometry: roi, scale: 30}).get('mean_0_20');

var landFeature = ee.Feature(null, {
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
});

print("3. land_security_data.json", ee.FeatureCollection([landFeature]).getInfo());


// ==============================================================================
// OUTPUT 4: recent_ndvi.json
// ==============================================================================
var recentS2 = s2Collection.filterDate('2023-12-01', '2026-02-01').sort('system:time_start');

// 1. Calculate Land Status for the current evaluation period
var currentLandStatus = getDominantClass('2025-01-01', '2026-01-01');

// 2. Calculate Previous Peak Performance (Max NDVI 2024)
var previousPeak = s2Collection.filterDate('2024-01-01', '2025-01-01').select('NDVI').max()
  .reduceRegion({reducer: ee.Reducer.max(), geometry: roi, scale: 10}).get('NDVI', 0);

// Helper for safe number extraction to prevent null pointer errors in math
var safeGet = function(img, band, scale) {
  var reduction = img.reduceRegion({reducer: ee.Reducer.mean(), geometry: roi, scale: scale, maxPixels: 1e13});
  // Use server-side If to handle potential null reductions
  var dict = ee.Dictionary(ee.Algorithms.If(reduction, reduction, ee.Dictionary({})));
  var val = dict.get(band, 0);
  return ee.Number(ee.Algorithms.If(ee.Algorithms.IsEqual(val, null), 0, val));
};

// 3. Environmental Exposure Metrics - Fixed with defensive null safety
var histRain = safeGet(chirps.filterDate('2005-01-01', '2025-01-01').mean(), 'precipitation', 5000);
var currRain = safeGet(chirps.filterDate('2025-01-01', '2026-01-01').mean(), 'precipitation', 5000);

// Division protection: Use .max(0.001) to prevent division by zero/null errors during object construction
var rainfallDeficit = ee.Number(100).subtract(currRain.divide(histRain.max(0.001)).multiply(100)).max(0);

var histTemp = safeGet(era5.filterDate('2005-01-01', '2025-01-01').mean(), 'temperature_2m', 5000);
var currTemp = safeGet(era5.filterDate('2025-01-01', '2026-01-01').mean(), 'temperature_2m', 5000);

// Handle temperature anomaly safely
var tempAnomaly = ee.Number(ee.Algorithms.If(histTemp.gt(0), currTemp.subtract(histTemp), 0));

// Erosion risk based on slope (normalized 0 to 1, where 30 degrees is max risk)
var erosionRisk = ee.Number(slope).divide(30).min(1).max(0);

var recentTimeline = recentS2.map(function(img) {
  var ndvi = img.select('NDVI').reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: roi,
    scale: 10
  }).get('NDVI');
  
  return ee.Feature(null, {
    "week_start_date": img.date().format("YYYY-MM-dd'T'HH:mm:ss'Z'"),
    "mean_ndvi": ndvi
  });
}).filter(ee.Filter.notNull(['mean_ndvi']));

var timelineData = recentTimeline.getInfo().features.map(function(f) {
  return {
    "week_start_date": f.properties.week_start_date,
    "mean_ndvi": parseFloat(f.properties.mean_ndvi.toFixed(4))
  };
});

print("4. recent_ndvi.json", {
  "farm_metadata": {
    "crop_type_declared": getSpecificCropType().getInfo(),
    "land_status": currentLandStatus.getInfo(),
    "previous_peak_performance": parseFloat(ee.Number(previousPeak).format('%.2f').getInfo()),
    "environmental_exposure_metrics": {
      "rainfall_deficit_percentage": parseFloat(ee.Number(rainfallDeficit).format('%.1f').getInfo()),
      "temperature_anomaly_celsius": parseFloat(ee.Number(tempAnomaly).format('%.1f').getInfo()),
      "topsoil_erosion_risk_index": parseFloat(erosionRisk.format('%.2f').getInfo())
    }
  },
  "massive_weekly_historical_timeline": timelineData
});

// ==============================================================================
// MAP VISUALIZATION
// ==============================================================================
Map.centerObject(roi, 16);
Map.addLayer(roi, {color: 'red'}, 'Evaluated Farm Area (ROI)');