# Agri-Lend Geospatial Telemetry API

A Firebase Cloud Functions API that exposes Google Earth Engine satellite data for agricultural monitoring in Ethiopia.

## Overview

This API provides:
- **Annual NDVI Peaks** — Historical vegetation index by year
- **Environment Data** — Rainfall, temperature, climate baselines
- **Land Security** — Soil metrics, terrain, erosion risk
- **NDVI Timeline** — Weekly vegetation indices + crop type detection

## Quick Start

### Prerequisites
- Node.js 18+
- Firebase CLI
- Google Cloud SDK
- Google Earth Engine account

### Installation

```bash
git clone https://github.com/your-org/agri-lend-api.git
cd agri-lend-api\Functions
npm install
```

### Setup

See [SETUP.md](./Docs/SETUP.md) for detailed instructions.

### Local Development

```bash
firebase emulators:start --only functions
```

API will be available at: `http://localhost:5001/PROJECT_ID/us-central1/agriLendAPI`

### Deployment

```bash
firebase deploy --only functions
```

## API Documentation

See [API_DOCUMENTATION.md](./Docs/API_DOCUMENTATION.md) for endpoints and usage examples.

## Repository Structure