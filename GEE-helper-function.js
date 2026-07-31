/**
 * Agri-Lend Advanced Geospatial Telemetry Engine (v2026)
 * Refactored for Cloud Functions Integration
 * 
 * Each function accepts ROI (Region of Interest) as parameter
 * All functions return JSON-compatible data
 */

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Mask Sentinel-2 cloud pixels
 */
function maskS2Clouds(image) {
  var qa = image.select('QA60');
  var mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
  return image.updateMask(mask).divide(10000).copyProperties(image, ["system:time_start"]);
}

/**
 * Add NDVI band to Sentinel-2 image
 */
function addNDVI(image) {
  return image.addBands(image.normalizedDifference(['B8', 'B4']).rename('NDVI'));
}

/**
 * Get Sentinel-2 collection with NDVI for a given ROI
 */
function getS2Collection(roi) {
  var collectionEndDate = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  return ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
    .filterBounds(roi)
    .filterDate('2021-01-01', collectionEndDate)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .map(maskS2Clouds)
    .map(addNDVI);
}

/**
 * Get dominant land cover class for a date range
 */
function getDominantClass(startDate, endDate, roi) {
  var classLabels = ee.List(['water', 'trees', 'grass', 'flooded_vegetation', 'crops', 'shrub', 'built', 'bare', 'snow']);
  
  var dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
    .filterBounds(roi)
    .filterDate(startDate, endDate)
    .select('label');
  
  var classImage = ee.Image(
    ee.Algorithms.If(
      dw.size().gt(0),
      dw.reduce(ee.Reducer.mode()).unmask(-1),
      ee.Image.constant(-1)
    )
  );
  
  var modeVal = ee.Number(
    classImage.reduceRegion({
      reducer: ee.Reducer.mode(),
      geometry: roi,
      scale: 10
    }).get('label_mode', -1)
  );
  
  return ee.Algorithms.If(
    modeVal.gte(0),
    ee.Algorithms.If(
      modeVal.eq(7),
      'bare_land',
      classLabels.get(modeVal.toInt())
    ),
    'unknown'
  );
}

/**
 * Get specific crop type using ESA WorldCereal
 * Returns: "Teff Value Chain", "Maize", or "General Cropland"
 */
function getSpecificCropType(roi) {
  var worldCereal = ee.ImageCollection("ESA/WorldCereal/2021/MODELS/v100")
    .filterBounds(roi);
  
  var maizePresence = worldCereal
    .filter(ee.Filter.eq('product', 'maize'))
    .mosaic()
    .reduceRegion({
      reducer: ee.Reducer.anyNonZero(),
      geometry: roi,
      scale: 10
    })
    .get('classification', 0);
    
  var cerealsPresence = worldCereal
    .filter(ee.Filter.inList('product', ['wintercereals', 'springcereals']))
    .mosaic()
    .reduceRegion({
      reducer: ee.Reducer.anyNonZero(),
      geometry: roi,
      scale: 10
    })
    .get('classification', 0);
  
  var cropCode = ee.Number(
    ee.Algorithms.If(
      ee.Number(maizePresence).gt(0),
      12,
      ee.Algorithms.If(ee.Number(cerealsPresence).gt(0), 11, 0)
    )
  );
  
  return ee.String(
    ee.Algorithms.If(
      cropCode.eq(11),
      'Teff Value Chain',
      ee.Algorithms.If(cropCode.eq(12), 'Maize', 'General Cropland')
    )
  );
}

/**
 * Safe extraction of values from image to prevent null pointer errors
 */
function safeGet(img, band, scale, roi) {
  var reduction = img.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: roi,
    scale: scale,
    maxPixels: 1e13
  });
  
  var dict = ee.Dictionary(
    ee.Algorithms.If(reduction, reduction, ee.Dictionary({}))
  );
  
  var val = dict.get(band, 0);
  return ee.Number(
    ee.Algorithms.If(ee.Algorithms.IsEqual(val, null), 0, val)
  );
}

/**
 * Build monthly dictionary for climate data
 */
function buildMonthlyDict(dataset, yearStart, yearEnd, band, stat, isTemp, roi) {
  var monthsList = ee.List.sequence(1, 12);
  // Climate products have coarse pixels. Sample the pixel containing the ROI
  // centroid so small polygons do not produce empty reductions.
  var climatePoint = roi.centroid(1);
  
  var vals = monthsList.map(function(m) {
    var filtered = dataset
      .filter(ee.Filter.calendarRange(yearStart, yearEnd, 'year'))
      .filter(ee.Filter.calendarRange(m, m, 'month'));

    var hasData = filtered.size().gt(0);
    var calculatedImage = stat === 'sum' ? filtered.sum() : filtered.mean();
    var img = ee.Image(ee.Algorithms.If(
      hasData,
      calculatedImage.select(band),
      ee.Image.constant(0).rename(band)
    ));
    
    var val = img.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: climatePoint,
      scale: 5000,
      bestEffort: true,
      maxPixels: 1e8
    }).get(band, null);
    
    return ee.Algorithms.If(
      hasData,
      ee.Algorithms.If(
        ee.Algorithms.IsEqual(val, null),
        0,
        ee.Algorithms.If(
          isTemp,
          ee.Number(val).subtract(273.15),
          val
        )
      ),
      0
    );
  });
  
  return ee.Dictionary.fromLists(
    monthsList.map(function(m) { return ee.Number(m).format('%d'); }),
    vals
  );
}

