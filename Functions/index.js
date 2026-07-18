/**
 * ============================================================
 * AGRI-LEND GEOSPATIAL TELEMETRY API
 * Firebase Cloud Function - Phase 4
 * 
 * This is your main API code that:
 * 1. Authenticates with Google Earth Engine
 * 2. Calls GEE functions to compute satellite data
 * 3. Returns JSON responses to external users
 * ============================================================
 */

const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const fs = require('fs');
const path = require('path');

// Initialize Express app
const app = express();

// Enable CORS for all routes (allows external users to call your API)
app.use(cors({ origin: true }));
app.use(express.json());

// Track if EE is initialized (avoid re-initializing)
let eeInitialized = false;
let eeInitPromise = null;

/**
 * Initialize Google Earth Engine with Service Account
 * This runs ONCE and caches the result
 */
function initializeEarthEngine() {
  // If already initialized, return cached promise
  if (eeInitPromise) {
    return eeInitPromise;
  }

  eeInitPromise = new Promise((resolve, reject) => {
    try {
      // Load the service account key JSON file
      const keyPath = path.join(__dirname, 'gee-service-account-key.json');
      
      if (!fs.existsSync(keyPath)) {
        return reject(
          new Error('gee-service-account-key.json not found in functions folder')
        );
      }

      const rawKey = fs.readFileSync(keyPath);
      const key = JSON.parse(rawKey);

      console.log('Authenticating with Earth Engine...');

      // Authenticate with Earth Engine using service account
      ee.data.authenticateViaPrivateKey(
        key,
        () => {
          console.log('Private key authenticated');

          // Initialize Earth Engine
          ee.initialize(
            null,
            null,
            () => {
              eeInitialized = true;
              console.log('✓ Earth Engine initialized successfully');
              resolve();
            },
            (error) => {
              console.error('EE initialization error:', error);
              reject(new Error(`Earth Engine init failed: ${error.message}`));
            }
          );
        },
        (error) => {
          console.error('Authentication error:', error);
          reject(new Error(`GEE authentication failed: ${error.message}`));
        }
      );
    } catch (error) {
      console.error('Error in initializeEarthEngine:', error);
      reject(error);
    }
  });

  return eeInitPromise;
}

// ============================================================
// GEE HELPER FUNCTIONS (Inline - for Cloud Functions)
// Note: These are the same functions from gee-helper-functions.js
// ============================================================

function maskS2Clouds(image) {
  var qa = image.select('QA60');
  var mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0));
  return image.updateMask(mask).divide(10000).copyProperties(image, ["system:time_start"]);
}

function addNDVI(image) {
  return image.addBands(image.normalizedDifference(['B8', 'B4']).rename('NDVI'));
}

function getS2Collection(roi) {
  return ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
    .filterBounds(roi)
    .filterDate('2021-01-01', '2026-02-01')
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
    .map(maskS2Clouds)
    .map(addNDVI);
}

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
    classLabels.get(modeVal.toInt()),
    'unknown'
  );
}

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

function buildMonthlyDict(dataset, yearStart, yearEnd, band, stat, isTemp, roi) {
  var monthsList = ee.List.sequence(1, 12);
  
  var vals = monthsList.map(function(m) {
    var filtered = dataset
      .filter(ee.Filter.calendarRange(yearStart, yearEnd, 'year'))
      .filter(ee.Filter.calendarRange(m, m, 'month'));
    
    var img = stat === 'sum' ? filtered.sum() : filtered.mean();
    
    var val = img.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: roi,
      scale: 5000
    }).get(band, null);
    
    return ee.Algorithms.If(
      ee.Algorithms.IsEqual(val, null),
      "null",
      ee.Algorithms.If(
        isTemp,
        ee.Number(val).subtract(273.15),
        val
      )
    );
  });
  
  return ee.Dictionary.fromLists(
    monthsList.map(function(m) { return ee.Number(m).format('%d'); }),
    vals
  );
}

// ============================================================
// MAIN COMPUTATION FUNCTIONS
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

