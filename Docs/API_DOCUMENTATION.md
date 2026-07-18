# Agri-Lend Geospatial Telemetry API Documentation

**Version:** 1.0.0  
**Last Updated:** July 2026  
**Status:** Production Ready (pending GEE permissions)

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Base URL](#base-url)
4. [Endpoints](#endpoints)
5. [Request Format](#request-format)
6. [Response Format](#response-format)
7. [Error Handling](#error-handling)
8. [Rate Limiting](#rate-limiting)
9. [Code Examples](#code-examples)
10. [Troubleshooting](#troubleshooting)

---

## Overview

The Agri-Lend Geospatial Telemetry API provides satellite-based agricultural data for farm monitoring in Ethiopia. It processes Google Earth Engine data to deliver:

- **Annual NDVI Peaks** — Vegetation index trends by year
- **Environment Data** — Rainfall and temperature metrics
- **Land Security** — Soil composition and terrain analysis
- **NDVI Timeline** — Weekly vegetation indices with crop type detection

### Key Features

✅ **Real-time satellite processing** via Google Earth Engine  
✅ **Multiple data categories** for comprehensive farm assessment  
✅ **Fast response times** (~30-60 seconds per request)  
✅ **Easy integration** with REST API  
✅ **Flexible ROI input** for any geographic area  

---

## Authentication

Currently, the API does **not require authentication** for testing. In production, it will use API keys.

### Future: API Key Authentication

```bash
# Add this header to all requests
X-API-Key: your-api-key-here
```

---

## Base URL

**Local Development:**