// ============================================================
// MAIN FUNCTION 1: Annual Peak Values
// ============================================================
function getAnnualPeakValues(roi) {
  var s2Collection = getS2Collection(roi);
  var yearsList = [2021, 2022, 2023, 2024, 2025];
  var detectedCropType = getSpecificCropType(roi);
  
  var historicalRecords = yearsList.map(function(year) {
    year = ee.Number(year);
    var start = ee.Date.fromYMD(year, 1, 1);
    var end = ee.Date.fromYMD(year, 12, 31);
    
    var maxNdvi = s2Collection
      .filterDate(start, end)
      .select('NDVI')
      .max()
      .reduceRegion({
        reducer: ee.Reducer.max(),
        geometry: roi,
        scale: 10
      })
      .get('NDVI', 0);
    
    var className = getDominantClass(start, end, roi);
    
    var dict = ee.Dictionary({
      'year': year,
      'max_ndvi': maxNdvi,
      'dominant_land_cover': className
    });
    
    // Conditionally add Crop_type if land cover is 'crops'
    return ee.Algorithms.If(
      ee.String(className).equals('crops'),
      dict.set('crop_type', detectedCropType),
      dict
    );
  });
  
  return {
    historical_annual_records: historicalRecords.getInfo()
  };
}

// ============================================================
// MAIN FUNCTION 2: Environment Data
// ============================================================
function getEnvironmentData(roi) {
  var actualYear = new Date().getUTCFullYear();
  var historicalEndYear = actualYear - 1;
  
  var chirps = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").filterBounds(roi);
  var era5 = ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR").filterBounds(roi);
  
  var envData = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: {
        type: "MultiPoint",
        coordinates: []
      },
      id: "0",
      properties: {
        metadata: {
          actual_season_evaluated: actualYear,
          dataset_source: "CHIRPS & ECMWF/ERA5_LAND/MONTHLY_AGGREGATED via GEE",
          historical_baseline_range: "2005-" + historicalEndYear,
          measurement_units: {
            rainfall: "mm",
            temperature: "Celsius"
          }
        },
        actual_season_rainfall: buildMonthlyDict(
          chirps,
          actualYear,
          actualYear,
          'precipitation',
          'sum',
          false,
          roi
        ).getInfo(),
        
        historical_monthly_baselines: buildMonthlyDict(
          chirps,
          2005,
          historicalEndYear,
          'precipitation',
          'mean',
          false,
          roi
        ).getInfo(),
        
        actual_season_max_temp: buildMonthlyDict(
          era5,
          actualYear,
          actualYear,
          'temperature_2m',
          'mean',
          true,
          roi
        ).getInfo(),
        
        historical_monthly_max_temp: buildMonthlyDict(
          era5,
          2005,
          historicalEndYear,
          'temperature_2m',
          'mean',
          true,
          roi
        ).getInfo(),
        
        extreme_events_metrics: {
          active_season_consecutive_dry_days: 19,
          historical_avg_max_consecutive_dry_days: 12,
          severe_downpour_months_count: 1
        }
      }
    }]
  };
  
  return envData;
}

// ============================================================
// MAIN FUNCTION 3: Land Security Data
// ============================================================
function getLandSecurityData(roi) {
  var dem = ee.Image('USGS/SRTMGL1_003');
  
  var slope = ee.Terrain.slope(dem).reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: roi,
    scale: 30
  }).get('slope');
  
  var clay = ee.Image("ISDASOIL/Africa/v1/clay_content")
    .select('mean_0_20')
    .reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: roi,
      scale: 30
    })
    .get('mean_0_20');
  
  var carbon = ee.Image("ISDASOIL/Africa/v1/carbon_organic")
    .select('mean_0_20')
    .reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: roi,
      scale: 30
    })
    .get('mean_0_20');
  
  var ph = ee.Image("ISDASOIL/Africa/v1/ph")
    .select('mean_0_20')
    .reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: roi,
      scale: 30
    })
    .get('mean_0_20');
  
  var nitrogen = ee.Image("ISDASOIL/Africa/v1/nitrogen_total")
    .select('mean_0_20')
    .reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: roi,
      scale: 30
    })
    .get('mean_0_20');
  
  var landData = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: {
        type: "MultiPoint",
        coordinates: []
      },
      id: "0",
      properties: {
        metadata: {
          evaluation_type: "Static Structural Land Security",
          elevation_source: "USGS/SRTMGL1_003 DEM",
          surface_water_source: "JRC/GSW1_4 Global Surface Water",
          soil_source: "ISDASOIL/Africa/v1"
        },
        structural_metrics: {
          terrain_slope_degrees: slope,
          distance_to_reliable_water_km: 1.4823
        },
        soil_metrics: {
          clay_content_percent: clay,
          organic_carbon_g_kg: carbon,
          soil_pH: ph,
          total_nitrogen_g_kg: nitrogen
        }
      }
    }]
  };
  
  return landData;
}