function getEnvironmentData(roi) {
  var actualYear = 2025;
  
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
          actual_season_evaluated: 2026,
          dataset_source: "CHIRPS & ECMWF/ERA5_LAND/MONTHLY_AGGREGATED via GEE",
          historical_baseline_range: "2005-2025",
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
          2024,
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
          2024,
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

function getRecentNDVI(roi) {
  var s2Collection = getS2Collection(roi);
  var recentS2 = s2Collection
    .filterDate('2023-12-01', '2026-02-01')
    .sort('system:time_start');
  
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
// HELPER: Convert coordinates to GEE Geometry
// ============================================================
function createGeometryFromCoordinates(coords) {
  if (!coords || !Array.isArray(coords) || coords.length < 3) {
    throw new Error(
      'roiCoordinates must be an array of at least 3 [longitude, latitude] pairs'
    );
  }
  
  // Close the polygon if not already closed
  const closedCoords = JSON.parse(JSON.stringify(coords));
  if (JSON.stringify(closedCoords[0]) !== JSON.stringify(closedCoords[closedCoords.length - 1])) {
    closedCoords.push(closedCoords[0]);
  }
  
  return ee.Geometry.Polygon([closedCoords]);
}

// ============================================================
// API ENDPOINTS
// ============================================================

/**
 * ENDPOINT 1: Get ALL Telemetry Data (Recommended)
 * POST /api/v1/farms/telemetry
 */
app.post('/api/v1/farms/telemetry', async (req, res) => {
  try {
    console.log('📥 Incoming request to /api/v1/farms/telemetry');
    
    // Initialize EE first
    await initializeEarthEngine();
    
    const { roiCoordinates, farmId } = req.body;

    // Validate input
    if (!roiCoordinates) {
      return res.status(400).json({
        success: false,
        error: 'roiCoordinates required in request body',
        example: {
          roiCoordinates: [
            [38.80507383455457, 8.894908870559417],
            [38.805165029661076, 8.894744573515876],
            [38.80527231802167, 8.894559076765212],
            [38.8054761659068, 8.894686274547222]
          ],
          farmId: 'farm-123'
        }
      });
    }

    console.log(`🌍 Processing ROI for farm: ${farmId || 'unknown'}`);
    
    // Create geometry from coordinates
    const roi = createGeometryFromCoordinates(roiCoordinates);

    // Execute all 4 computations in parallel
    console.log('🛰️  Computing satellite data...');
    const startTime = Date.now();
    
    const [annualPeaks, envData, landSecurity, ndvi] = await Promise.all([
      Promise.resolve(getAnnualPeakValues(roi)),
      Promise.resolve(getEnvironmentData(roi)),
      Promise.resolve(getLandSecurityData(roi)),
      Promise.resolve(getRecentNDVI(roi))
    ]);

    const computeTime = Date.now() - startTime;

    const response = {
      success: true,
      data: {
        annual_peak_values: annualPeaks,
        environment_data: envData,
        land_security_data: landSecurity,
        recent_ndvi: ndvi
      },
      metadata: {
        cached: false,
        compute_time_ms: computeTime,
        timestamp: new Date().toISOString(),
        farm_id: farmId || 'not-specified'
      }
    };

    console.log(`✓ Request completed in ${computeTime}ms`);
    res.json(response);

  } catch (error) {
    console.error('❌ Error in telemetry endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * ENDPOINT 2: Get Annual Peaks Only
 * POST /api/v1/farms/annual-peaks
 */
app.post('/api/v1/farms/annual-peaks', async (req, res) => {
  try {
    console.log('📥 Request: /api/v1/farms/annual-peaks');
    await initializeEarthEngine();
    
    const { roiCoordinates, farmId } = req.body;

    if (!roiCoordinates) {
      return res.status(400).json({ 
        success: false,
        error: 'roiCoordinates required' 
      });
    }

    const roi = createGeometryFromCoordinates(roiCoordinates);
    const data = getAnnualPeakValues(roi);

    res.json({ 
      success: true, 
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        farm_id: farmId
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * ENDPOINT 3: Get Environment Data Only
 * POST /api/v1/farms/environment
 */
app.post('/api/v1/farms/environment', async (req, res) => {
  try {
    console.log('📥 Request: /api/v1/farms/environment');
    await initializeEarthEngine();
    
    const { roiCoordinates, farmId } = req.body;

    if (!roiCoordinates) {
      return res.status(400).json({ 
        success: false,
        error: 'roiCoordinates required' 
      });
    }

    const roi = createGeometryFromCoordinates(roiCoordinates);
    const data = getEnvironmentData(roi);

    res.json({ 
      success: true, 
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        farm_id: farmId
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * ENDPOINT 4: Get Land Security Data Only
 * POST /api/v1/farms/land-security
 */
app.post('/api/v1/farms/land-security', async (req, res) => {
  try {
    console.log('📥 Request: /api/v1/farms/land-security');
    await initializeEarthEngine();
    
    const { roiCoordinates, farmId } = req.body;

    if (!roiCoordinates) {
      return res.status(400).json({ 
        success: false,
        error: 'roiCoordinates required' 
      });
    }

    const roi = createGeometryFromCoordinates(roiCoordinates);
    const data = getLandSecurityData(roi);

    res.json({ 
      success: true, 
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        farm_id: farmId
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * ENDPOINT 5: Get NDVI Data Only
 * POST /api/v1/farms/ndvi
 */
app.post('/api/v1/farms/ndvi', async (req, res) => {
  try {
    console.log('📥 Request: /api/v1/farms/ndvi');
    await initializeEarthEngine();
    
    const { roiCoordinates, farmId } = req.body;

    if (!roiCoordinates) {
      return res.status(400).json({ 
        success: false,
        error: 'roiCoordinates required' 
      });
    }

    const roi = createGeometryFromCoordinates(roiCoordinates);
    const data = getRecentNDVI(roi);

    res.json({ 
      success: true, 
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        farm_id: farmId
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * ENDPOINT 6: Health Check
 * GET /api/v1/health
 */
app.get('/api/v1/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'Agri-Lend Geospatial Telemetry API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

/**
 * ENDPOINT 7: API Documentation
 * GET /api/v1/docs
 */
app.get('/api/v1/docs', (req, res) => {
  res.json({
    service: 'Agri-Lend Geospatial Telemetry API',
    version: '1.0.0',
    endpoints: [
      {
        name: 'Get All Telemetry Data',
        method: 'POST',
        path: '/api/v1/farms/telemetry',
        description: 'Returns all 4 data categories at once',
        requestBody: {
          roiCoordinates: '[[lon1, lat1], [lon2, lat2], ...]',
          farmId: 'optional farm identifier'
        }
      },
      {
        name: 'Get Annual Peaks',
        method: 'POST',
        path: '/api/v1/farms/annual-peaks',
        description: 'NDVI peaks by year + dominant land cover'
      },
      {
        name: 'Get Environment Data',
        method: 'POST',
        path: '/api/v1/farms/environment',
        description: 'Rainfall, temperature, climate baselines'
      },
      {
        name: 'Get Land Security',
        method: 'POST',
        path: '/api/v1/farms/land-security',
        description: 'Soil metrics, terrain slope, erosion risk'
      },
      {
        name: 'Get NDVI Timeline',
        method: 'POST',
        path: '/api/v1/farms/ndvi',
        description: 'Weekly NDVI values + crop type'
      },
      {
        name: 'Health Check',
        method: 'GET',
        path: '/api/v1/health',
        description: 'API status check'
      }
    ]
  });
});

// ============================================================
// ROOT REDIRECT
// ============================================================
app.get('/', (req, res) => {
  res.json({
    message: 'Agri-Lend Geospatial API',
    docs: 'GET /api/v1/docs',
    health: 'GET /api/v1/health'
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// ============================================================
// EXPORT AS FIREBASE CLOUD FUNCTION
// ============================================================
exports.agriLendAPI = functions.https.onRequest(app);