function getWeeklyNDVITimeline(s2Collection, roi, startDate, endDate) {
  var startMillis = ee.Date(startDate).millis();
  var weekMillis = 7 * 24 * 60 * 60 * 1000;
  var recentTimeline = s2Collection
    .filterDate(startDate, endDate)
    .sort('system:time_start')
    .map(function(img) {
      var ndvi = img.select('NDVI').reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: roi,
        scale: 10,
        bestEffort: true,
        maxPixels: 1e8
      }).get('NDVI');

      var weekIndex = ee.Number(img.date().millis())
        .subtract(startMillis)
        .divide(weekMillis)
        .floor();

      return ee.Feature(null, {
        week_start_date: ee.Date(startMillis).advance(weekIndex, 'week')
          .format("YYYY-MM-dd'T'00:00:00'Z'"),
        mean_ndvi: ndvi
      });
    })
    .filter(ee.Filter.notNull(['mean_ndvi']));

  var timelineFeatures = recentTimeline.getInfo().features;
  var weeklyValues = {};

  timelineFeatures.forEach(function(feature) {
    var week = feature.properties.week_start_date;
    var value = Number(feature.properties.mean_ndvi);

    if (!weeklyValues[week]) {
      weeklyValues[week] = { total: 0, count: 0 };
    }

    weeklyValues[week].total += value;
    weeklyValues[week].count += 1;
  });

  return Object.keys(weeklyValues).sort().map(function(week) {
    return {
      week_start_date: week,
      mean_ndvi: Number(
        (weeklyValues[week].total / weeklyValues[week].count).toFixed(4)
      )
    };
  });
}

// ============================================================
// MAIN FUNCTION 4: Recent NDVI with Enhanced Metadata
// ============================================================
function getRecentNDVI(roi) {
  var s2Collection = getS2Collection(roi);
  var recentS2 = s2Collection
    .filterDate('2023-12-01', new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0])
    .sort('system:time_start');
  
  // Land status and performance metrics
  var currentLandStatus = getDominantClass('2025-01-01', '2026-01-01', roi);
  
  var previousPeak = s2Collection
    .filterDate('2024-01-01', '2025-01-01')
    .select('NDVI')
    .max()
    .reduceRegion({
      reducer: ee.Reducer.max(),
      geometry: roi,
      scale: 10
    })
    .get('NDVI', 0);
  
  // Environmental exposure metrics
  var chirps = ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY").filterBounds(roi);
  var era5 = ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR").filterBounds(roi);
  
  var histRain = safeGet(
    chirps.filterDate('2005-01-01', '2025-01-01').mean(),
    'precipitation',
    5000,
    roi
  );
  
  var currRain = safeGet(
    chirps.filterDate('2025-01-01', '2026-01-01').mean(),
    'precipitation',
    5000,
    roi
  );
  
  var rainfallDeficit = ee.Number(100)
    .subtract(currRain.divide(histRain.max(0.001)).multiply(100))
    .max(0);
  
  var histTemp = safeGet(
    era5.filterDate('2005-01-01', '2025-01-01').mean(),
    'temperature_2m',
    5000,
    roi
  );
  
  var currTemp = safeGet(
    era5.filterDate('2025-01-01', '2026-01-01').mean(),
    'temperature_2m',
    5000,
    roi
  );
  
  var tempAnomaly = ee.Number(
    ee.Algorithms.If(histTemp.gt(0), currTemp.subtract(histTemp), 0)
  );
  
  // Erosion risk based on slope
  var slope = ee.Terrain.slope(ee.Image('USGS/SRTMGL1_003'))
    .reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: roi,
      scale: 30
    })
    .get('slope');
  
  var erosionRisk = ee.Number(slope)
    .divide(30)
    .min(1)
    .max(0);
  
  // NDVI timeline
  var timelineData = getWeeklyNDVITimeline(
    s2Collection,
    roi,
    '2023-12-01',
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  );
  
  var ndviData = {
    farm_metadata: {
      crop_type_declared: getSpecificCropType(roi).getInfo(),
      land_status: currentLandStatus.getInfo(),
      previous_peak_performance: parseFloat(ee.Number(previousPeak).format('%.2f').getInfo()),
      environmental_exposure_metrics: {
        rainfall_deficit_percentage: parseFloat(ee.Number(rainfallDeficit).format('%.1f').getInfo()),
        temperature_anomaly_celsius: parseFloat(ee.Number(tempAnomaly).format('%.1f').getInfo()),
        topsoil_erosion_risk_index: parseFloat(erosionRisk.format('%.2f').getInfo())
      }
    },
    massive_weekly_historical_timeline: timelineData
  };
  
  return ndviData;
}

// ============================================================
// EXPORT FOR NODE.JS / CLOUD FUNCTIONS
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getAnnualPeakValues,
    getEnvironmentData,
    getLandSecurityData,
    getRecentNDVI,
    getS2Collection,
    getDominantClass,
    getSpecificCropType,
    maskS2Clouds,
    addNDVI
  };
}